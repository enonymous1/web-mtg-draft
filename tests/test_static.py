"""Static checks for the MTG Draft PWA: files, manifest, and UI wiring.

Uses pathlib objects directly (never rendered path strings) so the
same checks pass on Ubuntu and Windows CI runners.

Scryfall is the one allowed external origin: the app fetches card data
from api.scryfall.com at runtime and links out to scryfall.com. No CDN
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
                        "scryfall.com" in url or "example.invalid" in url,
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
        for name in ("index.html", "styles.css", "app.js", "logic.js", "manifest.webmanifest"):
            self.assertIn(name, sw, name)

    def test_index_wires_the_opener_controls(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        for element_id in (
            "set-search", "set-select", "set-info", "pack-count", "seed",
            "random-seed", "open-packs", "clear-pool", "share-link", "status",
            "results", "pool-stats", "filter-query", "filter-rarity",
            "filter-color", "filter-type", "sort-select", "view-select",
            "copy-decklist", "download-txt", "download-csv", "download-json",
            "pool-grid", "card-dialog", "card-detail",
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
        self.assertIn("serviceWorker", app)
        self.assertIn("sw.js", app)


if __name__ == "__main__":
    unittest.main()
