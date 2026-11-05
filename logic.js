// Pure, DOM-free logic for the MTG solo pack opener.
// Kept separate from app.js so Node can test it without a browser.
// No network calls live here: app.js fetches from Scryfall, this file
// only shuffles, deals, sorts, filters, and formats what it is given.

// --- Seeded randomness -------------------------------------------------
// FNV-1a hash: turns any seed string into a stable 32-bit integer.
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (const ch of String(text)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// mulberry32: small, fast, deterministic PRNG. Same seed, same sequence.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates shuffle. Returns a new array, never mutates the input.
export function shuffle(items, rng = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Sample up to `count` items without replacement, skipping ids in `used`.
// If the bucket is smaller than count, returns the whole shuffled bucket.
export function takeFrom(bucket, count, used, rng = Math.random) {
  const available = shuffle(
    bucket.filter((card) => !used.has(card.id)),
    rng,
  );
  const taken = available.slice(0, count);
  for (const card of taken) used.add(card.id);
  return taken;
}

// --- Card field helpers ------------------------------------------------
// Scryfall puts image/text fields on the card for single-face cards and
// on card_faces[0] for double-face cards. These helpers hide that split.
export function cardTypeLine(card) {
  return card.type_line || card.card_faces?.[0]?.type_line || "";
}

export function cardImage(card, size = "normal") {
  if (card.image_uris?.[size]) return card.image_uris[size];
  const face = card.card_faces?.find((f) => f.image_uris?.[size]);
  return face ? face.image_uris[size] : "";
}

export function cardOracleText(card) {
  return card.oracle_text || card.card_faces?.map((f) => f.oracle_text || "").join("\n---\n") || "";
}

export function cardManaCost(card) {
  return card.mana_cost || card.card_faces?.[0]?.mana_cost || "";
}

export function cardColors(card) {
  return card.colors || card.card_faces?.[0]?.colors || [];
}

export function cardPrice(card) {
  const raw = card.prices?.usd;
  const value = raw === null || raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

export function isBasicLand(card) {
  const type = cardTypeLine(card);
  return type.includes("Basic") && type.includes("Land");
}

// --- Pool partitioning ------------------------------------------------
// Input: raw Scryfall printings for one set (unique=prints).
// Output: buckets keyed by rarity, plus basic and non-basic common lands.
// Rules, in order:
//  - Skip tokens, emblems, and art-series style extras.
//  - Skip bonus/special sheets: v1 models classic draft boosters only.
//  - Skip printings Scryfall flags as not appearing in boosters, when
//    that flag is present. Basic lands still pass: theirs is true.
//  - Deduplicate by name + rarity, so three arts of one common do not
//    triple its weight and cannot appear twice in one pack.
export function partitionPool(cards) {
  const buckets = {
    common: [],
    uncommon: [],
    rare: [],
    mythic: [],
    basicLand: [],
    commonLand: [],
  };
  const seen = new Set();
  for (const card of cards || []) {
    if (!card || typeof card.name !== "string") continue;
    if (card.layout === "token" || card.layout === "emblem") continue;
    if (cardTypeLine(card).includes("Token")) continue;
    if (card.rarity === "bonus" || card.rarity === "special") continue;
    if (card.booster === false) continue;
    const key = `${card.name}|${card.rarity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isBasicLand(card)) {
      buckets.basicLand.push(card);
    } else if (card.rarity === "common" && cardTypeLine(card).includes("Land")) {
      buckets.commonLand.push(card);
    } else if (buckets[card.rarity]) {
      buckets[card.rarity].push(card);
    }
  }
  return buckets;
}

export function poolCounts(buckets) {
  return {
    common: buckets.common.length,
    uncommon: buckets.uncommon.length,
    rare: buckets.rare.length,
    mythic: buckets.mythic.length,
    basicLand: buckets.basicLand.length,
    commonLand: buckets.commonLand.length,
  };
}

// --- Pack building -----------------------------------------------------
// Classic draft booster: 1 rare/mythic, 3 uncommon, 10 common, 1 land.
// Mythic chance is 1 in 8 on the rare slot. Empty buckets are skipped
// rather than crashing, so small or landless sets still open.
export function buildPack(buckets, rng = Math.random) {
  const used = new Set();
  const pack = [];
  const push = (cards, slot) => {
    for (const card of cards) pack.push({ ...card, slot });
  };

  const mythicAvailable = buckets.mythic.length > 0;
  const rarePool = rng() < 0.125 && mythicAvailable ? buckets.mythic : buckets.rare;
  let rareTaken = takeFrom(rarePool, 1, used, rng);
  if (rareTaken.length === 0 && rarePool === buckets.mythic) {
    rareTaken = takeFrom(buckets.rare, 1, used, rng);
  }
  if (rareTaken.length === 0 && rarePool === buckets.rare) {
    rareTaken = takeFrom(buckets.mythic, 1, used, rng);
  }
  push(rareTaken, "rare");

  push(takeFrom(buckets.uncommon, 3, used, rng), "uncommon");
  push(takeFrom(buckets.common, 10, used, rng), "common");

  let landTaken = takeFrom(buckets.basicLand, 1, used, rng);
  if (landTaken.length === 0) landTaken = takeFrom(buckets.commonLand, 1, used, rng);
  push(landTaken, "land");

  return pack;
}

export function buildPacks(buckets, packCount, rng = Math.random) {
  const count = Math.max(0, Math.floor(packCount) || 0);
  return Array.from({ length: count }, () => buildPack(buckets, rng));
}

// Flatten packs into one list, keeping pack number and slot per card.
export function flattenPacks(packs) {
  const flat = [];
  packs.forEach((pack, packIndex) => {
    for (const card of pack) flat.push({ ...card, packIndex: packIndex + 1 });
  });
  return flat;
}

// Group a flat pool by card id, counting copies across packs.
export function aggregatePool(flat) {
  const byId = new Map();
  for (const card of flat) {
    const existing = byId.get(card.id);
    if (existing) {
      existing.count += 1;
      existing.packs.push(card.packIndex);
    } else {
      byId.set(card.id, { card, count: 1, packs: [card.packIndex] });
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.card.name.localeCompare(b.card.name),
  );
}

// --- Sorting and filtering --------------------------------------------
const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };

export function sortPool(cards, sortKey = "name") {
  const out = [...cards];
  const byName = (a, b) => a.name.localeCompare(b.name);
  switch (sortKey) {
    case "cmc":
      return out.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || byName(a, b));
    case "rarity":
      return out.sort(
        (a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) || byName(a, b),
      );
    case "color": {
      const colorKey = (c) => cardColors(c).join("");
      return out.sort((a, b) => colorKey(a).localeCompare(colorKey(b)) || byName(a, b));
    }
    case "price": {
      const priceOf = (c) => {
        const p = cardPrice(c);
        return p === null ? -1 : p;
      };
      return out.sort((a, b) => priceOf(b) - priceOf(a) || byName(a, b));
    }
    case "pack":
      return out.sort(
        (a, b) =>
          (a.packIndex ?? 0) - (b.packIndex ?? 0) ||
          (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) ||
          byName(a, b),
      );
    case "type":
      return out.sort((a, b) => cardTypeLine(a).localeCompare(cardTypeLine(b)) || byName(a, b));
    case "number": {
      const num = (c) => Number.parseInt(c.collector_number, 10) || 0;
      return out.sort((a, b) => num(a) - num(b) || byName(a, b));
    }
    case "name":
    default:
      return out.sort(byName);
  }
}

export function filterPool(cards, filters = {}) {
  const query = (filters.query || "").trim().toLowerCase();
  return cards.filter((card) => {
    if (filters.rarity && card.rarity !== filters.rarity) return false;
    if (filters.type) {
      if (!cardTypeLine(card).toLowerCase().includes(filters.type.toLowerCase())) return false;
    }
    if (filters.color) {
      const colors = cardColors(card);
      if (filters.color === "C" && colors.length !== 0) return false;
      if (filters.color === "M" && colors.length < 2) return false;
      if (["W", "U", "B", "R", "G"].includes(filters.color) && !colors.includes(filters.color)) {
        return false;
      }
    }
    if (query) {
      const haystack = `${card.name} ${cardTypeLine(card)} ${cardOracleText(card)}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// --- Export formats ----------------------------------------------------
export function formatDecklist(aggregated) {
  return aggregated.map(({ card, count }) => `${count} ${card.name}`).join("\n");
}

export function formatDecklistDetailed(aggregated) {
  return aggregated
    .map(({ card, count }) => `${count} ${card.name} (${card.set}) ${card.collector_number}`)
    .join("\n");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function formatCSV(aggregated) {
  const header = [
    "count", "name", "set", "collector_number", "rarity",
    "type_line", "cmc", "colors", "mana_cost", "price_usd",
  ];
  const rows = aggregated.map(({ card, count }) => [
    count,
    card.name,
    card.set,
    card.collector_number,
    card.rarity,
    cardTypeLine(card),
    card.cmc ?? "",
    cardColors(card).join(""),
    cardManaCost(card),
    cardPrice(card) ?? "",
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

// --- Share links -------------------------------------------------------
// The whole draft config fits in the URL hash, so a link reproduces
// the same packs when the same seed is used.
export function encodeShare({ set, packs, seed }) {
  const params = new URLSearchParams();
  if (set) params.set("set", set);
  if (packs) params.set("packs", String(packs));
  if (seed) params.set("seed", seed);
  const query = params.toString();
  return query ? `#${query}` : "#";
}

export function decodeShare(hash) {
  const clean = String(hash || "").replace(/^#/, "");
  const params = new URLSearchParams(clean);
  const packs = Number.parseInt(params.get("packs") || "", 10);
  return {
    set: params.get("set") || "",
    packs: Number.isFinite(packs) ? packs : null,
    seed: params.get("seed") || "",
  };
}

// Draftable set types for the picker. Commander, tokens, and memorabilia
// sets are not draft boosters, so they are left out on purpose.
export const DRAFTABLE_SET_TYPES = ["expansion", "core", "masters", "draftinnovation"];

export function filterDraftableSets(sets) {
  return (sets || [])
    .filter((s) => DRAFTABLE_SET_TYPES.includes(s.set_type))
    .sort((a, b) => String(b.released_at || "").localeCompare(String(a.released_at || "")));
}
