import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("import_hackertube", Path(__file__).with_name("import-hackertube.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ImportTests(unittest.TestCase):
    def test_filter_reimport_and_invalid_archive_preserve_existing_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database, archive = root / "observer.sqlite3", root / "data.zip"
            with sqlite3.connect(database) as db:
                db.execute("CREATE TABLE curated_feeds(id TEXT, payload TEXT)")
                db.execute("INSERT INTO curated_feeds VALUES('user','untouched')")

            def video(vid, recommenders=1, shelf="evergreen", **extra):
                return dict(vid=vid, title="A talk", channel="Speaker", score=10,
                            shelf_life=shelf, hn={"recommenders": recommenders, "stances": {"critical": 3}},
                            categories=[{"id": "software"}], **extra)

            def write(videos):
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr("hackertube-data/taxonomy.json", json.dumps({"areas": [
                        {"id": "tech", "name": "Technology", "categories": [{"id": "software", "name": "Software"}]}
                    ]}))
                    bundle.writestr("hackertube-data/videos.jsonl", "\n".join(json.dumps(v) for v in videos))
                    bundle.writestr("hackertube-data/DATA.md", "Exported 2026-10-31.")

            write([video("aaaaaaaaaaa"), video("bbbbbbbbbbb", 0), video("ccccccccccc", shelf="news"),
                   video("ddddddddddd", shelf="dated")])
            for _ in range(2):
                result = importer.import_archive(archive, database)
                self.assertEqual(result["videoCount"], 2)
                self.assertEqual(result["totalVideos"], 4)
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute("SELECT video FROM catalog_videos ORDER BY video").fetchall(),
                                 [("aaaaaaaaaaa",), ("ddddddddddd",)])
                self.assertEqual(db.execute("SELECT count(*) FROM catalog_categories").fetchone()[0], 2)
                payload = json.loads(db.execute("SELECT payload FROM catalog_videos LIMIT 1").fetchone()[0])
                self.assertTrue(payload["card"]["thumbnail"].endswith("/hqdefault.jpg"))
                self.assertIn("HackerTube", payload["card"]["subtitle"])
                self.assertEqual(db.execute("SELECT payload FROM curated_feeds").fetchone()[0], "untouched")
            write([video("not-an-id")])
            with self.assertRaises(ValueError):
                importer.import_archive(archive, database)
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM catalog_videos").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
