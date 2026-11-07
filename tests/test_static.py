"""Static checks for the MTG Draft PWA: files, manifest, and UI wiring.

Uses pathlib objects directly (never rendered path strings) so the
same checks pass on Ubuntu and Windows CI runners.

Scryfall is the main allowed external origin: the app fetches card data
from api.scryfall.com at runtime and links out to scryfall.com. The TTS
export also references the Scryfall card-back host backs.scryfall.io and
the wsrv.nl image proxy (JPEG re-serving for Tabletop Simulator). Ratings
come from 17lands.com/card_ratings/data (Premier Draft, GIH WR). No CDN
code is loaded.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestStaticSite(unittest.TestCase):
    def test_required_files_exist(self):
        required = [
            Path("index.html"),
            Path("styles.css"),
            Path("app.js"),
            Path("logic.js"),
            Path("sw.js"),
            Path("manifest.webmanifest"),
            Path("icons") / "icon-192.png",
            Path("icons") / "icon-512.png",
            Path("LICENSE"),
            Path("README.md"),
            Path("assets") / "vendor" / "adminlte.min.css",
            Path("assets") / "vendor" / "adminlte.min.js",
            Path("assets") / "vendor" / "bootstrap.min.css",
            Path("assets") / "vendor" / "bootstrap.bundle.min.js",
            Path("assets") / "vendor" / "bootstrap-icons.min.css",
            Path("assets") / "vendor" / "THIRD_PARTY_NOTICES.md",
            Path("assets") / "vendor" / "three" / "three.module.min.js",
            Path("assets") / "vendor" / "three" / "three.core.min.js",
            Path("assets") / "vendor" / "three" / "LICENSE",
            Path("table3d.js"),
        ]
        for rel in required:
            with self.subTest(rel=rel):
                self.assertTrue((ROOT / rel).is_file(), rel)

    def test_no_cdn_code_is_loaded(self):
        for name in ("index.html", "styles.css", "app.js", "logic.js"):
            text = (ROOT / name).read_text(encoding="utf-8")
            urls = re.findall(r"https://[^\s\"'<>]+", text)
            for url in urls:
                with self.subTest(name=name, url=url):
                    self.assertTrue(
                        "scryfall.com" in url
                        or "scryfall.io" in url
                        or "wsrv.nl" in url
                        or "17lands.com" in url
                        or "example.invalid" in url,
                        f"unexpected external URL in {name}: {url}",
                    )

    def test_manifest_is_valid_and_matches_icons(self):
        manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "MTG Draft")
        self.assertEqual(manifest["start_url"], ".")
        for icon in manifest["icons"]:
            self.assertTrue((ROOT / icon["src"]).is_file(), icon["src"])

    def test_service_worker_caches_every_shell_file(self):
        sw = (ROOT / "sw.js").read_text(encoding="utf-8")
        for name in ("index.html", "styles.css", "app.js", "logic.js", "table3d.js", "manifest.webmanifest",
                     "assets/vendor/adminlte.min.css", "assets/vendor/adminlte.min.js",
                     "assets/vendor/bootstrap.min.css", "assets/vendor/bootstrap.bundle.min.js",
                     "assets/vendor/three/three.module.min.js", "assets/vendor/three/three.core.min.js"):
            self.assertIn(name, sw, name)

    def test_pages_workflow_deploys_vendor_assets(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("assets/vendor", workflow)
        self.assertIn("dist/assets/vendor", workflow)
        self.assertIn("dist/assets/vendor/three", workflow)

    def test_three_module_imports_its_vendored_core(self):
        # three 0.182.0 ships three.module.min.js as a shim over
        # three.core.min.js; shipping only the module would break the scene.
        module = (ROOT / "assets" / "vendor" / "three" / "three.module.min.js").read_text(encoding="utf-8")
        self.assertIn("./three.core.min.js", module)

    def test_review_fixes_are_present(self):
        # Staff review v1.7.0: named Scryfall constants, one rate-limit
        # error helper, one cardBadges helper, no duplicated badge string.
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        for name in ("SCRYFALL_REQUEST_GAP_MS", "SCRYFALL_PAGE_SIZE",
                     "SCRYFALL_COLLECTION_BATCH_SIZE", "rateLimitError", "cardBadges"):
            self.assertIn(name, app, name)
        self.assertNotIn("sleep(550)", app)
        self.assertNotIn("i + 70", app)
        # table3d disposes GPU resources on pack change (the v1.6.0 leak).
        table3d = (ROOT / "table3d.js").read_text(encoding="utf-8")
        self.assertIn("disposeCard(entry)", table3d)
        self.assertIn("cardGeometry.dispose()", table3d)
        # Dark theme variables live in one place only: no separate
        # prefers-color-scheme media block duplicating them.
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn("@media (prefers-color-scheme", styles)
        self.assertIn(".set-icon", styles)
        # logic.js exports carry JSDoc.
        logic = (ROOT / "logic.js").read_text(encoding="utf-8")
        exports = re.findall(r"export function (\w+)", logic)
        for name in exports:
            self.assertRegex(logic, re.compile(r"/\*\*.*?@param.*?\*/\s*export function " + name, re.S), name)

    def test_readme_has_the_required_sections(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for heading in ("## Description", "## Prerequisites", "## Installation",
                        "## Local Development", "## Deployment", "## How it works",
                        "## Changelog", "## Visual assets"):
            self.assertIn(heading, readme, heading)
        # No stale claims: Play Boosters are modelled since v1.6.0.
        self.assertNotIn("are not modelled yet", readme)
        self.assertNotIn("still deals classic 15-card packs for every set", readme)

    def test_reveal_step_has_the_3d_table_container(self):
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="table3d"', index)
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("createTable", app)
        self.assertIn("webglSupported", app)
        self.assertIn("prefersReducedMotion", app)

    def test_index_wires_the_opener_controls(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        for element_id in (
            "set-search", "set-select", "set-info", "pack-count", "seed",
            "random-seed", "open-packs", "clear-pool", "share-link", "status",
            "results", "pool-stats", "filter-query", "filter-rarity",
            "filter-color", "filter-type", "sort-select", "view-select",
            "copy-decklist", "download-txt", "download-csv", "download-json",
            "download-tts", "tts-proxy",
            "pool-grid", "card-dialog", "card-detail",
            "pack-reveal", "reveal-progress", "reveal-grid",
            "reveal-all", "reveal-next-pack", "reveal-skip",
            "ratings-status", "pool-curve", "pool-colors",
            "step-open", "step-reveal", "step-pool", "step-board",
            "step-export", "step-how", "step-title", "step-subtitle",
            "theme-toggle", "badge-pool", "badge-board",
            "board-section", "board-status", "board-target", "board-sort",
            "board-reset", "bulk-creatures", "bulk-color", "bulk-color-add",
            "board-curve", "board-colors",
            "board-pool", "board-main", "board-sideboard", "board-maybe",
            "board-count-pool", "board-count-main", "board-count-sideboard",
            "board-count-maybe", "card-move",
            "land-count-Plains", "land-count-Island", "land-count-Swamp",
            "land-count-Mountain", "land-count-Forest",
        ):
            self.assertIn(f'id="{element_id}"', html, element_id)

    def test_workflows_exist(self):
        for name in ("ci.yml", "pages.yml"):
            self.assertTrue((ROOT / ".github" / "workflows" / name).is_file(), name)

    def test_app_uses_scryfall_and_the_shared_logic(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("api.scryfall.com", app)
        self.assertIn("partitionPool", app)
        self.assertIn("buildPacks", app)
        self.assertIn("formatCSV", app)
        self.assertIn("buildTTSSavedObject", app)
        self.assertIn("fetchTokens", app)
        self.assertIn("/cards/collection", app)
        self.assertIn("createBoard", app)
        self.assertIn("moveCard", app)
        self.assertIn("moveAll", app)
        self.assertIn("fetchRatings", app)
        self.assertIn("17lands.com/card_ratings/data", app)
        self.assertIn("renderReveal", app)
        self.assertIn("groupPoolByColor", app)
        self.assertIn("showStep", app)
        self.assertIn("updateStepBadges", app)
        self.assertIn("applyTheme", app)
        self.assertIn("renderBoard", app)
        self.assertIn("flip-inner", app)
        self.assertIn("justMovedIds", app)
        self.assertIn("anim-in", app)
        self.assertIn("boardDecklist", app)
        self.assertIn("serviceWorker", app)
        self.assertIn("sw.js", app)

    def test_animations_are_css_keyframes_with_reduced_motion(self):
        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        for keyframe in ("deal-in", "fade-in", "pop-in", "rare-glow", "foil-shimmer", "drag-pulse"):
            self.assertIn(f"@keyframes {keyframe}", css, keyframe)
        self.assertIn("prefers-reduced-motion", css)
        self.assertIn("rotateY(180deg)", css)


if __name__ == "__main__":
    unittest.main()
