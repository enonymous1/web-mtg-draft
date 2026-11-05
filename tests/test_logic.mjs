import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePool,
  buildPack,
  buildPacks,
  cardImage,
  cardPrice,
  decodeShare,
  encodeShare,
  filterDraftableSets,
  filterPool,
  formatCSV,
  formatDecklist,
  hashSeed,
  mulberry32,
  partitionPool,
  shuffle,
  sortPool,
  takeFrom,
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
