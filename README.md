# MTG Draft

A solo Magic: The Gathering pack opener, as a static PWA for GitHub
Pages. Pick a set, open packs, sort and filter your pool, build a
40-card deck, and export it — to a decklist, CSV, JSON, or a
Tabletop Simulator Saved Object.

No build step, no account, no tracking, no uploads, no server. All
pack math runs in your browser against live Scryfall data.

Live: `https://enonymous1.github.io/web-mtg-draft/`

<!-- Hero screenshot (planned — see Visual assets below):
     docs/screenshots/pool-grouped.png — the Pool step, grouped by
     color, with the mana curve and 17Lands rating badges visible. -->

## Description

MTG Draft simulates opening sealed product for one player:

- **Open packs** — 1, 3, or 6 packs by preset, or any count from 1 to
  36. A seed makes packs reproducible: the same set, pack count, and
  seed always deal the same packs, and the share link encodes all
  three in the URL hash. An empty seed means truly random.
- **Pack reveal** — packs open one at a time, cards face-down, rare
  last. On a WebGL-capable browser the reveal is a 3D table (three.js,
  vendored): cards deal onto felt, click or Space flips them, flipped
  rares glow gold. Without WebGL, or with reduced motion, the 2D
  grid is used instead. Space flips the next card, N is the next pack,
  A reveals all, Skip jumps to the pool.
- **Pool** — sort by name, mana value, rarity, color, type, price,
  pack order, collector number, or 17Lands draft rating; filter by
  name/type/rules text, rarity, color, and type; view as card images,
  a list, or grouped by color. Click any card for a large image,
  oracle text, price, 17Lands rating, and a Scryfall link. The pool
  shows a mana curve, a color breakdown, and a rough USD value.
- **Deck builder** — Pool / Main Deck / Sideboard / Maybeboard
  columns with drag-and-drop and Move-to buttons. Main Deck target
  defaults to 40 (changeable, 20–100), with a live mana curve and
  color breakdown. Basic lands are unlimited in limited play, so they
  are added by count instead of dragged. The board is saved in your
  browser for that set, pack count, and seed, and bulk moves add all
  creatures or all cards of one color to the Main Deck in one click.
- **Export** — copy a decklist, or download `.txt`, `.csv`, or
  `.json`. Once you start building, exports describe the Main Deck +
  Sideboard plus added lands; otherwise they export the whole pool.
  **Tabletop Simulator export** writes a TTS Saved Object — a bag
  holding a Pool deck, a Tokens deck, and a Basic Lands pack (4 of
  each basic land in the set, 20 cards when all five are present).
  Double-faced cards get `UniqueBack` with the back face, so they
  flip in game. An image-proxy checkbox (on by default) re-serves
  Scryfall faces through wsrv.nl as JPEG, because TTS's Unity player
  has repeatedly failed to load direct Scryfall / WebP images.

<!-- Animated GIF (planned — see Visual assets below):
     docs/screenshots/reveal-3d.gif — the 3D table dealing a pack
     face-down, two cards flipping, the rare glowing gold. Place it
     here, beside the Pack reveal bullet above. -->

<!-- Screenshot (planned — see Visual assets below):
     docs/screenshots/deck-builder.png — the Deck builder step
     mid-build, Main Deck ~32/40, mana curve, land counters. Place it
     beside the Deck builder bullet above. -->

<!-- Screenshot (planned — see Visual assets below):
     docs/screenshots/tts-export.png — the Export step with the TTS
     download and proxy checkbox, plus an inset of the pool loaded in
     Tabletop Simulator. Place it beside the Export bullet above. -->

## Prerequisites

- A modern browser (Chrome, Firefox, Safari, Edge). WebGL is needed
  for the 3D reveal table; everything else works without it.
- To run it locally: Python 3 (for the one-line static server) or
  any other static file server. Node.js 18+ to run the tests.
- No API keys, no accounts, no install step. The app fetches card
  data from Scryfall and draft ratings from 17Lands at runtime.

## Installation

There is nothing to install to use it — open the live site above.

To get the code:

```sh
git clone https://github.com/enonymous1/web-mtg-draft.git
cd web-mtg-draft
```

No dependencies, no `npm install`, no build step. Third-party code
is vendored under `assets/vendor/` (AdminLTE 4.10.0, Bootstrap
5.3.8, Bootstrap Icons 1.11.3, three.js 0.182.0), all MIT, no CDN.
See `assets/vendor/THIRD_PARTY_NOTICES.md` for the licenses.

## Local Development

Do **not** open the page with `file://` — the app fetches from
Scryfall, and module scripts and the service worker need HTTP.

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

### Tests

```sh
node --test tests/test_logic.mjs
python -m unittest discover -s tests -p "test_*.py" -v
# or both at once:
npm test
```

`tests/test_logic.mjs` covers the pack logic in `logic.js` (seeded
shuffle, Draft/Play Booster recipes, sorting, filtering, board,
TTS export) in Node, no browser needed. `tests/test_static.py`
checks the static wiring: required files exist, no CDN code is
loaded, the service worker caches every shell file, the Pages
workflow deploys the vendor tree, and the three.js module imports
its vendored core. CI runs the same checks on Ubuntu and Windows.

### Project layout

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | The page and its styles (AdminLTE shell, step panels) |
| `app.js` | Scryfall fetching, 24-hour caching, rendering, exports, wiring |
| `logic.js` | DOM-free pack logic (seeded shuffle, dealing, sorting, filtering, board, TTS) — JSDoc'd, Node-tested |
| `table3d.js` | The 3D opening table (vendored three.js, no physics engine) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline PWA shell |
| `tests/` | Node logic tests and Python static checks |
| `REVIEW.md` | Staff review of v1.6.0 (findings, fixes, architecture notes) |

### Making a release

1. Bump the version in `package.json`.
2. Bump the service-worker cache name in `sw.js` (currently
   `mtg-draft-v4`) — otherwise users keep the old shell.
3. Run the tests, then package from the push folder (see Deployment).
4. Update the Changelog below.

## Deployment

The site deploys to GitHub Pages via GitHub Actions
(`.github/workflows/pages.yml`): on push to `main`, the workflow
runs the tests, then deploys only the site files (the `docs/`
folder with screenshots and the review is not deployed).

One-time setup, after the repo exists: Settings → Pages → Source:
**GitHub Actions**. The site is then at
`https://enonymous1.github.io/web-mtg-draft/`.

To push a release from the push zip: extract it to an **empty**
folder, then:

```sh
cd web-mtg-draft
git push origin main
```

No remote add, no force — the push folder carries the full history
and the remote is already set. The workflow runs the tests again
before deploying.

Repo description/topics draft (apply on GitHub, they do not travel
in a push): "Solo Magic draft pack opener for GitHub Pages, powered
by Scryfall" — topics: `magic-the-gathering`, `mtg`, `draft`,
`booster`, `scryfall`, `github-pages`, `static-site`, `pwa`,
`vanilla-js`.

## How it works

Scryfall has no booster endpoint, so the app simulates the pack in
your browser:

<!-- Architecture diagram (planned — see Visual assets below):
     docs/architecture.svg — data flow: Browser → Scryfall (sets,
     card search, collection) + 17Lands (ratings) → logic.js (pure,
     tested) → app.js (render) / table3d.js (three.js) → localStorage
     cache; deploy path GitHub Actions → Pages. Place it here, above
     the pack-recipe description. -->

1. It fetches the set once from Scryfall (`/cards/search` with
   `e:<code>` and `unique=prints`, paged at 175 cards per page) and
   caches that pool in your browser for 24 hours. Scryfall card
   endpoints allow 2 requests per second, so the first load of a set
   pauses 550ms between pages.
2. It splits the pool into common, uncommon, rare, mythic, basic
   land, and common land buckets. Tokens, bonus/special sheets, and
   duplicate arts of one card (deduplicated by name + rarity) are
   excluded. The `booster` flag is applied only when at least 10% of
   a set's eligible cards carry it — Scryfall stopped setting it for
   sets from TMT (Mar 2026) onward, where applying it would empty
   the whole pool (Bloomburrow's pool is byte-identical to before
   the fix).
3. Each pack is dealt without replacement inside the pack; copies
   can repeat across packs, as in real sealed.
   - **Draft Booster** (sets released before 2024-02-09): 15 cards —
     1 rare/mythic (mythic 1 in 8), 3 uncommons, 10 commons, 1 land,
     plus a foil slot in about 1 pack in 3, replacing a common.
   - **Play Booster** (Murders at Karlov Manor, 2024-02-09, onward):
     14 cards — 1 rare/mythic (mythic 1 in 7), 3 uncommons, 7
     commons (one in the List / Special Guest slot, treated as a
     plain common), 2 wildcards of any rarity (common 62.5% /
     uncommon 27.5% / rare 8.75% / mythic 1.25%; one foil, one
     non-foil), 1 land.
4. Sorting and filtering run locally on cards you already have. No
   new request is made when you change a sort or filter.
5. **17Lands ratings** are fetched live per set and cached 24 hours:
   games-in-hand win rate, average last seen, improvement over
   baseline, graded A–F. 17Lands only publishes live ratings for the
   current draft format, so older sets show no ratings rather than
   guessed numbers. Historical data lives in 17Lands' bulk public
   datasets (tens of MB of game logs) — not fetchable on a static
   page.

## Visual assets

The repo currently ships no screenshots. These five are planned, and
must be **real captures from the live site after a push** — never
mocked. Record them all with the same seed (`friday-night`,
Bloomburrow, 3 packs) so the cards match across shots, at desktop
width (1440×900, device pixel ratio 1):

1. `docs/screenshots/pool-grouped.png` — the Pool step, grouped by
   color, mana curve and 17Lands badges visible. Placed at the top
   of this README, under the description paragraph, as the hero
   image.
2. `docs/screenshots/reveal-3d.gif` — animated, ~6s, looped: the 3D
   table dealing a pack face-down, two cards flipping, the rare
   glowing gold. Placed beside the Pack reveal bullet.
3. `docs/screenshots/deck-builder.png` — the Deck builder step
   mid-build: Main Deck ~32/40, mana curve, land counters. Placed
   beside the Deck builder bullet.
4. `docs/screenshots/tts-export.png` — the Export step with the TTS
   download and proxy checkbox, plus an inset of the same pool
   loaded in Tabletop Simulator. Placed beside the Export bullet.
5. `docs/architecture.svg` — one data-flow diagram (see How it
   works). Placed above the pack-recipe description.

Keep all five under `docs/` so the deploy (which copies only site
files) stays clean, and reference them with relative paths so they
render on GitHub and in a local checkout.

## Changelog

- **v1.7.0 (2026-11-07)** — Staff review of v1.6.0 (`REVIEW.md`):
  fixed the 3D table's GPU resource leak (dispose on `setPack`,
  shared geometry), named the duplicated Scryfall constants
  (request gap, page size, collection batch) with one rate-limit
  error helper, one `cardBadges()` helper for the three render
  paths, JSDoc on every exported function in `logic.js`, fixed a
  duplicated `applyFoil` comment and a stale `partitionPool`
  comment, removed the duplicated dark-theme CSS variables, moved
  the set icon's inline style to a class. README rewritten.
- **v1.6.0 (2026-11-07)** — Play Booster recipe (14-card packs for
  sets from MKM onward, wildcards, 1-in-7 mythic) and the 3D opening
  table (three.js 0.182.0 vendored, 2D grid fallback). Fixed along
  the way: Scryfall's `foil` field means "available in foil" (true
  for nearly every card) and was being read as "this copy is foil" —
  the marker is now `foilCopy`.
- **v1.5.1 (2026-11-07)** — Recent sets fixed: Scryfall stopped
  setting `booster: true` for sets from TMT onward, so the old
  filter emptied those pools; the filter now applies only when at
  least 10% of a set's eligible cards carry the flag. Also fixed
  `draftinnovation` → `draft_innovation` (Mystery Booster sets were
  invisible).
- **v1.5.0 (2026-11-07)** — AdminLTE panel system: sidebar steps
  (Open packs, Pack reveal, Pool, Deck builder, Export, How it
  works), one panel at a time, steps needing a pool locked until
  packs are opened, sidebar badges, light/dark toggle.
- **v1.4.0 (2026-11-07)** — Animations: pure CSS keyframes driven
  by JavaScript — true 3D flip on reveal, staggered deal-in, rare
  gold glow, foil shimmer, pool fade-in, board drag lift/tilt and
  just-moved pop. `prefers-reduced-motion` disables all.
- **v1.3.0 (2026-11-07)** — Pack reveal, 17Lands Premier Draft
  ratings, pool grouped by color + pool curve/colors, foil slot,
  bulk board moves, set icon.
- **v1.2.0 (2026-11-06)** — Deck-builder board.
- **v1.1.0 (2026-11-06)** — Tabletop Simulator `.json` export.
- **v1.0.0 (2026-11-06)** — Solo pack opener.

## Notes and limits

- The TTS format was checked against the TTS save-file format and a
  live booster JSON from joshbirnholz's tts-magic-booster service,
  but it has not yet been loaded in Tabletop Simulator itself — that
  is still a his-side check after push.
- Prices are Scryfall USD where listed, summed for the pool, and are
  a rough guide, not a buy/sell quote.
- This is a solo opener and sealed pool generator only. Pick-one
  drafting against bots is a later step, and live multiplayer would
  need a server, so it is out of scope for a Pages site.
- Unofficial fan project, not affiliated with or endorsed by Wizards
  of the Coast. Card data and images from Scryfall. Magic: The
  Gathering is a trademark of Wizards of the Coast.
