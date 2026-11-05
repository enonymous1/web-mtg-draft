// Browser wiring for the MTG solo pack opener.
// All pack math lives in logic.js; this file only fetches from Scryfall,
// caches the pool for 24 hours, renders the pool, and handles exports.
import {
  aggregatePool,
  buildPacks,
  cardColors,
  cardImage,
  cardManaCost,
  cardOracleText,
  cardPrice,
  cardTypeLine,
  decodeShare,
  encodeShare,
  filterDraftableSets,
  filterPool,
  flattenPacks,
  formatCSV,
  formatDecklist,
  formatDecklistDetailed,
  hashSeed,
  mulberry32,
  partitionPool,
  poolCounts,
  sortPool,
} from "./logic.js";

const $ = (id) => document.getElementById(id);
const API = "https://api.scryfall.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sets = [];
let buckets = null;
let packs = [];
let flatPool = [];
let currentSet = null;

function setStatus(text) {
  $("status").textContent = text;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cacheKey(code) {
  return `mtg-draft-pool-v1:${code.toLowerCase()}`;
}

function readCache(code) {
  try {
    const raw = localStorage.getItem(cacheKey(code));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.cards || null;
  } catch {
    return null;
  }
}

function writeCache(code, cards) {
  try {
    localStorage.setItem(cacheKey(code), JSON.stringify({ fetchedAt: Date.now(), cards }));
  } catch {
    // Private mode or a full quota must not break opening packs.
  }
}

async function fetchAllPages(firstUrl, onProgress) {
  const cards = [];
  let url = firstUrl;
  let page = 0;
  while (url) {
    if (page > 0) await sleep(550); // Scryfall card endpoints: 2 requests/second.
    const response = await fetch(url);
    if (response.status === 429) {
      throw new Error("Scryfall is rate-limiting this browser right now. Wait 30 seconds and try again.");
    }
    if (!response.ok) throw new Error(`Scryfall returned ${response.status}. Try another set.`);
    const data = await response.json();
    page += 1;
    onProgress(page, data.total_cards || null);
    cards.push(...(data.data || []));
    url = data.has_more ? data.next_page : null;
  }
  return cards;
}

async function loadSets() {
  try {
    const response = await fetch(`${API}/sets`);
    if (!response.ok) throw new Error(`Scryfall returned ${response.status}.`);
    const data = await response.json();
    sets = filterDraftableSets(data.data || []);
    renderSetOptions("");
    const shared = decodeShare(window.location.hash);
    if (shared.set) {
      const found = sets.find((s) => s.code.toLowerCase() === shared.set.toLowerCase());
      if (found) {
        $("set-select").value = found.code;
        updateSetInfo();
      }
    }
    if (shared.packs) $("pack-count").value = Math.min(36, Math.max(1, shared.packs));
    if (shared.seed) $("seed").value = shared.seed;
    setStatus(sets.length ? "" : "No draftable sets were returned. Reload the page to try again.");
  } catch (error) {
    $("set-select").innerHTML = `<option value="">Could not load sets</option>`;
    setStatus(`Could not load sets: ${error.message}`);
  }
}

function renderSetOptions(filterText) {
  const query = (filterText || "").trim().toLowerCase();
  const filtered = query
    ? sets.filter((s) => `${s.name} ${s.code}`.toLowerCase().includes(query))
    : sets;
  const select = $("set-select");
  const previous = select.value;
  select.innerHTML = "";
  if (filtered.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No sets match that search";
    select.append(option);
    return;
  }
  for (const set of filtered) {
    const option = document.createElement("option");
    option.value = set.code;
    option.textContent = `${set.name} (${set.code.toUpperCase()})`;
    select.append(option);
  }
  if (previous && filtered.some((s) => s.code === previous)) select.value = previous;
  updateSetInfo();
}

function updateSetInfo() {
  const code = $("set-select").value;
  currentSet = sets.find((s) => s.code === code) || null;
  $("set-info").textContent = currentSet
    ? `${currentSet.name} (${currentSet.code.toUpperCase()}) - released ${currentSet.released_at || "unknown"}, ${currentSet.card_count || "?"} cards in the set.`
    : "";
}

function currentRng() {
  const seed = $("seed").value.trim();
  if (!seed) return Math.random;
  return mulberry32(hashSeed(seed));
}

function visiblePool() {
  const filters = {
    query: $("filter-query").value,
    rarity: $("filter-rarity").value,
    color: $("filter-color").value,
    type: $("filter-type").value,
  };
  return sortPool(filterPool(flatPool, filters), $("sort-select").value);
}

function renderPool() {
  const visible = visiblePool();
  const section = $("results");
  section.hidden = flatPool.length === 0;
  $("empty-note").hidden = visible.length > 0 || flatPool.length === 0;

  const totalPrice = flatPool.reduce((sum, card) => sum + (cardPrice(card) || 0), 0);
  const counts = {};
  for (const card of flatPool) counts[card.rarity] = (counts[card.rarity] || 0) + 1;
  $("pool-stats").textContent =
    `${flatPool.length} cards from ${packs.length} pack${packs.length === 1 ? "" : "s"} ` +
    `(mythic ${counts.mythic || 0}, rare ${counts.rare || 0}, uncommon ${counts.uncommon || 0}, common ${counts.common || 0}) ` +
    `- pool value about $${totalPrice.toFixed(2)} (Scryfall USD, where listed).`;

  const container = $("pool-grid");
  container.innerHTML = "";
  container.className = $("view-select").value === "list" ? "pool-list" : "grid";

  for (const card of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pool-card";
    button.dataset.cardId = card.id;
    if ($("view-select").value === "list") {
      button.innerHTML =
        `<span><strong>${escapeHtml(card.name)}</strong> <span class="muted">${escapeHtml(cardTypeLine(card))}</span></span>` +
        `<span class="muted">Pack ${card.packIndex} - ${escapeHtml(card.rarity)}${cardPrice(card) !== null ? ` - $${cardPrice(card).toFixed(2)}` : ""}</span>`;
    } else {
      const image = cardImage(card, "normal");
      button.innerHTML =
        `<figure style="margin:0">` +
        (image
          ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}" loading="lazy">`
          : `<div>No image available</div>`) +
        `<figcaption><span class="name">${escapeHtml(card.name)}</span>` +
        `<span class="meta">Pack ${card.packIndex} - ${escapeHtml(cardTypeLine(card))}</span> ` +
        `<span class="badge ${escapeHtml(card.rarity)}">${escapeHtml(card.rarity)}</span></figcaption></figure>`;
    }
    button.addEventListener("click", () => showCard(card));
    container.append(button);
  }
}

function showCard(card) {
  const image = cardImage(card, "large");
  const price = cardPrice(card);
  $("card-detail").innerHTML =
    (image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}">` : "") +
    `<h3>${escapeHtml(card.name)} ${escapeHtml(cardManaCost(card))}</h3>` +
    `<p>${escapeHtml(cardTypeLine(card))} - ${escapeHtml(card.rarity)} - ${escapeHtml(card.set.toUpperCase())} ${escapeHtml(card.collector_number)}</p>` +
    `<pre>${escapeHtml(cardOracleText(card))}</pre>` +
    `<p>Colors: ${escapeHtml(cardColors(card).join(", ") || "Colorless")} - Mana value: ${escapeHtml(card.cmc ?? "?")}` +
    (price !== null ? ` - $${price.toFixed(2)}` : "") + `</p>` +
    `<p><a href="${escapeHtml(card.scryfall_uri || `https://scryfall.com/card/${card.set}/${card.collector_number}`)}" target="_blank" rel="noreferrer">View on Scryfall</a></p>`;
  $("card-dialog").showModal();
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, doneMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(doneMessage);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    setStatus(doneMessage);
  }
}

async function openPacks() {
  const code = $("set-select").value;
  if (!code) {
    setStatus("Choose a set first.");
    return;
  }
  const packCount = Math.min(36, Math.max(1, Number.parseInt($("pack-count").value, 10) || 3));
  $("pack-count").value = String(packCount);
  const button = $("open-packs");
  button.disabled = true;
  try {
    setStatus("Loading the set pool from Scryfall\u2026");
    const cached = readCache(code);
    let cards;
    let fromCache = false;
    if (cached) {
      cards = cached;
      fromCache = true;
    } else {
      const query = encodeURIComponent(`e:${code}`);
      cards = await fetchAllPages(
        `${API}/cards/search?q=${query}&unique=prints&order=set`,
        (page, total) => setStatus(`Loading the set pool from Scryfall\u2026 page ${page}${total ? ` of about ${Math.ceil(total / 175)}` : ""}.`),
      );
      writeCache(code, cards);
    }
    buckets = partitionPool(cards);
    packs = buildPacks(buckets, packCount, currentRng());
    flatPool = flattenPacks(packs);
    if (flatPool.length === 0) {
      setStatus("That set returned no draftable cards after filtering tokens and bonus sheets. Try another set.");
      return;
    }
    const counts = poolCounts(buckets);
    window.location.hash = encodeShare({ set: code, packs: packCount, seed: $("seed").value.trim() });
    setStatus(
      `Opened ${packCount} pack${packCount === 1 ? "" : "s"} from ${currentSet ? currentSet.name : code.toUpperCase()} ` +
      `(${fromCache ? "pool loaded from your 24-hour cache" : "pool fetched from Scryfall and cached for 24 hours"}; ` +
      `pool: ${counts.mythic} mythic, ${counts.rare} rare, ${counts.uncommon} uncommon, ${counts.common} common, ${counts.basicLand} basic lands).`,
    );
    renderPool();
  } catch (error) {
    setStatus(`Could not open packs: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

// --- Wiring ------------------------------------------------------------
$("set-search").addEventListener("input", (event) => renderSetOptions(event.target.value));
$("set-select").addEventListener("change", updateSetInfo);
document.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => {
    $("pack-count").value = button.dataset.packs;
  });
});
$("random-seed").addEventListener("click", () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  $("seed").value = `mtg-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
});
$("open-packs").addEventListener("click", openPacks);
$("clear-pool").addEventListener("click", () => {
  packs = [];
  flatPool = [];
  buckets = null;
  renderPool();
  setStatus("Pool cleared.");
});
$("share-link").addEventListener("click", async () => {
  const code = $("set-select").value;
  const hash = encodeShare({
    set: code,
    packs: Number.parseInt($("pack-count").value, 10) || 3,
    seed: $("seed").value.trim(),
  });
  await copyText(`${window.location.origin}${window.location.pathname}${hash}`, "Share link copied. Same set, packs, and seed deal the same packs.");
});
for (const id of ["filter-query", "filter-rarity", "filter-color", "filter-type", "sort-select", "view-select"]) {
  $(id).addEventListener("input", renderPool);
  $(id).addEventListener("change", renderPool);
}
$("copy-decklist").addEventListener("click", async () => {
  await copyText(formatDecklist(aggregatePool(visiblePool())), "Decklist copied.");
});
$("download-txt").addEventListener("click", () => {
  download("mtg-pool.txt", formatDecklistDetailed(aggregatePool(flatPool)), "text/plain");
});
$("download-csv").addEventListener("click", () => {
  download("mtg-pool.csv", formatCSV(aggregatePool(flatPool)), "text/csv");
});
$("download-json").addEventListener("click", () => {
  download("mtg-pool.json", JSON.stringify({
    set: currentSet,
    packs: packs.length,
    seed: $("seed").value.trim(),
    generatedAt: new Date().toISOString(),
    aggregated: aggregatePool(flatPool).map(({ card, count, packs: packList }) => ({ count, packs: packList, card })),
    cards: flatPool,
  }, null, 2), "application/json");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Offline install is a nice-to-have; the site works without it.
    });
  });
}

loadSets();
