#!/usr/bin/env python3
"""Connect a debug OwnTube APK to a running local Home backend via ADB."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import shlex
import subprocess
import urllib.request
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
parser.add_argument("--data", required=True, type=Path, help="Local server DATA_DIR")
parser.add_argument("--port", type=int, default=3219)
args = parser.parse_args()
origin = f"http://127.0.0.1:{args.port}"
package = "com.ultrox.owntube"
adb = ["adb", "-s", args.serial]

def command(*parts, **kwargs):
    return subprocess.run(adb + list(parts), check=True, capture_output=True, timeout=30, **kwargs).stdout

# Verify the installed app is debuggable before creating a local device.
command("shell", "run-as", package, "id")
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def post(path, body):
    request = urllib.request.Request(origin + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=10) as response:
        return json.load(response)

post("/api/login", {"token": (args.data / "admin-token").read_text().strip()})
device = post("/api/devices", {"label": "Shield local Home test"})
config = json.dumps({"origin": origin, "key": device["token"]}).encode()
command("reverse", f"tcp:{args.port}", f"tcp:{args.port}")
command("shell", "am", "force-stop", package)
command("shell", "run-as", package, "mkdir", "-p", "no_backup", "shared_prefs")

def write(path, contents):
    command("shell", "run-as", package, "sh", "-c",
            shlex.quote(f"umask 077; cat > {path}"), input=contents)

write("no_backup/home-test.json", config)
prefs = "shared_prefs/owntube_home.xml"
existing = subprocess.run(adb + ["shell", "run-as", package, "cat", prefs], capture_output=True, timeout=30)
root = ET.fromstring(existing.stdout) if existing.returncode == 0 else ET.Element("map")
for name in ("enabled", "local"):
    for item in list(root):
        if item.get("name") == name:
            root.remove(item)
    ET.SubElement(root, "boolean", name=name, value="true")
write(prefs, ET.tostring(root, encoding="utf-8", xml_declaration=True))
command("shell", "am", "start", "-n",
        package + "/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity")
print(f"Home now uses {origin} on this Mac through ADB. Local device: {device['deviceId']}")
