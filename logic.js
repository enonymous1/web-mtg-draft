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

// --- Tabletop Simulator export -----------------------------------------
// Format verified against the TTS Knowledge Base save-file format and a
// live booster JSON from joshbirnholz's tts-magic-booster service:
// a Saved Object is { SaveName, GameMode, Gravity, PlayArea, ObjectStates,
// TabStates, VersionNumber, ... }, ObjectStates[0] is a Bag (or a Deck),
// a DeckCustom has DeckIDs, a CustomDeck map, and ContainedObjects, and
// the CustomDeck key matches the hundredth place of the CardID
// (CardID 200 -> key "2"). Each ContainedObjects entry is a CardCustom
// carrying a single-key copy of its own CustomDeck entry.
// Per-card mode is used here, not a 10x7 sprite sheet: every card gets
// its own FaceURL, so no sheet compositing or image hosting is needed.
// Face URLs are the Scryfall image_uris returned by the API at open
// time, never hand-built, so a Scryfall host migration does not break
// the export silently. The card back has no field in the Scryfall API;
// the standard back below was checked live (200) on 2026-11-06.
// Scryfall is moving card images to WebP, and TTS's Unity player has
// repeatedly failed to load WebP / direct Scryfall images, so the
// optional wsrv.nl proxy (output=jpg) is offered for the TTS export:
// it re-serves the same image as a JPEG, the trick the rikrassen
// importer uses. Proxy off means direct Scryfall URLs.
export const TTS_CARD_BACK_URL =
  "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";

export function isDoubleFaced(card) {
  return (
    Array.isArray(card.card_faces) &&
    card.card_faces.length > 1 &&
    !!card.card_faces[1]?.image_uris
  );
}

export function cardBackImage(card, size = "normal") {
  if (!isDoubleFaced(card)) return "";
  return card.card_faces[1].image_uris?.[size] || card.card_faces[1].image_uris?.normal || "";
}

export function ttsImageUrl(url, options = {}) {
  if (!url) return "";
  if (options.proxy) {
    return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=jpg`;
  }
  return url;
}

// Token ids referenced by a pool, from Scryfall all_parts entries with
// component "token". Callers fetch those ids with POST /cards/collection.
export function collectTokenIds(cards) {
  const ids = new Set();
  for (const card of cards || []) {
    for (const part of card.all_parts || []) {
      if (part.component === "token" && typeof part.id === "string") ids.add(part.id);
    }
  }
  return [...ids];
}

// A land pack for TTS: 4 copies of each basic land in the set, 20 cards
// when all five are present. Falls back to common non-basic lands.
export function buildLandPackCards(buckets, perLand = 4) {
  const sources = buckets.basicLand.length > 0 ? buckets.basicLand : buckets.commonLand;
  const out = [];
  for (const land of sources) {
    for (let i = 0; i < perLand; i += 1) out.push(land);
  }
  return out;
}

export function ttsDescription(card) {
  const price = cardPrice(card);
  const header =
    `${cardTypeLine(card)} | ${card.rarity} | ${(card.set || "").toUpperCase()} ${card.collector_number || ""}` +
    (price !== null ? ` | $${price.toFixed(2)}` : "");
  const oracle = cardOracleText(card);
  const text = oracle ? `${header}\n${oracle}` : header;
  return text.slice(0, 1000);
}

function ttsGuid(seedText) {
  return hashSeed(seedText).toString(16).padStart(8, "0").slice(0, 6);
}

function defaultTransform() {
  return { posX: 0, posY: 1, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 };
}

function buildTTSDeck(cards, nickname, description, guidSeed, options = {}) {
  const customDeck = {};
  const deckIds = [];
  const contained = [];
  let skipped = 0;
  let index = 0;
  for (const card of cards) {
    const face = ttsImageUrl(cardImage(card, "normal"), options);
    if (!face) {
      skipped += 1;
      continue;
    }
    index += 1;
    const deckIndex = index;
    const cardId = deckIndex * 100;
    const doubleFaced = isDoubleFaced(card);
    const back = doubleFaced
      ? ttsImageUrl(cardBackImage(card, "normal"), options)
      : ttsImageUrl(TTS_CARD_BACK_URL, options);
    const entry = {
      FaceURL: face,
      BackURL: back,
      NumWidth: 1,
      NumHeight: 1,
      BackIsHidden: !doubleFaced,
      UniqueBack: doubleFaced,
    };
    customDeck[String(deckIndex)] = entry;
    deckIds.push(cardId);
    contained.push({
      Name: "CardCustom",
      Nickname: card.name,
      Description: ttsDescription(card),
      CardID: cardId,
      HideWhenFaceDown: true,
      Transform: defaultTransform(),
      ColorDiffuse: { r: 1, g: 1, b: 1 },
      CustomDeck: { [String(deckIndex)]: entry },
    });
  }
  return {
    deck: {
      Name: "DeckCustom",
      Nickname: nickname,
      Description: description,
      Transform: defaultTransform(),
      GUID: ttsGuid(guidSeed),
      HideWhenFaceDown: true,
      DeckIDs: deckIds,
      CustomDeck: customDeck,
      ContainedObjects: contained,
    },
    skipped,
  };
}

// Build a whole Saved Object: a Bag holding the pool deck, plus a token
// deck and a land-pack deck when those lists are non-empty. Returns the
// object and counts, so the UI can report what was included and skipped.
export function buildTTSSavedObject({ setName, setCode, packs, seed, pool, tokens = [], lands = [], options = {}, poolLabel = "Pool" }) {
  const decks = [];
  let skipped = 0;
  const poolResult = buildTTSDeck(
    pool,
    poolLabel,
    `${setName} ${poolLabel.toLowerCase()}: ${packs} pack${packs === 1 ? "" : "s"}${seed ? `, seed ${seed}` : ""}.`,
    `pool:${setCode}:${seed || "random"}`,
    options,
  );
  skipped += poolResult.skipped;
  if (poolResult.deck.DeckIDs.length > 0) decks.push(poolResult.deck);

  if (tokens.length > 0) {
    const tokenResult = buildTTSDeck(
      tokens,
      "Tokens",
      `Tokens created by cards in this pool. Each token is its own card; add copies in TTS as needed.`,
      `tokens:${setCode}:${seed || "random"}`,
      options,
    );
    skipped += tokenResult.skipped;
    if (tokenResult.deck.DeckIDs.length > 0) decks.push(tokenResult.deck);
  }

  if (lands.length > 0) {
    const landResult = buildTTSDeck(
      lands,
      "Basic Lands",
      `Land pack: ${lands.length} basic lands from ${setName}.`,
      `lands:${setCode}:${seed || "random"}`,
      options,
    );
    skipped += landResult.skipped;
    if (landResult.deck.DeckIDs.length > 0) decks.push(landResult.deck);
  }

  const nickname = `${setName} - ${packs} pack${packs === 1 ? "" : "s"} (${pool.length} cards)`;
  const savedObject = {
    SaveName: nickname,
    GameMode: "",
    Gravity: 0.5,
    PlayArea: 0.5,
    Date: "",
    Table: "",
    Sky: "",
    Note: `Generated by web-mtg-draft from Scryfall data${seed ? `, seed ${seed}` : ""}. Face images are Scryfall card images${options.proxy ? ", served through wsrv.nl as JPEG for Tabletop Simulator" : ""}.`,
    Rules: "",
    XmlUI: "",
    LuaScript: "",
    LuaScriptState: "",
    ObjectStates: [
      {
        Name: "Bag",
        Nickname: nickname,
        Description: `MTG Draft pool from ${setName}. Open the bag in Tabletop Simulator to take out the Pool, Tokens, and Basic Lands decks.`,
        Transform: defaultTransform(),
        GUID: ttsGuid(`bag:${setCode}:${seed || "random"}`),
        ContainedObjects: decks,
      },
    ],
    TabStates: {},
    VersionNumber: "",
  };
  return { savedObject, skipped, deckCount: decks.length, cardCount: decks.reduce((n, d) => n + d.DeckIDs.length, 0) };
}

// --- Deck-builder board ------------------------------------------------
// Zones: pool (unassigned), main, sideboard, maybe. Basic lands are
// unlimited in limited play, so they are counts by name, not cards
// dragged from the pool — the pool's own lands stay where they are.
// Board state is plain data, so app.js can save it to localStorage as
// indices into the flat pool (see serializeBoard / deserializeBoard)
// and rebuild it from the same set/packs/seed without storing whole
// Scryfall card objects twice.
export const BOARD_ZONES = ["pool", "main", "sideboard", "maybe"];
export const BASIC_LAND_NAMES = ["Plains", "Island", "Swamp", "Mountain", "Forest"];

export function createBoard(flatPool) {
  return {
    pool: sortPool([...(flatPool || [])], "cmc"),
    main: [],
    sideboard: [],
    maybe: [],
    lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
  };
}

export function moveCard(board, fromZone, toZone, index) {
  if (!BOARD_ZONES.includes(fromZone) || !BOARD_ZONES.includes(toZone)) return board;
  if (fromZone === toZone) return board;
  const source = board[fromZone] || [];
  if (!Number.isInteger(index) || index < 0 || index >= source.length) return board;
  const next = {
    pool: [...board.pool],
    main: [...board.main],
    sideboard: [...board.sideboard],
    maybe: [...board.maybe],
    lands: { ...board.lands },
  };
  const [card] = next[fromZone].splice(index, 1);
  next[toZone].push(card);
  return next;
}

export function sortBoard(board, sortKey = "cmc") {
  return {
    pool: sortPool(board.pool, sortKey),
    main: sortPool(board.main, sortKey),
    sideboard: sortPool(board.sideboard, sortKey),
    maybe: sortPool(board.maybe, sortKey),
    lands: { ...board.lands },
  };
}

export function resetBoard(board) {
  const all = [...board.pool, ...board.main, ...board.sideboard, ...board.maybe];
  return {
    pool: sortPool(all, "cmc"),
    main: [],
    sideboard: [],
    maybe: [],
    lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
  };
}

export function addBasicLand(board, name, count = 1) {
  if (!BASIC_LAND_NAMES.includes(name)) return board;
  const next = { ...board, lands: { ...board.lands } };
  next.lands[name] = Math.max(0, Math.min(99, (next.lands[name] || 0) + count));
  return next;
}

export function landTotal(board) {
  return Object.values(board.lands || {}).reduce((sum, n) => sum + (n || 0), 0);
}

export function boardCounts(board) {
  return {
    pool: board.pool.length,
    main: board.main.length,
    sideboard: board.sideboard.length,
    maybe: board.maybe.length,
    lands: landTotal(board),
    mainTotal: board.main.length + landTotal(board),
  };
}

export function boardIsActive(board) {
  return board.main.length > 0 || board.sideboard.length > 0 || landTotal(board) > 0;
}

export function boardStatus(board, target = 40) {
  const mainTotal = board.main.length + landTotal(board);
  const diff = target - mainTotal;
  return {
    mainTotal,
    target,
    diff,
    state: diff > 0 ? "under" : diff < 0 ? "over" : "ready",
    message:
      diff > 0
        ? `${diff} card${diff === 1 ? "" : "s"} to go to ${target}`
        : diff < 0
          ? `${-diff} card${-diff === 1 ? "" : "s"} over ${target}`
          : `Ready: ${target} cards`,
  };
}

// Mana curve for the main deck, basic lands excluded. Buckets 0-6, then 7+.
export function manaCurve(cards) {
  const buckets = Array.from({ length: 8 }, (_, i) => ({ cmc: i === 7 ? "7+" : i, count: 0 }));
  for (const card of cards || []) {
    if (isBasicLand(card)) continue;
    const cmc = card.cmc ?? 0;
    buckets[Math.min(7, Math.max(0, cmc))].count += 1;
  }
  return buckets;
}

export function colorBreakdown(cards) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, M: 0 };
  for (const card of cards || []) {
    if (isBasicLand(card)) continue;
    const colors = cardColors(card);
    if (colors.length === 0) out.C += 1;
    else if (colors.length > 1) out.M += 1;
    else if (out[colors[0]] !== undefined) out[colors[0]] += 1;
  }
  return out;
}

// Main deck as a flat card list, with added basic lands expanded using
// a name -> card lookup (usually the set's own basic lands).
export function boardMainCards(board, landCardsByName = {}) {
  const out = [...board.main];
  for (const name of BASIC_LAND_NAMES) {
    const count = board.lands?.[name] || 0;
    const landCard = landCardsByName[name];
    if (!landCard) continue;
    for (let i = 0; i < count; i += 1) out.push(landCard);
  }
  return out;
}

export function boardDecklist(board, landCardsByName = {}) {
  const mainText = formatDecklist(aggregatePool(boardMainCards(board, landCardsByName)));
  if (board.sideboard.length === 0) return mainText;
  return `${mainText}\n\nSideboard\n${formatDecklist(aggregatePool(board.sideboard))}`;
}

export function serializeBoard(board, flatPool) {
  const zoneIndices = (zone) =>
    board[zone].map((card) => flatPool.indexOf(card)).filter((i) => i >= 0);
  return {
    pool: zoneIndices("pool"),
    main: zoneIndices("main"),
    sideboard: zoneIndices("sideboard"),
    maybe: zoneIndices("maybe"),
    lands: { ...board.lands },
  };
}

export function deserializeBoard(saved, flatPool) {
  if (!saved || !Array.isArray(saved.pool)) return null;
  const zone = (arr) => (arr || []).map((i) => flatPool[i]).filter(Boolean);
  return {
    pool: zone(saved.pool),
    main: zone(saved.main),
    sideboard: zone(saved.sideboard),
    maybe: zone(saved.maybe),
    lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0, ...(saved.lands || {}) },
  };
}
