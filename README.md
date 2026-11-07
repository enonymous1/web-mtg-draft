# MTG Draft

A solo Magic: The Gathering pack opener, as a static PWA for GitHub Pages.

Pick a set, open 1, 3, or 6 packs (or any count from 1 to 36), sort and
filter your pool, then export it. No build step, no account, no tracking,
no uploads.

## Play it

- Live (after push + Pages): `https://enonymous1.github.io/web-mtg-draft/`
- Locally: from the project folder, run a static server, then open the
  address it prints. Do not open it with `file://`, because the app
  fetches from Scryfall:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## How packs are built

Scryfall has no booster endpoint, so the app simulates the pack in your
browser:

1. It fetches the set once from Scryfall (`/cards/search` with
   `e:<code>` and `unique=prints`, paged at 175 cards per page) and
   caches that pool in your browser for 24 hours. Scryfall card
   endpoints allow 2 requests per second, so the first load of a set
   pauses 550ms between pages.
2. It splits the pool into common, uncommon, rare, mythic, basic land,
   and common land buckets. Tokens, bonus/special sheets, and printings
   Scryfall flags as not appearing in boosters are excluded, and
   duplicate arts of one card are deduplicated by name + rarity.
3. Each classic draft pack deals 1 rare or mythic (mythic about 1 in 8),
   3 uncommons, 10 commons, and 1 land, without replacement inside the
   pack. Copies can repeat across packs, as in real sealed.
4. Sorting and filtering run locally on cards you already have. No new
   request is made when you change a sort or filter.

A seed makes packs reproducible: the same set, pack count, and seed
always deal the same packs, and the share link encodes all three in the
URL hash. An empty seed means truly random.

## Sort, filter, export

- Sort by pack order, name, rarity, mana value, color, type, price
  (high to low), draft rating (17Lands), or collector number.
- Filter by name/type/rules text, rarity, color (including multicolor
  and colorless), and type.
- View as card images, a list, or grouped by color. Click any card for
  a large image, oracle text, price, 17Lands rating, and a Scryfall link.
  The pool itself shows a mana curve and color breakdown, like the board.
- Pack reveal (v1.3.0): packs open one at a time, cards face-down,
  rare last. Click to flip, or press Space for the next card, N for the
  next pack, A to reveal all. Skip to pool any time.
- Draft ratings (v1.3.0): 17Lands Premier Draft data — games-in-hand
  win rate, average last seen, improvement over baseline — fetched live
  per set and cached 24 hours. 17Lands only publishes live ratings for
  the current draft format, so older sets show no ratings rather than
  guessed numbers. Each card shows a grade (A–F) and its GIH WR.
- Foil slot (v1.3.0): about 1 pack in 3 has a foil, which replaces a
  common. This is a documented approximation, not a per-set MTGJSON
  booster template — MTGJSON's full file is too large to fetch on a
  static page, and TCGplayer/CardMarket pricing was not added because
  Scryfall's USD price already comes from TCGplayer.
- Board bulk moves (v1.3.0): add all creatures, or all cards of one
  color, from the pool to the Main Deck in one click.
- Recent sets fixed (v1.5.1): Scryfall stopped setting `booster: true`
  for sets from TMT (Mar 2026) onward — every card in TMT, SOS, MSH,
  HOB, FRA, and TRK is `booster: false`, so the old filter emptied
  those pools entirely. The filter now applies only when at least 10%
  of a set's eligible cards carry the flag; otherwise it is ignored
  for that set. Bloomburrow's pool is byte-identical to before the
  fix (79/100/60/20/5/2). Also fixed: the draftable set-type list
  spelled it `draftinnovation`; Scryfall spells it
  `draft_innovation`, so Mystery Booster sets never appeared.
  ScrollVault's sealed tool does not hit this because it serves
  pre-cached per-set JSON from its own server (`/draft/data/<code>.json`)
  instead of filtering live Scryfall data — its `is:booster` fallback
  is broken the same way (404 for FRA). This app still fetches live
  from Scryfall, so it now works for recent sets without a server.
  Still open: real Play Booster packs are 14 cards with wildcard
  slots (this app still deals classic 15-card packs for every set).
- Panel system (v1.5.0): AdminLTE 4.10.0 + Bootstrap 5.3.8 +
  Bootstrap Icons 1.11.3, vendored under `assets/vendor/` (1.1 MB,
  MIT, no CDN — same set as workspace-monitor and
  achievement-trackers). Sidebar steps: 1. Open packs, 2. Pack reveal,
  3. Pool, 4. Deck builder, 5. Export, plus How it works. One panel
  at a time, with Next / Back buttons; steps that need a pool stay
  locked until packs are opened. Sidebar badges show the pool count
  and Main Deck vs target. Light/dark toggle in the header, saved in
  your browser (`mtg-theme`). Pack logic, ratings, TTS export, board,
  and animations are unchanged — this is a shell restyle. The Pages
  workflow copies `assets/vendor/` into the deploy, and the service
  worker caches it (cache `mtg-draft-v2`).
- Animations (v1.4.0): pure CSS keyframes, driven by JavaScript —
  not Java, which does not run in a browser. Pack reveal is a true 3D
  flip (card back rotates to the card face), cards deal in one by one
  with a stagger, flipped rares and mythics pulse gold, foils shimmer,
  pool cards fade in staggered when you sort or change view, a dragged
  board card lifts and tilts, the drop zone pulses, and a card you just
  moved pops into its new column. `prefers-reduced-motion` turns all
  of it off.
- Export: copy a decklist (`count name` per line), or download
  `.txt` (count, name, set, collector number), `.csv` (count, name,
  set, number, rarity, type, mana value, colors, mana cost, price),
  or `.json` (the full pool plus the aggregated list).
- Tabletop Simulator export (v1.1.0): **Download TTS .json** writes a
  TTS Saved Object — a bag holding a Pool deck, a Tokens deck, and a
  Basic Lands pack (4 of each basic land in the set, 20 cards when all
  five are present). It uses per-card decks, not a 10x7 sprite sheet:
  each card gets its own `FaceURL`, `DeckIDs` run 100, 200, 300, …,
  and each `CustomDeck` key matches the hundredth place of its
  `CardID`, as in the TTS save-file format. Double-faced cards get
  `UniqueBack` with the back face as the back image, so they flip in
  game. Tokens are fetched for the cards in your pool via Scryfall's
  batched `POST /cards/collection` (70 per batch) and cached for 24
  hours; if that fetch fails, the export still works without tokens.
  To load it, copy the file to
  `Documents/My Games/Tabletop Simulator/Saves/Saved Objects`, then in
  game go to Objects &gt; Saved Objects. The image proxy checkbox is on
  by default: it re-serves Scryfall faces through wsrv.nl as JPEG,
  because TTS's Unity player has repeatedly failed to load direct
  Scryfall / WebP images. Turn it off for direct Scryfall URLs.

## Files

- `index.html`, `styles.css` — the page
- `app.js` — Scryfall fetching, caching, rendering, and exports
- `logic.js` — DOM-free pack logic (seeded shuffle, dealing, sorting,
  filtering, export formats), tested by Node without a browser
- `sw.js`, `manifest.webmanifest`, `icons/` — offline PWA shell
- `tests/` — Node logic tests and Python static checks

## Tests

```sh
node --test tests/test_logic.mjs
python -m unittest discover -s tests -p "test_*.py" -v
# or both at once:
npm test
```

CI runs the same checks on Ubuntu and Windows. The Pages workflow runs
them first, then deploys only the site files.

## Push it (first time)

Create an **empty public** repo named `web-mtg-draft` under `enonymous1`,
extract the push zip to an empty folder, then:

```sh
git remote add origin https://github.com/enonymous1/web-mtg-draft.git
git push -u origin main
```

Then one time only: Settings → Pages → Source: **GitHub Actions**.
The site will be at `https://enonymous1.github.io/web-mtg-draft/`.

Description/topics draft (apply on GitHub after push, they do not travel
in a push): "Solo Magic draft pack opener for GitHub Pages, powered by
Scryfall" — topics: `magic-the-gathering`, `mtg`, `draft`, `booster`,
`scryfall`, `github-pages`, `static-site`, `pwa`, `vanilla-js`.

## Notes and limits

- Pack reveal + 17Lands + foil (v1.3.0): see Sort, filter, export above.
  Live-checked 2026-11-07: the 17Lands card-ratings endpoint returns
  JSON with `Access-Control-Allow-Origin: *`, and the current format
  (FRA) has 218 cards with 100+ games; BLB, DSK, TDM, and FIN return
  no games even with historical date ranges, which is why ratings are
  unavailable for older sets.
- Deck builder (v1.2.0): after opening packs, a board with Pool,
  Main Deck, Sideboard, and Maybeboard columns. Drag cards between
  columns, or open a card and use its Move to buttons. Main Deck shows
  a live count against a target (40 by default, changeable), a mana
  curve, and a color breakdown. Basic lands are unlimited in limited,
  so add them by count with the +/− buttons instead of dragging them.
  The board is saved in your browser for that set, pack count, and
  seed. Once you start building, all exports (decklist, .txt, .csv,
  .json, TTS) describe the Main Deck + Sideboard plus added lands;
  otherwise they export the whole pool as before.
- v1.1.0 adds the TTS export only; the opener itself is unchanged.
  The TTS format was checked against the TTS save-file format and a
  live booster JSON from joshbirnholz's tts-magic-booster service, but
  it has not yet been loaded in Tabletop Simulator itself — that is
  still a his-side check after push.
- This is v1: solo opener and sealed pool generator only. Pick-one
  drafting against bots is a later step, and live multiplayer would
  need a server, so it is out of scope for a Pages site.
- Modern Play Boosters (14 cards, wildcard slots) are not modelled yet.
  V1 uses the classic 15-card draft recipe for every set.
- Prices are Scryfall USD where listed, summed for the pool, and are a
  rough guide, not a buy/sell quote.
- Unofficial fan project, not affiliated with or endorsed by Wizards
  of the Coast. Card data and images from Scryfall. Magic: The
  Gathering is a trademark of Wizards of the Coast.
