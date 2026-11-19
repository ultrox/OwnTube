#!/usr/bin/env python3
"""Import an official HackerTube archive into an existing OwnTube database.

No network calls. Only catalog tables change; saved drafts/publications are untouched.
Usage: python3 scripts/import-hackertube.py --archive /path/hackertube-data.zip --data /path/test-data
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import zipfile
from datetime import datetime, timezone

SOURCE = "hackertube"
SCHEMA = Path(__file__).resolve().parents[1] / "server/src/catalog.sql"


def text(value, maximum):
    if not isinstance(value, str) or len(value.encode("utf-8")) > maximum:
        raise ValueError("Invalid or oversized catalog text")
    return value


def prepare(archive):
    with zipfile.ZipFile(archive) as bundle:
        def read(name, maximum):
            matches = [n for n in bundle.namelist() if n == name or n.endswith("/" + name)]
            if len(matches) != 1 or bundle.getinfo(matches[0]).file_size > maximum:
                raise ValueError(f"Missing, ambiguous or oversized {name}")
            return bundle.read(matches[0])

        taxonomy = json.loads(read("taxonomy.json", 1_000_000))
        raw_videos = read("videos.jsonl", 20_000_000)
        documentation = read("DATA.md", 100_000).decode("utf-8")

    categories = set()
    areas = []
    for area in taxonomy["areas"]:
        normalized = {"id": text(area["id"], 100), "name": text(area["name"], 300), "categories": []}
        for category in area["categories"]:
            key = text(category["id"], 100)
            if not re.fullmatch(r"[a-z0-9-]+", key) or key in categories:
                raise ValueError(f"Invalid or duplicate category: {key}")
            categories.add(key)
            normalized["categories"].append({
                "id": key, "name": text(category["name"], 300),
                "description": text(category.get("description", ""), 4000),
            })
        areas.append(normalized)
    if not categories or len(categories) > 1000:
        raise ValueError("Unexpected taxonomy size")

    videos, seen = [], set()
    total = 0
    for line in raw_videos.splitlines():
        if not line.strip():
            continue
        total += 1
        video = json.loads(line)
        recommenders = video["hn"]["recommenders"]
        if type(recommenders) is not int or recommenders < 0:
            raise ValueError("Invalid recommender count")
        if recommenders == 0 or video["shelf_life"] == "news":
            continue
        vid = video["vid"]
        if not isinstance(vid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) or vid in seen:
            raise ValueError("Invalid or duplicate video ID")
        seen.add(vid)
        score = video["score"]
        if type(score) not in (int, float) or not math.isfinite(score) or score < 0:
            raise ValueError("Invalid video score")
        category_ids = sorted({c["id"] for c in video["categories"]})
        if not category_ids or not set(category_ids) <= categories:
            raise ValueError("Video references an unknown category")
        title = text(video["title"], 1000)
        channel = text(video["channel"], 900)
        payload = {
            "card": {
                "videoId": vid, "title": title, "subtitle": f"{channel} · HackerTube",
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            },
            "channel": channel,
            "summary": text(video.get("summary", ""), 10000),
            "why": text(video.get("why_hn", ""), 10000),
            "score": score, "recommenders": recommenders,
            "shelfLife": text(video["shelf_life"], 30),
            "contentType": text(video.get("content_type", ""), 60),
            "categories": category_ids,
        }
        search = " ".join([title, channel, payload["summary"], payload["why"]]).lower()
        videos.append((vid, score, search, payload))
    if not videos or total > 50000:
        raise ValueError("Empty or unexpectedly large catalog")
    with Path(archive).open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    exported = re.search(r"Exported (\d{4}-\d{2}-\d{2})", documentation)
    metadata = {
        "id": SOURCE, "name": "HackerTube", "url": "https://hackertube.org",
        "license": "ODC-By 1.0", "licenseUrl": "https://opendatacommons.org/licenses/by/1-0/",
        "archiveUrl": "https://hackertube.org/download/hackertube-data.zip",
        "upstreamUrl": "https://huggingface.co/datasets/open-index/hacker-news",
        "exported": exported.group(1) if exported else None,
        "importedAt": datetime.now(timezone.utc).isoformat(), "sha256": digest,
        "totalVideos": total, "videoCount": len(videos), "areas": areas,
        "filter": "At least one HN recommender; shelf_life is not news",
    }
    return metadata, videos


def import_archive(archive, database):
    metadata, videos = prepare(archive)  # Validate completely before changing the database.
    if not Path(database).is_file():
        raise ValueError("Start the OwnTube server first; database does not exist")
    with sqlite3.connect(database, timeout=15) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript(SCHEMA.read_text())
        with db:
            db.execute("INSERT INTO catalog_sources(id,payload) VALUES(?,?) "
                       "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                       (SOURCE, json.dumps(metadata)))
            db.execute("DELETE FROM catalog_videos WHERE source=?", (SOURCE,))
            db.executemany("INSERT INTO catalog_videos(source,video,score,search,payload) VALUES(?,?,?,?,?)",
                           [(SOURCE, vid, score, search, json.dumps(payload)) for vid, score, search, payload in videos])
            db.executemany("INSERT INTO catalog_categories(source,category,video) VALUES(?,?,?)",
                           [(SOURCE, category, vid) for vid, _, _, payload in videos for category in payload["categories"]])
    return {k: metadata[k] for k in ("videoCount", "totalVideos", "exported", "sha256")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(import_archive(args.archive, args.data / "observer.sqlite3"), indent=2))
