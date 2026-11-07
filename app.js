// Browser wiring for the MTG solo pack opener.
// All pack math lives in logic.js; this file only fetches from Scryfall,
// caches the pool for 24 hours, renders the pool, and handles exports.
import {
  addBasicLand,
  aggregatePool,
  boardCounts,
  boardDecklist,
  boardIsActive,
  boardMainCards,
  boardStatus,
  buildLandPackCards,
  buildPacks,
  buildTTSSavedObject,
  cardColors,
  cardImage,
  cardManaCost,
  cardOracleText,
  cardPrice,
  cardTypeLine,
  collectTokenIds,
  colorBreakdown,
  createBoard,
  decodeShare,
  deserializeBoard,
  encodeShare,
  filterDraftableSets,
  filterPool,
  flattenPacks,
  formatCSV,
  formatDecklist,
  formatDecklistDetailed,
  groupPoolByColor,
  hashSeed,
  isBasicLand,
  manaCurve,
  moveAll,
  moveCard,
  mulberry32,
  parse17LandsRatings,
  partitionPool,
  poolCounts,
  ratingFor,
  ratingGrade,
  resetBoard,
  serializeBoard,
  sortBoard,
  sortPool,
  TTS_CARD_BACK_URL,
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
let rawCards = [];
let tokenCards = [];
let tokenCacheCode = "";
let board = null;
let boardMeta = null;
let selectedBoardCard = null;
let ratings = { byName: {}, total: 0, withData: 0, available: false };
let ratingsNote = "";
let revealPackIndex = 0;
let revealedCards = new Set();
let justMovedIds = new Set();

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

// Fetch the tokens cards in this pool can create, via POST
// /cards/collection in batches of 70 (limit 75), 550ms apart, the
// batched pattern Omes' TTS importer uses. Cached 24 hours per set.
// A failure here is not fatal: the TTS export still works without tokens.
async function fetchTokens(code) {
  if (tokenCacheCode === code.toLowerCase()) return tokenCards;
  const ids = collectTokenIds(rawCards);
  tokenCards = [];
  tokenCacheCode = code.toLowerCase();
  if (ids.length === 0) return tokenCards;
  const cacheKeyTokens = `mtg-draft-tokens-v1:${code.toLowerCase()}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKeyTokens) || "null");
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      tokenCards = cached.cards || [];
      return tokenCards;
    }
  } catch {
    // Fall through to a live fetch.
  }
  const fetched = [];
  for (let i = 0; i < ids.length; i += 70) {
    if (i > 0) await sleep(550);
    const response = await fetch(`${API}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: ids.slice(i, i + 70).map((id) => ({ id })) }),
    });
    if (response.status === 429) throw new Error("Scryfall is rate-limiting this browser right now. Wait 30 seconds and try again.");
    if (!response.ok) throw new Error(`Scryfall returned ${response.status} for tokens.`);
    const data = await response.json();
    fetched.push(...(data.data || []));
  }
  tokenCards = fetched;
  try {
    localStorage.setItem(cacheKeyTokens, JSON.stringify({ fetchedAt: Date.now(), cards: fetched }));
  } catch {
    // A full quota must not break the export.
  }
  return tokenCards;
}

// --- Deck-builder board -------------------------------------------
// The board is saved as indices into the flat pool, keyed by set, pack
// count, and seed, so reopening the same packs restores it.
function boardKey() {
  if (!boardMeta) return null;
  return `mtg-draft-board-v1:${boardMeta.set}:${boardMeta.packs}:${boardMeta.seed}`;
}

function saveBoard() {
  if (!board || !boardKey()) return;
  try {
    localStorage.setItem(boardKey(), JSON.stringify({
      set: boardMeta.set,
      packs: boardMeta.packs,
      seed: boardMeta.seed,
      board: serializeBoard(board, flatPool),
    }));
  } catch {
    // A full quota must not break building.
  }
}

function loadBoard() {
  if (!boardKey()) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(boardKey()) || "null");
    if (!saved || saved.set !== boardMeta.set || saved.packs !== boardMeta.packs || saved.seed !== boardMeta.seed) return null;
    const restored = deserializeBoard(saved.board, flatPool);
    if (!restored) return null;
    const total = restored.pool.length + restored.main.length + restored.sideboard.length + restored.maybe.length;
    if (total !== flatPool.length) return null;
    return restored;
  } catch {
    return null;
  }
}

function landCardsByName() {
  const map = {};
  for (const card of buckets?.basicLand || []) map[card.name] = card;
  for (const card of flatPool) {
    if (isBasicLand(card) && !map[card.name]) map[card.name] = card;
  }
  return map;
}

function boardTarget() {
  return Math.min(100, Math.max(20, Number.parseInt($("board-target").value, 10) || 40));
}

function renderBoard() {
  if (!board) return;
  $("board-section").hidden = false;
  const counts = boardCounts(board);
  const status = boardStatus(board, boardTarget());
  $("board-status").textContent =
    `Main Deck ${counts.mainTotal} / ${status.target} — ${status.message}. ` +
    `Pool ${counts.pool}, Sideboard ${counts.sideboard}, Maybeboard ${counts.maybe}, added lands ${counts.lands}.`;
  for (const zone of ["pool", "main", "sideboard", "maybe"]) {
    $(`board-count-${zone}`).textContent = `(${board[zone].length})`;
    const container = $(`board-${zone}`);
    container.innerHTML = "";
    board[zone].forEach((card, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `board-card${justMovedIds.has(card.id) ? " just-moved" : ""}`;
      button.draggable = true;
      button.dataset.zone = zone;
      button.dataset.index = String(index);
      const image = cardImage(card, "normal");
      button.innerHTML =
        (image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}" loading="lazy">` : "") +
        `<span class="name">${escapeHtml(card.name)}</span>` +
        `<span class="meta">${escapeHtml(cardTypeLine(card))} — ${escapeHtml(card.rarity)} — ${card.cmc ?? "?"} mana</span>`;
      button.addEventListener("click", () => showCard(card));
      button.addEventListener("dragstart", (event) => {
        button.classList.add("dragging");
        event.dataTransfer.setData("text/plain", JSON.stringify({ zone, index }));
        event.dataTransfer.effectAllowed = "move";
      });
      button.addEventListener("dragend", () => button.classList.remove("dragging"));
      container.append(button);
    });
  }
  justMovedIds = new Set();
  for (const name of ["Plains", "Island", "Swamp", "Mountain", "Forest"]) {
    $(`land-count-${name}`).textContent = String(board.lands[name] || 0);
  }
  const curve = manaCurve(board.main);
  const max = Math.max(1, ...curve.map((b) => b.count));
  $("board-curve").innerHTML = curve.map((b) => (
    `<div class="curve-bar"><div class="bar" style="height:${Math.max(b.count ? 4 : 2, Math.round((b.count / max) * 48))}px"></div>` +
    `<div>${b.cmc}</div><div>${b.count}</div></div>`
  )).join("");
  const colors = colorBreakdown(board.main);
  const nonLand = board.main.filter((c) => !isBasicLand(c)).length;
  $("board-colors").textContent =
    `Main deck colors (non-land, ${nonLand} cards): ` +
    `W ${colors.W}, U ${colors.U}, B ${colors.B}, R ${colors.R}, G ${colors.G}, colorless ${colors.C}, multicolor ${colors.M}.`;
}

function moveBoardCard(fromZone, index, toZone) {
  if (!board) return;
  const card = board[fromZone]?.[index];
  const next = moveCard(board, fromZone, toZone, index);
  if (next === board) return;
  if (card) justMovedIds = new Set([card.id]);
  board = next;
  saveBoard();
  renderBoard();
}

function findBoardLocation(card) {
  if (!board) return null;
  for (const zone of ["pool", "main", "sideboard", "maybe"]) {
    const index = board[zone].indexOf(card);
    if (index >= 0) return { zone, index };
  }
  return null;
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
  $("set-info").innerHTML = currentSet
    ? `${currentSet.icon_svg_uri ? `<img src="${escapeHtml(currentSet.icon_svg_uri)}" alt="" style="width:20px;height:20px;vertical-align:-4px"> ` : ""}${escapeHtml(currentSet.name)} (${escapeHtml(currentSet.code.toUpperCase())}) - released ${escapeHtml(currentSet.released_at || "unknown")}, ${escapeHtml(currentSet.card_count || "?")} cards in the set.`
    : "";
}

async function fetchRatings(code) {
  const key = `mtg-draft-17lands-v1:${code.toLowerCase()}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      ratings = cached.ratings;
      ratingsNote = ratings.available
        ? `17Lands Premier Draft: ${ratings.withData} cards with ratings (GIH WR).`
        : "17Lands: no ratings for this set — only the current draft format has live data.";
      updateRatingsNote();
      return;
    }
  } catch { /* fall through to a live fetch */ }
  ratingsNote = "17Lands: loading ratings…";
  updateRatingsNote();
  try {
    const released = currentSet?.released_at || "";
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://www.17lands.com/card_ratings/data?expansion=${code.toUpperCase()}&event_type=PremierDraft&start_date=${released}&end_date=${today}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`17Lands returned ${response.status}`);
    const parsed = parse17LandsRatings(await response.json());
    ratings = parsed;
    ratingsNote = parsed.available
      ? `17Lands Premier Draft: ${parsed.withData} cards with ratings (GIH WR).`
      : "17Lands: no ratings for this set — only the current draft format has live data.";
    try { localStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), ratings: parsed })); } catch { /* ignore */ }
  } catch {
    ratings = { byName: {}, total: 0, withData: 0, available: false };
    ratingsNote = "17Lands: ratings could not be loaded — sorting by rating is unavailable.";
  }
  updateRatingsNote();
  renderPool();
  renderBoard();
}

function updateRatingsNote() {
  const el = $("ratings-status");
  if (el) el.textContent = ratingsNote;
}

function ratingBadge(card) {
  const rating = ratingFor(card, ratings);
  if (!rating || rating.gih === null || rating.gih === undefined) return "";
  const grade = ratingGrade(rating.gih);
  return ` <span class="badge rating" title="17Lands games-in-hand win rate, ${rating.games} games">17L ${grade} ${(rating.gih * 100).toFixed(1)}%</span>`;
}

// Pack reveal: one pack at a time, cards face-down, rare last.
function revealOrder(pack) {
  return [...pack].reverse();
}

function renderReveal() {
  const section = $("pack-reveal");
  section.hidden = false;
  const pack = packs[revealPackIndex] || [];
  const order = revealOrder(pack);
  const revealedCount = order.filter((card) => revealedCards.has(card.id)).length;
  $("reveal-progress").textContent =
    `Pack ${revealPackIndex + 1} of ${packs.length} — ${revealedCount} of ${order.length} revealed` +
    (revealPackIndex + 1 === packs.length ? " — last pack" : "");
  $("reveal-next-pack").textContent = revealPackIndex + 1 === packs.length ? "Show pool" : "Next pack";
  const grid = $("reveal-grid");
  grid.innerHTML = "";
  order.forEach((card, index) => {
    const flipped = revealedCards.has(card.id);
    const button = document.createElement("button");
    button.type = "button";
    // True 3D flip: back face is the card back, front face is the card.
    // deal-in staggers each card in; rare/mythic cards glow when flipped.
    const isRare = card.rarity === "rare" || card.rarity === "mythic";
    button.className = `pool-card reveal-card dealt${flipped ? " flipped" : ""}${card.foil ? " foil" : ""}${flipped && isRare ? " rare-glow" : ""}`;
    button.style.animationDelay = `${index * 80}ms`;
    const image = cardImage(card, "normal");
    button.innerHTML =
      `<span class="flip-inner">` +
      `<span class="flip-face flip-back"><img src="${escapeHtml(TTS_CARD_BACK_URL)}" alt="Face-down card" loading="lazy"></span>` +
      `<span class="flip-face flip-front">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}" loading="lazy">` : `<span>No image available</span>`}</span>` +
      `</span>` +
      `<span class="name">${flipped ? escapeHtml(card.name) : "???"}</span>` +
      (flipped ? ` <span class="badge ${escapeHtml(card.rarity)}">${escapeHtml(card.rarity)}</span>${card.foil ? ` <span class="badge foil">Foil</span>` : ""}` : "");
    button.addEventListener("click", () => {
      revealedCards.add(card.id);
      renderReveal();
    });
    grid.append(button);
  });
}

function revealNextCard() {
  const order = revealOrder(packs[revealPackIndex] || []);
  const next = order.find((card) => !revealedCards.has(card.id));
  if (next) {
    revealedCards.add(next.id);
    renderReveal();
    return true;
  }
  return false;
}

function nextPack() {
  if (revealPackIndex + 1 < packs.length) {
    revealPackIndex += 1;
    revealedCards = new Set();
    renderReveal();
  } else {
    finishReveal();
  }
}

function finishReveal() {
  $("pack-reveal").hidden = true;
  $("results").hidden = flatPool.length === 0;
  $("board-section").hidden = flatPool.length === 0;
  renderPool();
  renderBoard();
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
  return sortPool(filterPool(flatPool, filters), $("sort-select").value, ratings);
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

  const curve = manaCurve(flatPool.filter((card) => !isBasicLand(card)));
  $("pool-curve").innerHTML = Object.entries(curve)
    .map(([bucket, count]) => `<span class="curve-bar"><span class="curve-label">${escapeHtml(bucket)}</span><span class="curve-count">${count}</span></span>`)
    .join("");
  const poolColors = colorBreakdown(flatPool.filter((card) => !isBasicLand(card)));
  $("pool-colors").textContent = `Pool colors — ${Object.entries(poolColors).map(([color, count]) => `${color} ${count}`).join(", ")}.`;
  updateRatingsNote();

  const container = $("pool-grid");
  container.innerHTML = "";
  container.className = $("view-select").value === "list" ? "pool-list" : "grid";
  const makeCardButton = (card, index = 0) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pool-card anim-in${card.foil ? " foil" : ""}`;
    button.style.animationDelay = `${(index % 15) * 30}ms`;
    button.dataset.cardId = card.id;
    if ($("view-select").value === "list") {
      button.innerHTML =
        `<span><strong>${escapeHtml(card.name)}</strong> <span class="muted">${escapeHtml(cardTypeLine(card))}</span></span>` +
        `<span class="muted">Pack ${card.packIndex} - ${escapeHtml(card.rarity)}${cardPrice(card) !== null ? ` - $${cardPrice(card).toFixed(2)}` : ""}${ratingBadge(card)}</span>`;
    } else {
      const image = cardImage(card, "normal");
      button.innerHTML =
        `<figure style="margin:0">` +
        (image
          ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}" loading="lazy">`
          : `<div>No image available</div>`) +
        `<figcaption><span class="name">${escapeHtml(card.name)}</span>` +
        `<span class="meta">Pack ${card.packIndex} - ${escapeHtml(cardTypeLine(card))}</span> ` +
        `<span class="badge ${escapeHtml(card.rarity)}">${escapeHtml(card.rarity)}</span>${card.foil ? ` <span class="badge foil">Foil</span>` : ""}${ratingBadge(card)}</figcaption></figure>`;
    }
    button.addEventListener("click", () => showCard(card));
    return button;
  };

  if ($("view-select").value === "groups") {
    let index = 0;
    for (const group of groupPoolByColor(visible)) {
      const heading = document.createElement("h3");
      heading.className = "group-heading";
      heading.textContent = `${group.label} (${group.cards.length})`;
      container.append(heading);
      for (const card of group.cards) container.append(makeCardButton(card, index++));
    }
    return;
  }
  visible.forEach((card, index) => container.append(makeCardButton(card, index)));
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
    (price !== null ? ` - $${price.toFixed(2)}` : "") +
    (() => {
      const rating = ratingFor(card, ratings);
      return rating && rating.gih !== null
        ? ` - 17Lands ${ratingGrade(rating.gih)} ${(rating.gih * 100).toFixed(1)}% GIH WR (${rating.games} games${rating.alsa !== null ? `, ALSA ${rating.alsa.toFixed(1)}` : ""})`
        : "";
    })() + `</p>` +
    `<p><a href="${escapeHtml(card.scryfall_uri || `https://scryfall.com/card/${card.set}/${card.collector_number}`)}" target="_blank" rel="noreferrer">View on Scryfall</a></p>`;
  selectedBoardCard = findBoardLocation(card);
  $("card-move").hidden = !selectedBoardCard;
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
    rawCards = cards;
    tokenCards = [];
    tokenCacheCode = "";
    buckets = partitionPool(cards);
    packs = buildPacks(buckets, packCount, currentRng());
    flatPool = flattenPacks(packs);
    boardMeta = { set: code.toLowerCase(), packs: packCount, seed: $("seed").value.trim() };
    board = loadBoard() || createBoard(flatPool);
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
    revealPackIndex = 0;
    revealedCards = new Set();
    $("results").hidden = true;
    $("board-section").hidden = true;
    renderReveal();
    fetchRatings(code);
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
$("reveal-all").addEventListener("click", () => {
  for (const card of revealOrder(packs[revealPackIndex] || [])) revealedCards.add(card.id);
  renderReveal();
});
$("reveal-next-pack").addEventListener("click", nextPack);
$("reveal-skip").addEventListener("click", finishReveal);
document.addEventListener("keydown", (event) => {
  if ($("pack-reveal").hidden) return;
  if ($("card-dialog").open) return;
  if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "SELECT" || event.target.tagName === "TEXTAREA")) return;
  if (event.code === "Space" || event.code === "Enter") {
    event.preventDefault();
    revealNextCard();
  } else if (event.key === "n" || event.key === "N") {
    nextPack();
  } else if (event.key === "a" || event.key === "A") {
    for (const card of revealOrder(packs[revealPackIndex] || [])) revealedCards.add(card.id);
    renderReveal();
  }
});
$("clear-pool").addEventListener("click", () => {
  try {
    if (boardKey()) localStorage.removeItem(boardKey());
  } catch {
    // Ignore storage errors on clear.
  }
  packs = [];
  flatPool = [];
  buckets = null;
  rawCards = [];
  tokenCards = [];
  tokenCacheCode = "";
  board = null;
  boardMeta = null;
  ratings = { byName: {}, total: 0, withData: 0, available: false };
  ratingsNote = "";
  $("pack-reveal").hidden = true;
  $("board-section").hidden = true;
  renderPool();
  setStatus("Pool cleared.");
});
$("board-target").addEventListener("change", renderBoard);
$("board-sort").addEventListener("change", () => {
  if (!board) return;
  board = sortBoard(board, $("board-sort").value);
  saveBoard();
  renderBoard();
});
$("board-reset").addEventListener("click", () => {
  if (!board) return;
  board = resetBoard(board);
  saveBoard();
  renderBoard();
  setStatus("Board reset: all cards back in the pool, added lands cleared.");
});
$("bulk-creatures").addEventListener("click", () => {
  if (!board) return;
  const moving = board.pool.filter((card) => cardTypeLine(card).includes("Creature"));
  const next = moveAll(board, "pool", "main", (card) => cardTypeLine(card).includes("Creature"));
  if (next === board) {
    setStatus("No creatures left in the pool.");
    return;
  }
  justMovedIds = new Set(moving.map((card) => card.id));
  board = next;
  saveBoard();
  renderBoard();
  setStatus("All pool creatures moved to Main Deck.");
});
$("bulk-color-add").addEventListener("click", () => {
  if (!board) return;
  const color = $("bulk-color").value;
  const moving = board.pool.filter((card) => cardColors(card).includes(color));
  const next = moveAll(board, "pool", "main", (card) => cardColors(card).includes(color));
  if (next === board) {
    setStatus(`No ${color} cards left in the pool.`);
    return;
  }
  justMovedIds = new Set(moving.map((card) => card.id));
  board = next;
  saveBoard();
  renderBoard();
  setStatus(`All ${color} pool cards moved to Main Deck.`);
});
document.querySelectorAll(".land-btn").forEach((button) => {
  button.addEventListener("click", () => {
    if (!board) return;
    board = addBasicLand(board, button.dataset.land, Number.parseInt(button.dataset.delta, 10) || 0);
    saveBoard();
    renderBoard();
  });
});
document.querySelectorAll(".board-zone").forEach((zoneEl) => {
  zoneEl.addEventListener("dragover", (event) => {
    event.preventDefault();
    zoneEl.classList.add("drag-over");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("drag-over"));
  zoneEl.addEventListener("drop", (event) => {
    event.preventDefault();
    zoneEl.classList.remove("drag-over");
    try {
      const { zone, index } = JSON.parse(event.dataTransfer.getData("text/plain"));
      moveBoardCard(zone, index, zoneEl.dataset.zone);
    } catch {
      // A drop without our card payload is ignored.
    }
  });
});
document.querySelectorAll(".move-btn").forEach((button) => {
  button.addEventListener("click", () => {
    if (!selectedBoardCard) return;
    const { zone, index } = selectedBoardCard;
    selectedBoardCard = null;
    $("card-dialog").close();
    moveBoardCard(zone, index, button.dataset.moveZone);
  });
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
// Once the board has any main/sideboard cards or added lands, exports
// describe the deck being built, not the whole pool. Otherwise they
// keep exporting the pool exactly as before.
function boardExportCards() {
  if (!board || !boardIsActive(board)) return null;
  return [...boardMainCards(board, landCardsByName()), ...board.sideboard];
}

$("copy-decklist").addEventListener("click", async () => {
  if (board && boardIsActive(board)) {
    await copyText(boardDecklist(board, landCardsByName()), "Board decklist copied (Main Deck, then Sideboard).");
    return;
  }
  await copyText(formatDecklist(aggregatePool(visiblePool())), "Decklist copied.");
});
$("download-txt").addEventListener("click", () => {
  if (board && boardIsActive(board)) {
    download("mtg-deck.txt", boardDecklist(board, landCardsByName()), "text/plain");
    return;
  }
  download("mtg-pool.txt", formatDecklistDetailed(aggregatePool(flatPool)), "text/plain");
});
$("download-csv").addEventListener("click", () => {
  const deckCards = boardExportCards();
  if (deckCards) {
    download("mtg-deck.csv", formatCSV(aggregatePool(deckCards)), "text/csv");
    return;
  }
  download("mtg-pool.csv", formatCSV(aggregatePool(flatPool)), "text/csv");
});
$("download-json").addEventListener("click", () => {
  const deckCards = boardExportCards();
  if (deckCards) {
    download("mtg-deck.json", JSON.stringify({
      set: currentSet,
      packs: packs.length,
      seed: $("seed").value.trim(),
      generatedAt: new Date().toISOString(),
      board: {
        main: board.main,
        sideboard: board.sideboard,
        maybe: board.maybe,
        pool: board.pool,
        lands: board.lands,
        mainTotal: boardCounts(board).mainTotal,
      },
      aggregated: aggregatePool(deckCards).map(({ card, count, packs: packList }) => ({ count, packs: packList, card })),
      cards: deckCards,
    }, null, 2), "application/json");
    return;
  }
  download("mtg-pool.json", JSON.stringify({
    set: currentSet,
    packs: packs.length,
    seed: $("seed").value.trim(),
    generatedAt: new Date().toISOString(),
    aggregated: aggregatePool(flatPool).map(({ card, count, packs: packList }) => ({ count, packs: packList, card })),
    cards: flatPool,
  }, null, 2), "application/json");
});
$("download-tts").addEventListener("click", async () => {
  if (flatPool.length === 0) {
    setStatus("Open packs first, then download the TTS file.");
    return;
  }
  const button = $("download-tts");
  button.disabled = true;
  try {
    setStatus("Fetching tokens for the TTS export\u2026");
    let tokens = [];
    try {
      tokens = await fetchTokens($("set-select").value);
    } catch (error) {
      setStatus(`Token fetch failed (${error.message}); exporting the pool without tokens.`);
      tokens = [];
    }
    const deckCards = boardExportCards();
    const lands = deckCards ? [] : (buckets ? buildLandPackCards(buckets) : []);
    const { savedObject, skipped, deckCount, cardCount } = buildTTSSavedObject({
      setName: currentSet ? currentSet.name : $("set-select").value.toUpperCase(),
      setCode: $("set-select").value,
      packs: packs.length,
      seed: $("seed").value.trim(),
      pool: deckCards || flatPool,
      tokens,
      lands,
      options: { proxy: $("tts-proxy").checked },
      poolLabel: deckCards ? "Main Deck" : "Pool",
    });
    const code = $("set-select").value.toLowerCase();
    download(`mtg-${deckCards ? "deck" : "pool"}-${code}-tts.json`, JSON.stringify(savedObject, null, 2), "application/json");
    setStatus(
      `TTS file downloaded: ${cardCount} cards in ${deckCount} deck${deckCount === 1 ? "" : "s"} ` +
      (deckCards ? `(Main Deck + Sideboard, including added lands)` : `(Pool, ${tokens.length > 0 ? "Tokens, " : ""}Basic Lands)`) +
      (skipped > 0 ? `; ${skipped} card${skipped === 1 ? "" : "s"} skipped (no image)` : "") +
      `. In TTS, copy it to Documents/My Games/Tabletop Simulator/Saves/Saved Objects, then Objects > Saved Objects in game. ` +
      `Face images are Scryfall${$("tts-proxy").checked ? " via wsrv.nl as JPEG" : " direct"}; if cards load blank in TTS, re-export with the image proxy on.`,
    );
  } finally {
    button.disabled = false;
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Offline install is a nice-to-have; the site works without it.
    });
  });
}

loadSets();
