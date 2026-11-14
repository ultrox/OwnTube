#!/usr/bin/env python3
"""Package an already-built collector; retain versioned public downloads in images."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

root = Path(__file__).resolve().parents[1]
extension = root / "apps/chrome-extension"
dist = extension / "dist"
manifest = json.loads((dist / "manifest.json").read_text())
assert manifest == json.loads((extension / "src/manifest.json").read_text()), "Build the extension first"
version = manifest["version"]
assert re.fullmatch(r"\d+(?:\.\d+){1,3}", version)
files = ["manifest.json", "content.js", "page.js", "sw.js", "popup.html",
         "popup.css", "popup.js", "pairing.html", "pairing.js"]
downloads = root / "apps/backoffice/downloads"
downloads.mkdir(exist_ok=True)
target = downloads / f"youtube-observer-{version}.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in files:
        archive.write(dist / name, name)
    archive.write(extension / "INSTALL.txt", "INSTALL.txt")
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    for name in files:
        assert archive.read(name) == (dist / name).read_bytes()
(downloads / "youtube-observer-latest.zip").write_bytes(target.read_bytes())
print(f"{target}: {target.stat().st_size} bytes, SHA-256 {hashlib.sha256(target.read_bytes()).hexdigest()}")
