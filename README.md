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
  (high to low), or collector number.
- Filter by name/type/rules text, rarity, color (including multicolor
  and colorless), and type.
- View as card images or as a list. Click any card for a large image,
  oracle text, price, and a Scryfall link.
- Export: copy a decklist (`count name` per line), or download
  `.txt` (count, name, set, collector number), `.csv` (count, name,
  set, number, rarity, type, mana value, colors, mana cost, price),
  or `.json` (the full pool plus the aggregated list).

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
