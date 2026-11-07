import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addBasicLand,
  aggregatePool,
  applyFoil,
  boardCounts,
  boardDecklist,
  boardIsActive,
  boardMainCards,
  boardStatus,
  buildLandPackCards,
  buildPack,
  buildPacks,
  buildTTSSavedObject,
  cardImage,
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
  formatCSV,
  formatDecklist,
  groupPoolByColor,
  hashSeed,
  isDoubleFaced,
  landTotal,
  manaCurve,
  moveAll,
  moveCard,
  mulberry32,
  parse17LandsRatings,
  partitionPool,
  ratingFor,
  ratingGrade,
  resetBoard,
  serializeBoard,
  shuffle,
  sortPool,
  takeFrom,
  ttsImageUrl,
} from "../logic.js";

function card(overrides = {}) {
  return {
    id: overrides.id || `id-${overrides.name || "card"}`,
    name: overrides.name || "Test Card",
    rarity: overrides.rarity || "common",
    type_line: overrides.type_line || "Creature",
    cmc: overrides.cmc ?? 2,
    colors: overrides.colors || [],
    set: overrides.set || "tst",
    collector_number: overrides.collector_number || "1",
    prices: overrides.prices || { usd: "1.00" },
    booster: overrides.booster,
    layout: overrides.layout,
    image_uris: overrides.image_uris,
    all_parts: overrides.all_parts,
    ...overrides.extra,
  };
}

function buckets() {
  const make = (rarity, prefix, count) =>
    Array.from({ length: count }, (_, i) => card({ id: `${prefix}-${i}`, name: `${prefix} ${i}`, rarity }));
  return {
    common: make("common", "Common", 20),
    uncommon: make("uncommon", "Uncommon", 10),
    rare: make("rare", "Rare", 5),
    mythic: make("mythic", "Mythic", 5),
    basicLand: [card({ id: "plains", name: "Plains", rarity: "common", type_line: "Basic Land - Plains" })],
    commonLand: [card({ id: "common-land", name: "Common Land", rarity: "common", type_line: "Land" })],
  };
}

test("seeded rng is reproducible and seed-sensitive", () => {
  assert.equal(hashSeed("friday"), hashSeed("friday"));
  assert.notEqual(hashSeed("friday"), hashSeed("saturday"));
  const a = mulberry32(hashSeed("friday"));
  const b = mulberry32(hashSeed("friday"));
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("shuffle preserves cards and does not mutate", () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, mulberry32(42));
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
});

test("takeFrom samples without replacement", () => {
  const pool = [card({ id: "a", name: "A" }), card({ id: "b", name: "B" })];
  const taken = takeFrom(pool, 5, new Set(), mulberry32(1));
  assert.equal(taken.length, 2);
});

test("partitionPool skips tokens, bonus sheets, non-booster printings, and dedupes", () => {
  const cards = [
    card({ id: "c1", name: "Common One", rarity: "common" }),
    card({ id: "c1-art", name: "Common One", rarity: "common" }),
    card({ id: "tok", name: "Soldier Token", rarity: "common", type_line: "Token Creature - Soldier", layout: "token" }),
    card({ id: "bon", name: "Bonus Card", rarity: "bonus" }),
    card({ id: "promo", name: "Promo Card", rarity: "rare", booster: false }),
    card({ id: "plains", name: "Plains", rarity: "common", type_line: "Basic Land - Plains" }),
    card({ id: "guildgate", name: "Guildgate", rarity: "common", type_line: "Land - Gate" }),
  ];
  const out = partitionPool(cards);
  assert.equal(out.common.length, 1);
  assert.equal(out.basicLand.length, 1);
  assert.equal(out.commonLand.length, 1);
  assert.equal(out.rare.length, 0);
});

test("buildPack is a classic 15-card pack with no repeats inside it", () => {
  const pack = buildPack(buckets(), mulberry32(7));
  assert.equal(pack.length, 15);
  assert.equal(pack.filter((c) => c.slot === "rare").length, 1);
  assert.equal(pack.filter((c) => c.slot === "uncommon").length, 3);
  assert.equal(pack.filter((c) => c.slot === "common").length, 10);
  assert.equal(pack.filter((c) => c.slot === "land").length, 1);
  assert.equal(new Set(pack.map((c) => c.id)).size, 15);
});

test("buildPack picks mythic when the first random draw is under 1 in 8", () => {
  const pack = buildPack(buckets(), () => 0.01);
  assert.equal(pack.find((c) => c.slot === "rare").rarity, "mythic");
  const rarePack = buildPack(buckets(), () => 0.5);
  assert.equal(rarePack.find((c) => c.slot === "rare").rarity, "rare");
});

test("buildPack falls back to a common land when there are no basics", () => {
  const b = buckets();
  b.basicLand = [];
  const pack = buildPack(b, mulberry32(3));
  assert.equal(pack.find((c) => c.slot === "land").name, "Common Land");
});

test("buildPacks with the same seed deal the same packs", () => {
  const a = buildPacks(buckets(), 3, mulberry32(hashSeed("seed-1")));
  const b = buildPacks(buckets(), 3, mulberry32(hashSeed("seed-1")));
  assert.deepEqual(
    a.map((p) => p.map((c) => c.id)),
    b.map((p) => p.map((c) => c.id)),
  );
});

test("aggregate, decklist, and CSV handle counts and commas", () => {
  const flat = [
    { ...card({ id: "a", name: "Bolt, Fiery" }), packIndex: 1 },
    { ...card({ id: "a", name: "Bolt, Fiery" }), packIndex: 2 },
    { ...card({ id: "b", name: "Alpha" }), packIndex: 1 },
  ];
  const agg = aggregatePool(flat);
  assert.equal(agg.find((x) => x.card.id === "a").count, 2);
  assert.match(formatDecklist(agg), /2 Bolt, Fiery/);
  assert.match(formatCSV(agg), /"Bolt, Fiery"/);
});

test("sortPool orders by rarity, mana value, and price", () => {
  const cards = [
    card({ id: "c", name: "Cheap Common", rarity: "common", cmc: 5, prices: { usd: "0.10" } }),
    card({ id: "m", name: "Mythic Card", rarity: "mythic", cmc: 1, prices: { usd: "9.00" } }),
    card({ id: "r", name: "Rare Card", rarity: "rare", cmc: 3, prices: { usd: null } }),
  ];
  assert.equal(sortPool(cards, "rarity")[0].rarity, "mythic");
  assert.equal(sortPool(cards, "cmc")[0].cmc, 1);
  assert.equal(sortPool(cards, "price")[0].rarity, "mythic");
  assert.equal(sortPool(cards, "price").at(-1).rarity, "rare");
});

test("filterPool handles color, rarity, type, and text", () => {
  const cards = [
    card({ id: "w", name: "White Knight", rarity: "uncommon", type_line: "Creature - Knight", colors: ["W"], extra: {} }),
    card({ id: "g", name: "Green Elf", rarity: "common", type_line: "Creature - Elf", colors: ["G"] }),
    card({ id: "x", name: "Fireball", rarity: "common", type_line: "Sorcery", colors: ["R"] }),
  ];
  // card() helper puts colors at top level already; re-assert via filter.
  assert.equal(filterPool(cards, { color: "W" }).length, 1);
  assert.equal(filterPool(cards, { color: "C" }).length, 0);
  assert.equal(filterPool(cards, { rarity: "uncommon" }).length, 1);
  assert.equal(filterPool(cards, { type: "Sorcery" }).length, 1);
  assert.equal(filterPool(cards, { query: "elf" }).length, 1);
});

test("card helpers fall back to the front face and handle missing prices", () => {
  const double = {
    name: "Double Card",
    card_faces: [{ image_uris: { normal: "https://example.invalid/front.jpg" }, mana_cost: "{1}{U}", type_line: "Creature", colors: ["U"] }],
    prices: { usd: null },
  };
  assert.equal(cardImage(double, "normal"), "https://example.invalid/front.jpg");
  assert.equal(cardPrice(double), null);
  assert.equal(cardPrice(card({ prices: { usd: "2.50" } })), 2.5);
});

test("share links round-trip set, packs, and seed", () => {
  const hash = encodeShare({ set: "blb", packs: 6, seed: "friday-night" });
  assert.deepEqual(decodeShare(hash), { set: "blb", packs: 6, seed: "friday-night" });
  assert.deepEqual(decodeShare(""), { set: "", packs: null, seed: "" });
});

test("filterDraftableSets drops commander sets and sorts newest first", () => {
  const sets = [
    { code: "cmd", set_type: "commander", released_at: "2025-01-01", name: "Commander" },
    { code: "old", set_type: "expansion", released_at: "2020-01-01", name: "Old" },
    { code: "new", set_type: "expansion", released_at: "2024-01-01", name: "New" },
  ];
  const out = filterDraftableSets(sets);
  assert.deepEqual(out.map((s) => s.code), ["new", "old"]);
});

test("collectTokenIds finds only token parts", () => {
  const cards = [
    { name: "Raise", all_parts: [
      { id: "tok-1", component: "token", name: "Soldier" },
      { id: "combo-1", component: "combo_piece", name: "Raise" },
    ]},
    { name: "Plain" },
    { name: "Raise Again", all_parts: [{ id: "tok-1", component: "token", name: "Soldier" }] },
  ];
  assert.deepEqual(collectTokenIds(cards), ["tok-1"]);
});

test("buildLandPackCards gives 4 of each basic land", () => {
  const b = buckets();
  b.basicLand = [
    card({ id: "plains", name: "Plains", type_line: "Basic Land - Plains" }),
    card({ id: "island", name: "Island", type_line: "Basic Land - Island" }),
  ];
  const lands = buildLandPackCards(b);
  assert.equal(lands.length, 8);
  assert.equal(lands.filter((c) => c.name === "Plains").length, 4);
});

test("TTS export is a Bag with a DeckCustom pool, sequential CardIDs, and matching CustomDeck keys", () => {
  const pool = [
    card({ id: "a", name: "Alpha", image_uris: { normal: "https://example.invalid/a.jpg" } }),
    card({ id: "a", name: "Alpha", image_uris: { normal: "https://example.invalid/a.jpg" } }),
    card({ id: "b", name: "Beta", image_uris: { normal: "https://example.invalid/b.jpg" } }),
  ];
  const { savedObject, skipped, deckCount, cardCount } = buildTTSSavedObject({
    setName: "Test Set", setCode: "tst", packs: 1, seed: "seed-1", pool,
  });
  assert.equal(skipped, 0);
  assert.equal(deckCount, 1);
  assert.equal(cardCount, 3);
  assert.equal(savedObject.ObjectStates[0].Name, "Bag");
  const deck = savedObject.ObjectStates[0].ContainedObjects[0];
  assert.equal(deck.Name, "DeckCustom");
  assert.deepEqual(deck.DeckIDs, [100, 200, 300]);
  assert.equal(deck.CustomDeck["2"].FaceURL, "https://example.invalid/a.jpg");
  assert.equal(deck.CustomDeck["3"].FaceURL, "https://example.invalid/b.jpg");
  assert.equal(deck.ContainedObjects[1].CardID, 200);
  assert.deepEqual(Object.keys(deck.ContainedObjects[1].CustomDeck), ["2"]);
  // Same Scryfall card twice still gets two distinct CardIDs.
  assert.notEqual(deck.ContainedObjects[0].CardID, deck.ContainedObjects[1].CardID);
});

test("TTS export skips cards with no image and reports them", () => {
  const pool = [card({ id: "noimg", name: "No Image" })];
  delete pool[0].image_uris;
  const { savedObject, skipped, cardCount } = buildTTSSavedObject({
    setName: "Test Set", setCode: "tst", packs: 1, seed: "", pool,
  });
  assert.equal(skipped, 1);
  assert.equal(cardCount, 0);
  assert.equal(savedObject.ObjectStates[0].ContainedObjects.length, 0);
});

test("TTS double-faced cards get UniqueBack with the back face, normal cards do not", () => {
  const dfc = {
    id: "dfc-1", name: "Double Card", rarity: "rare", type_line: "Creature",
    set: "tst", collector_number: "1", cmc: 2, colors: ["U"], prices: { usd: "1.00" },
    card_faces: [
      { image_uris: { normal: "https://example.invalid/front.jpg" }, oracle_text: "Front." },
      { image_uris: { normal: "https://example.invalid/back.jpg" }, oracle_text: "Back." },
    ],
  };
  assert.equal(isDoubleFaced(dfc), true);
  const { savedObject } = buildTTSSavedObject({
    setName: "Test Set", setCode: "tst", packs: 1, seed: "", pool: [dfc],
  });
  const entry = savedObject.ObjectStates[0].ContainedObjects[0].CustomDeck["1"];
  assert.equal(entry.FaceURL, "https://example.invalid/front.jpg");
  assert.equal(entry.BackURL, "https://example.invalid/back.jpg");
  assert.equal(entry.UniqueBack, true);
  assert.equal(entry.BackIsHidden, false);
});

test("TTS proxy rewrites face URLs through wsrv.nl as JPEG", () => {
  assert.equal(
    ttsImageUrl("https://example.invalid/a.jpg", { proxy: true }),
    "https://wsrv.nl/?url=https%3A%2F%2Fexample.invalid%2Fa.jpg&output=jpg",
  );
  assert.equal(ttsImageUrl("https://example.invalid/a.jpg", {}), "https://example.invalid/a.jpg");
});

test("TTS export includes token and land decks when given", () => {
  const pool = [card({ id: "a", name: "Alpha", image_uris: { normal: "https://example.invalid/a.jpg" } })];
  const tokens = [card({ id: "t1", name: "Soldier Token", image_uris: { normal: "https://example.invalid/t.jpg" } })];
  const lands = [card({ id: "plains", name: "Plains", image_uris: { normal: "https://example.invalid/p.jpg" } })];
  const { savedObject, deckCount, cardCount } = buildTTSSavedObject({
    setName: "Test Set", setCode: "tst", packs: 1, seed: "", pool, tokens, lands,
  });
  assert.equal(deckCount, 3);
  assert.equal(cardCount, 3);
  assert.deepEqual(
    savedObject.ObjectStates[0].ContainedObjects.map((d) => d.Nickname),
    ["Pool", "Tokens", "Basic Lands"],
  );
});

test("board: create, move, and counts", () => {
  const pool = [
    card({ id: "a", name: "Alpha", cmc: 1, colors: ["W"] }),
    card({ id: "b", name: "Beta", cmc: 3, colors: ["U", "B"] }),
    card({ id: "c", name: "Gamma", cmc: 0 }),
  ];
  let board = createBoard(pool);
  assert.equal(board.pool.length, 3);
  assert.deepEqual(boardCounts(board), { pool: 3, main: 0, sideboard: 0, maybe: 0, lands: 0, mainTotal: 0 });
  // createBoard sorts by cmc: Gamma (0), Alpha (1), Beta (3).
  const moved = moveCard(board, "pool", "main", 0);
  assert.equal(moved.pool.length, 2);
  assert.equal(moved.main.length, 1);
  assert.equal(moved.main[0].name, "Gamma");
  // Original board is untouched (moves are non-mutating).
  assert.equal(board.pool.length, 3);
  // Bad zone / index / same zone are no-ops.
  assert.equal(moveCard(moved, "pool", "main", 99), moved);
  assert.equal(moveCard(moved, "pool", "pool", 0), moved);
  assert.equal(moveCard(moved, "pool", "nowhere", 0), moved);
  board = moveCard(moved, "main", "sideboard", 0);
  assert.equal(board.main.length, 0);
  assert.equal(board.sideboard.length, 1);
});

test("board: basic lands are counts, clamped, and count toward the main deck", () => {
  let board = createBoard([]);
  board = addBasicLand(board, "Plains", 5);
  board = addBasicLand(board, "Island", 2);
  board = addBasicLand(board, "Plains", -1);
  assert.equal(landTotal(board), 6);
  assert.equal(boardCounts(board).mainTotal, 6);
  assert.equal(boardStatus(board, 40).state, "under");
  assert.equal(boardStatus(board, 40).diff, 34);
  board = addBasicLand(board, "Forest", 100);
  assert.equal(board.lands.Forest, 99);
  assert.equal(addBasicLand(board, "NotALand", 1), board);
  assert.equal(boardIsActive(board), true);
  assert.equal(boardIsActive(createBoard([])), false);
});

test("board: status ready and over", () => {
  let board = createBoard([]);
  board = addBasicLand(board, "Plains", 40);
  assert.equal(boardStatus(board, 40).state, "ready");
  board = addBasicLand(board, "Plains", 1);
  assert.equal(boardStatus(board, 40).state, "over");
  assert.equal(boardStatus(board, 40).diff, -1);
});

test("board: mana curve and color breakdown exclude basic lands", () => {
  const main = [
    card({ id: "a", name: "Alpha", cmc: 1, colors: ["W"] }),
    card({ id: "b", name: "Beta", cmc: 7, colors: ["U", "B"] }),
    card({ id: "c", name: "Gamma", cmc: 8, colors: [] }),
    card({ id: "plains", name: "Plains", type_line: "Basic Land — Plains", cmc: 0 }),
  ];
  const curve = manaCurve(main);
  assert.equal(curve[1].count, 1);
  assert.equal(curve[7].count, 2); // 7 and 8+ both land in "7+"
  assert.equal(curve[0].count, 0); // the Plains is a basic land, excluded
  assert.deepEqual(colorBreakdown(main), { W: 1, U: 0, B: 0, R: 0, G: 0, C: 1, M: 1 });
});

test("board: main cards expand added lands, decklist separates sideboard", () => {
  const plains = card({ id: "plains", name: "Plains", type_line: "Basic Land — Plains" });
  const spell = card({ id: "a", name: "Alpha", cmc: 1 });
  let board = createBoard([spell, plains]);
  board = moveCard(board, "pool", "main", 0); // Alpha is cmc 1, Plains is cmc 0 — first is Plains
  // After the move, main holds one card; check the decklist shape instead
  // of assuming which card moved first.
  const mainCards = boardMainCards(board, { Plains: plains });
  assert.equal(mainCards.length, 1);
  board = addBasicLand(board, "Plains", 2);
  const expanded = boardMainCards(board, { Plains: plains });
  assert.equal(expanded.length, 3);
  assert.equal(expanded.filter((c) => c.name === "Plains").length, 2);
  const list = boardDecklist(board, { Plains: plains });
  assert.ok(list.includes("Plains"));
  // Sideboard section appears only when the sideboard is non-empty.
  assert.ok(!list.includes("Sideboard"));
  board = moveCard(board, "pool", "sideboard", 0);
  assert.ok(boardDecklist(board, { Plains: plains }).includes("Sideboard"));
});

test("board: serialize and deserialize round-trip, and reset returns all to pool", () => {
  const pool = [
    card({ id: "a", name: "Alpha", cmc: 1 }),
    card({ id: "b", name: "Beta", cmc: 2 }),
    card({ id: "c", name: "Gamma", cmc: 3 }),
  ];
  let board = createBoard(pool);
  board = moveCard(board, "pool", "main", 0);
  board = moveCard(board, "pool", "maybe", 0);
  board = addBasicLand(board, "Mountain", 4);
  const flat = [...board.pool, ...board.main, ...board.maybe];
  // Serialize against the original flat order is lossy here, so serialize
  // against the board's own card objects by rebuilding a flat list first.
  const allCards = [...board.pool, ...board.main, ...board.sideboard, ...board.maybe];
  const saved = serializeBoard(board, allCards);
  const restored = deserializeBoard(saved, allCards);
  assert.deepEqual(restored.main.map((c) => c.name), board.main.map((c) => c.name));
  assert.deepEqual(restored.maybe.map((c) => c.name), board.maybe.map((c) => c.name));
  assert.equal(restored.lands.Mountain, 4);
  assert.equal(deserializeBoard(null, allCards), null);
  assert.equal(deserializeBoard({}, allCards), null);
  const reset = resetBoard(board);
  assert.equal(reset.pool.length, 3);
  assert.equal(reset.main.length, 0);
  assert.equal(reset.lands.Mountain, 0);
});

test("17Lands: parse ratings, grade, and rating sort", () => {
  const data = JSON.parse(fs.readFileSync(new URL("./fixtures/17lands-fra-sample.json", import.meta.url), "utf8"));
  const ratings = parse17LandsRatings(data);
  assert.equal(ratings.total, 3);
  assert.equal(ratings.withData, 2);
  assert.equal(ratings.available, false); // sample is small, needs >= 10 with data
  assert.equal(ratingFor({ name: "Craftwork Crusher" }, ratings).gih, 0.63103953);
  assert.equal(ratingGrade(0.63103953), "A");
  assert.equal(ratingGrade(0.58), "B");
  assert.equal(ratingGrade(0.55), "C");
  assert.equal(ratingGrade(0.52), "D");
  assert.equal(ratingGrade(0.49), "F");
  assert.equal(ratingGrade(null), null);
  assert.equal(ratingFor({ name: "No Such Card" }, ratings), null);
  const cards = [
    card({ id: "low", name: "Low Card", cmc: 1 }),
    card({ id: "high", name: "Craftwork Crusher", cmc: 5 }),
    card({ id: "mid", name: "Divining Duelist", cmc: 2 }),
  ];
  const sorted = sortPool(cards, "rating", ratings);
  assert.deepEqual(sorted.map((c) => c.name), ["Craftwork Crusher", "Divining Duelist", "Low Card"]);
  const empty = parse17LandsRatings([]);
  assert.equal(empty.available, false);
  assert.equal(empty.total, 0);
});

test("groupPoolByColor groups lands, multicolor, and colorless separately", () => {
  const cards = [
    card({ id: "w", name: "White One", colors: ["W"], cmc: 2 }),
    card({ id: "m", name: "Multi One", colors: ["W", "U"], cmc: 3 }),
    card({ id: "c", name: "Colorless One", colors: [], cmc: 1 }),
    card({ id: "plains", name: "Plains", type_line: "Basic Land — Plains", cmc: 0 }),
  ];
  const groups = groupPoolByColor(cards);
  assert.deepEqual(groups.map((g) => g.key), ["W", "M", "C", "Land"]);
  assert.equal(groups.find((g) => g.key === "M").cards[0].name, "Multi One");
});

test("applyFoil replaces a common about 1 in 3 packs, never changes pack size", () => {
  const pack = buildPack(buckets(), mulberry32(7));
  assert.equal(pack.length, 15);
  const foiled = applyFoil(pack, () => 0.0);
  assert.equal(foiled.length, 15);
  assert.equal(foiled.filter((c) => c.foil).length, 1);
  assert.equal(foiled.find((c) => c.foil).slot, "common");
  assert.equal(applyFoil(pack, () => 0.99), pack);
  assert.equal(applyFoil(pack.filter((c) => c.slot !== "common"), () => 0.0).length, pack.filter((c) => c.slot !== "common").length);
});

test("moveAll moves every matching card and nothing else", () => {
  const pool = [
    card({ id: "a", name: "Alpha", type_line: "Creature — Cat", colors: ["W"] }),
    card({ id: "b", name: "Beta", type_line: "Instant", colors: ["U"] }),
    card({ id: "c", name: "Gamma", type_line: "Creature — Dog", colors: ["W"] }),
  ];
  let board = createBoard(pool);
  board = moveAll(board, "pool", "main", (c) => cardTypeLine(c).includes("Creature"));
  assert.equal(board.main.length, 2);
  assert.equal(board.pool.length, 1);
  assert.equal(board.pool[0].name, "Beta");
  assert.equal(moveAll(board, "pool", "main", (c) => c.name === "Nope"), board);
});
