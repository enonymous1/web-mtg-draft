# Staff Review — web-mtg-draft v1.6.0

Date: 2026-11-07. Reviewer role: staff engineer / open-source maintainer.
Scope: `index.html`, `styles.css`, `app.js`, `logic.js`, `table3d.js`,
`sw.js`, `tests/`, `.github/workflows/`, `package.json`, `README.md`.
Method: full read of every source file, plus the live-verified behavior
notes in the README (Scryfall `booster` flag, 17Lands limits, Play
Booster recipe). No behavior was re-verified live in this review except
where stated; the findings below are from the code.

Verdict: this is a well-built small project. The best decision in it is
the `logic.js` / `app.js` split — the pure, DOM-free logic module is
genuinely testable (37 Node tests, all meaningful) and it is the reason
the Scryfall `booster`-flag bug and the Play Booster recipe were both
fixable in one place. The main risks are the opposite side of that same
coin: `app.js` has grown into a ~1,000-line module with ~20 globals and
three rendering paths that duplicate each other's markup, and
`table3d.js` leaks GPU resources on every pack. Nothing here is a
rewrite; the fixes below are small, and the ones marked **Fixed in
v1.7.0** are already in the tree.

Severity: **P0** = user-visible bug or data loss. **P1** = will bite on
the next change. **P2** = maintainability / polish.

---

## 1. Best practices & code quality

### P0 — `table3d.js`: GPU resources leak on every pack
`setPack()` builds a new `PlaneGeometry`, two `MeshBasicMaterial`s, and
a glow plane per card, and `TextureLoader.load()` per face — then
`scene.remove()` on the next pack without disposing anything.
`scene.remove()` frees nothing on the GPU. Six sealed packs is ~90
card meshes, ~180 materials, ~90 geometries, plus one texture per
unique face, held until the tab closes. On a phone that is a visible
memory climb across a session.

**Fixed in v1.7.0:** `setPack()` now disposes each card's geometry,
materials, and non-shared textures before removing it, and reuses one
shared geometry for all cards. The shared card-back texture is never
disposed (it is loaded once and reused).

### P1 — Magic numbers are duplicated across `app.js`
The Scryfall rate limit appears as three separate literals: `sleep(550)`
in `fetchAllPages` (`app.js`) and in `fetchTokens` (`app.js`), and the
page size `175` is hardcoded again in the `openPacks` progress message.
The token batch size `70` is a literal in `fetchTokens`, and the
rate-limit error string is copy-pasted in both fetch paths. If
Scryfall's limit ever changes, three places must change together and
one of them is inside a user-facing string.

**Fixed in v1.7.0:** `SCRYFALL_REQUEST_GAP_MS = 550`,
`SCRYFALL_PAGE_SIZE = 175`, `SCRYFALL_COLLECTION_BATCH_SIZE = 70`,
and one `rateLimitError()` helper, all in `app.js`.

### P1 — Badge markup is written three times (`app.js`)
The rarity + foil badge string
`` `<span class="badge ${rarity}">…</span>${foil ? '<span class="badge foil">Foil</span>' : ''}` ``
appears in `renderReveal` (~line 531), in the pool grid card builder
(~line 630), and the foil half appears again in the reveal card class
name. The list view builds a fourth, slightly different variant. Any
change to the badge (a new "wildcard" badge, a title attribute) needs
three coordinated edits, and they will drift — the list view already
has.

**Fixed in v1.7.0:** one `cardBadges(card)` helper returning the
rarity + foil + rating badges; all three render paths call it.

### P1 — `app.js` is one module with ~20 mutable globals
`sets`, `buckets`, `packs`, `flatPool`, `currentSet`, `rawCards`,
`tokenCards`, `board`, `boardMeta`, `ratings`, `revealPackIndex`,
`revealedCards`, `justMovedIds`, `currentStep`, `table3d`,
`tablePackIndex`, `selectedBoardCard` — every render function reads
these directly, so any function's behavior depends on the whole
module's state. It works, and the code is readable, but it is the
reason the reveal/table-3D integration needed a `tablePackIndex`
sentinel: two renderers sharing mutable state with no owner.

Recommendation (not done in v1.7.0 — it is a half-day refactor, not a
drive-by): split `app.js` into `state.js` (one `createState()` object
holding the globals, with `resetPool()` / `resetBoard()` transitions),
`scryfall.js` (fetch + cache), `render.js` (pool/board/reveal), and
`exports.js` (decklist/CSV/JSON/TTS). Keep `logic.js` as is. The
payoff is that `renderReveal` stops depending on 20 globals and the
3D controller gets an explicit `setPack(cards, revealed)` contract
instead of reading module state through closures.

### P2 — `showCard` builds its dialog with an IIFE inside a string
concat (`app.js`, `showCard`). The immediately-invoked function
expression that appends the 17Lands line is clever and unreadable;
extract it to a `ratingLine(card)` helper that returns `""` when
there is no rating. (Left as a recommendation; the function is
correct.)

### P2 — `download-json` duplicates the whole export shape
The deck and pool branches of the JSON export handler build the same
object twice with different fields. Extract a `buildJsonExport(cards,
board)` helper. (Left as a recommendation.)

### P2 — `copyText` falls back to `document.execCommand("copy")`
Deprecated but still the correct fallback for non-secure contexts.
Keep, but note it will warn in future Chrome versions; the primary
path (`navigator.clipboard`) is already correct.

### P2 — No `AbortController` on in-flight fetches
`openPacks` disables its own button, but nothing cancels a fetch if
the user changes set mid-load or clears the pool. The result is a
stale `flatPool` overwrite after the user has moved on. Low risk at
this scale (one user, one action at a time); worth an
`AbortController` when the fetch layer is extracted (see P1 above).

### P2 — `sw.js` is cache-first with a hand-bumped version string
`CACHE = "mtg-draft-v3"` must be bumped by hand on every release or
users keep the old shell. Cache-first also means a deployed fix does
not reach users until the new worker activates. This is the correct
trade-off for an offline-first PWA, but the version is a footgun:
derive it from `package.json` at build time, or at least add a
release-checklist line (see README). A stale-while-revalidate strategy
for `app.js`/`logic.js` would be strictly better here — the shell is
small and the site is useless without fresh logic.

### P2 — `npm test` uses `python`, which does not exist on this box
`package.json` runs `python -m unittest`, which fails on Linux
systems that only ship `python3` (this dev box included) and works on
Windows. The CI matrix (Ubuntu + Windows) passes because the runner
images provide `python`. Fix by having CI call the two runners
directly, or add a tiny `scripts/test.mjs` that spawns `python3` with
a `python` fallback. Documented here, not changed: the current
command is correct on CI and the failure mode is a loud one.

### What is good (keep it)
- `logic.js` is pure and fully tested; the `booster`-flag 10% rule and
  the `foilCopy` rename are both documented with the live-check date.
- Error handling in the fetch layer is honest: 429 gets a plain
  message, token failure degrades to a pool-only TTS export, a full
  `localStorage` quota never breaks opening packs (every write is in
  `try/catch`).
- `escapeHtml` is applied consistently to every interpolated card
  field. No `innerHTML` sink takes unescaped user input except
  `set-info`, which escapes its parts (see §2).

---

## 2. Commenting & in-code documentation

### P1 — `logic.js` had no JSDoc on any export
The file has good *section* comments and excellent *why* comments on
the two hard-won behaviors (the `booster` flag, `foilCopy`), but none
of its ~40 exported functions carried a docstring: a new contributor
reading `buildPlayBooster` or `deserializeBoard` gets no contract for
parameters, return shape, or edge cases without reading the body.

**Fixed in v1.7.0:** JSDoc added to every exported function in
`logic.js` — `@param`, `@returns`, and the non-obvious contract
(empty buckets, fallback behavior, the `foilCopy` distinction).
`app.js` and `table3d.js` keep their existing section comments; they
are adequate because those files are wiring, not reusable API.

### P1 — Duplicated, then stale, comment on `applyFoil`
The comment above `applyFoil` (`logic.js`) contained the same
sentence twice — "and the foil replaces a common" — with the
`foilCopy` explanation wedged between the two copies. It reads like a
bad merge, and it is the kind of thing a reviewer flags as
"did anyone read this file end to end?"

**Fixed in v1.7.0:** comment rewritten as one paragraph.

### P1 — Stale comment on `partitionPool`
The header comment still said the booster flag is skipped "when that
flag is present" and that "basic lands still pass: theirs is true."
Both claims predate the v1.5.1 10% rule. A stale comment is worse
than no comment: it actively misleads the next person to touch the
filter.

**Fixed in v1.7.0:** header rewritten to describe the 10% rule and
its live-check date.

### P2 — `updateSetInfo` hides an inline style in a template string
`style="width:20px;height:20px;vertical-align:-4px"` for the set icon
lives inside a JS template literal in `app.js`. Inline styles in JS
are invisible to a CSS review and cannot be themed.

**Fixed in v1.7.0:** `.set-icon` class in `styles.css`, used by
`updateSetInfo`.

### P2 — Duplicated dark-theme variables in `styles.css`
The dark color variables were written twice: once in
`@media (prefers-color-scheme: dark)` on `:root`, once in
`[data-bs-theme="dark"]`. The second rule is the one that matters —
the pre-paint script in `index.html` already sets `data-bs-theme`
from `prefers-color-scheme` when no theme is stored — so the media
query was dead weight that could drift from the real rule.

**Fixed in v1.7.0:** the `@media` block is deleted; the
`[data-bs-theme="dark"]` rule is the single source of dark variables.

### What is good (keep it)
- The `foilCopy` comment, the 17Lands endpoint comment (with the
  live-check date and the "do not invent numbers" rule), and the TTS
  format comment are exactly the kind of *why* documentation this
  codebase needs more of. The JSDoc added in v1.7.0 follows that
  standard: contract first, history second.

---

## 3. Future-proofing & architecture

### The one structural risk: `app.js` owns everything
Fetching, caching, state, three renderers, the board, exports, and
all event wiring live in one file. It is ~1,000 lines and every new
feature (the 3D table was the latest) lands in the same module. The
concrete cost is already visible: `renderReveal` must keep the 2D
grid and the 3D controller in sync through a shared mutable
`revealedCards` set and a `tablePackIndex` sentinel, and `renderPool`
rebuilds the entire grid (`innerHTML = ""`) on every keystroke in the
search box — 90 cards, images included, re-created per keystroke.
At this scale it is fast enough (images come from cache), but it is
the first thing that will feel slow on a phone, and it loses scroll
position in the grid.

Recommendations, in order:
1. **Extract the fetch/cache layer** (`scryfall.js`): `fetchAllPages`,
   `fetchTokens`, `readCache`/`writeCache`, the 17Lands fetch. Pure
   functions of `(code) -> cards`, with the rate-limit constants in
   one place. This is the smallest split and it removes the duplicated
   429 handling.
2. **One state object** (`state.js`): replace the ~20 globals with a
   single `state` and explicit transitions (`openPacks`,
   `clearPool`). Renderers receive the state they need as arguments.
3. **Keyed rendering for the pool**: update changed cards instead of
   `innerHTML = ""` on every filter keystroke, or at least debounce
   the search input (150ms) — a one-line win.
4. **Config object for pack recipes**: the Play Booster and Draft
   Booster recipes are already functions; the next step is a data
   table (`{ era, packSize, mythicRate, slots }`) so a future
   per-set template (MTGJSON) plugs in without a new function per
   recipe. Do not build this until a second recipe exists — YAGNI.

### Hardcoded values worth naming (done)
- `550`ms Scryfall gap, `175` page size, `70` collection batch,
  `24h` TTL (already `CACHE_TTL_MS`), `1/8` and `1/7` mythic rates
  (now `MYTHIC_RATE_DRAFT` / `MYTHIC_RATE_PLAY`), wildcard
  distribution (now `WILDCARD_DIST` table in `logic.js`).
- The `10%` booster-flag threshold in `partitionPool` is now the
  named constant `BOOSTER_FLAG_MIN_SHARE`.
- Remaining: `36` max packs and `20–100` board-target clamp are
  literals in `app.js`/`index.html`. Harmless; name them if the
  limits ever become user-facing settings.

### Test coverage gap: `app.js` and `table3d.js` are untested
The Node suite covers `logic.js` thoroughly, and the Python suite
covers static wiring (ids present, shell files cached, vendor files
shipped). Nothing tests DOM behavior: step locking, badge updates,
board drag-and-drop, or the 3D fallback. The honest reason is that
this repo has no DOM test harness (no jsdom, no Playwright), and
adding one is a real dependency decision. Recommendation: add
Playwright with one smoke test (open Bloomburrow, 3 packs, seed
`friday-night`, assert 42 cards and the pool step visible) when the
first DOM regression appears — not before. The static tests are the
right weight for now.

### Upgrade paths that are already safe
- **three.js**: vendored `0.182.0` with the module-shim + core pair
  and a static test asserting the import. Upgrading is
  `npm pack three@<version>` + re-run tests.
- **AdminLTE/Bootstrap**: vendored, no CDN. Upgrading is a file
  swap; the Pages workflow already copies the whole `assets/vendor/`
  tree.
- **Scryfall API**: all calls go through `fetchAllPages` /
  `fetchTokens`, so a base-URL or auth change is one edit — except
  the 17Lands URL, which is built inline in `fetchRatings`. Move it
  next to `API` when the fetch layer is extracted.

---

## 4. README modernization

The old README was a changelog wearing a README's name: it opened
with a feature list ordered by version number, buried setup under a
"Play it" heading, documented a first-time push flow that no longer
applies (the repo exists and is four versions ahead of that text),
and still claimed "Modern Play Boosters are not modelled yet" in the
limits section after v1.6.0 modelled them. The stale lines were the
worst part: a new contributor could not tell what was true.

**Rewritten in v1.7.0** with the requested structure — Description,
Prerequisites, Installation, Local Development, Deployment — plus a
short How it works and a Changelog that keeps the version history
out of the feature description. See `README.md`.

---

## 5. Visual asset strategy

The repo currently ships zero screenshots. For a portfolio project
whose entire value is visible — cards on a table, a deck taking
shape — that is the biggest cheap win available. Do **not** mock
these: every asset below must be a real capture from the live site
after the push, at desktop width (1440×900, device pixel ratio 1).
Record them with the same seed (`friday-night`, Bloomburrow, 3 packs)
so the cards in every shot match each other.

| # | Asset | Depicts | Placed in README |
|---|-------|---------|------------------|
| 1 | `docs/screenshots/pool-grouped.png` | The Pool step, grouped-by-color view, with the mana curve and 17Lands rating badges visible | Top of the file, directly under the description paragraph, as the hero image |
| 2 | `docs/screenshots/reveal-3d.gif` (animated, ~6s, looped) | The 3D table: a pack dealing out face-down, two cards flipping, the rare glowing gold | In the Features section, beside the Pack reveal bullet |
| 3 | `docs/screenshots/deck-builder.png` | The Deck builder step mid-build: Main Deck at ~32/40, mana curve, land counters | In the Features section, beside the Deck builder bullet |
| 4 | `docs/screenshots/tts-export.png` | The Export step with the TTS download and the proxy checkbox, plus a small inset of the same pool loaded in Tabletop Simulator | In the Features section, beside the TTS export bullet |
| 5 | `docs/architecture.svg` | Data flow, one diagram: Browser → Scryfall (sets, card search, collection) + 17Lands (ratings) → `logic.js` (pure, tested) → `app.js` (render) / `table3d.js` (three.js) → localStorage cache; deploy path GitHub Actions → Pages | In the How it works section, above the pack-recipe description |

Placement matters more than quantity: the hero screenshot is the
first thing a visitor sees, the GIF is the only motion on the page
and should sit next to the feature it demonstrates, and the
architecture diagram belongs where a contributor is trying to
understand the code, not at the top where it competes with the
product. Keep all five under `docs/` so the deploy (which copies
only site files) stays clean, and reference them with relative paths
so they render on GitHub and in a local checkout.

---

## Changelog of this review (v1.7.0)

- **Fixed:** `table3d.js` GPU resource leak (dispose on `setPack`,
  shared geometry).
- **Fixed:** duplicated magic numbers in `app.js` (named constants,
  one rate-limit error helper).
- **Fixed:** badge markup duplicated in three render paths
  (`cardBadges()` helper).
- **Fixed:** duplicated `applyFoil` comment; stale `partitionPool`
  comment; duplicated dark-theme CSS variables; inline set-icon
  style.
- **Added:** JSDoc to every exported function in `logic.js`.
- **Rewrote:** `README.md` (Description, Prerequisites,
  Installation, Local Development, Deployment, How it works,
  Changelog, visual asset plan).
- **Not changed (deliberate):** no `app.js` split, no DOM test
  harness, no `npm test` runner change — each is a real decision
  documented above, not an oversight.
