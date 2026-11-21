#!/usr/bin/env python3
"""Apply OwnTube's hserver retention policy after a release. Run from the Mac.

    python3 deploy/retention.py --current RELEASE --rollback RELEASE          # plan only
    python3 deploy/retention.py --current RELEASE --rollback RELEASE --apply  # delete

Policy (deploy/README.md#hserver-retention):
- Backups (/home/marko/Backups/youtube-observer): keep the 5 most recent plus
  before-<current> (the restore point for rolling back to --rollback). Every backup is
  mirrored to the Mac; a backup is deleted only after its files' SHA-256 match the
  Mac copy (an unmirrored backup is copied and verified first).
- Release directories (/home/marko/releases/youtube-observer): keep --current and
  --rollback. Others are archived to the Mac without database copies, then deleted.
- Docker: keep youtube-observer containers/images of the 5 most recent releases;
  remove older stopped containers and their unused image tags. Never touches the
  shared builder, build cache, other services or volumes.
"""
import argparse
import hashlib
import json
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HOST = "hserver"
BACKUPS = "/home/marko/Backups/youtube-observer"
RELEASES = "/home/marko/releases/youtube-observer"
MIRROR = Path.home() / ".local/state/youtube-observer/backups"
ARCHIVE = Path.home() / ".local/state/youtube-observer/release-archive"
KEEP_BACKUPS = 5
KEEP_RELEASES_DOCKER = 5
DATA_EXCLUDES = ["*/benchmark-data", "*/verify-data", "*/candidate-data", "*/baseline-data",
                 "*.sqlite3", "*.sqlite3-wal", "*.sqlite3-shm"]


def remote(script, binary=False):
    """Run a root shell script on hserver (stdin), returning stdout."""
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, "sudo -n bash -s"], input=script.encode(),
                            capture_output=True, check=True, timeout=1800)
    return result.stdout if binary else result.stdout.decode()


def listing(root):
    """Directory name -> mtime (epoch seconds)."""
    out = remote(f"cd {shlex.quote(root)} && for d in */; do printf '%s\\t%s\\n' \"$(stat -c %Y \"$d\")\" \"${{d%/}}\"; done")
    return {name: int(mtime) for mtime, name in (line.split("\t", 1) for line in out.splitlines() if line)}


def server_digests(name):
    out = remote(f"cd {shlex.quote(BACKUPS)}/{shlex.quote(name)} && for f in *; do [ -f \"$f\" ] && printf '%s\\t%s\\n' \"$(sha256sum \"$f\" | cut -c1-64)\" \"$f\"; done")
    return {f: d for d, f in (line.split("\t", 1) for line in out.splitlines() if line)}


def local_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_on_mac(name, apply):
    """True when every main file of the server backup matches the Mac mirror."""
    digests = {f: d for f, d in server_digests(name).items() if not f.endswith(("-wal", "-shm"))}
    if not digests:
        raise SystemExit(f"{name}: empty backup on server; refusing to decide")
    local = MIRROR / name
    if not local.is_dir() and apply:
        MIRROR.mkdir(parents=True, exist_ok=True)
        data = remote(f"tar -C {shlex.quote(BACKUPS)} -cf - {shlex.quote(name)}", binary=True)
        subprocess.run(["tar", "-C", str(MIRROR), "-xf", "-"], input=data, check=True)
        local.chmod(0o700)
        for f in local.iterdir():
            f.chmod(0o600)
    return all((local / f).is_file() and local_digest(local / f) == d for f, d in digests.items())


def docker_plan():
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST,
        "docker ps -a --filter label=service=youtube-observer --format '{{.Names}}\t{{.State}}\t{{.CreatedAt}}'"],
        capture_output=True, text=True, check=True).stdout
    rows = sorted((line.split("\t") for line in out.splitlines() if line), key=lambda r: r[2], reverse=True)
    releases = []
    for name, _, _ in rows:
        version = name.removeprefix("youtube-observer-web-").split("_replaced_")[0]
        if version not in releases:
            releases.append(version)
    keep = set(releases[:KEEP_RELEASES_DOCKER])
    remove = [name for name, state, _ in rows if state != "running"
              and name.removeprefix("youtube-observer-web-").split("_replaced_")[0] not in keep]
    return sorted(keep), remove


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--current", required=True, help="running release, e.g. owntube-deepseek-key-20261120-1")
    parser.add_argument("--rollback", required=True, help="its rollback target release")
    parser.add_argument("--apply", action="store_true", help="delete; default only prints the plan")
    args = parser.parse_args()

    backups = listing(BACKUPS)
    restore_point = f"before-{args.current}"
    if restore_point not in backups:
        raise SystemExit(f"Missing restore point {restore_point}; take the pre-release backup first")
    newest = sorted(backups, key=backups.get, reverse=True)[:KEEP_BACKUPS]
    keep_backups = set(newest) | {restore_point}
    drop_backups = sorted(set(backups) - keep_backups)

    releases = listing(RELEASES)
    for needed in (args.current, args.rollback):
        if needed not in releases:
            print(f"note: release directory {needed} not on server")
    keep_releases = {args.current, args.rollback}
    drop_releases = sorted(set(releases) - keep_releases)
    keep_docker, drop_containers = docker_plan()

    plan = {"keepBackups": sorted(keep_backups), "deleteBackups": drop_backups,
            "keepReleases": sorted(keep_releases & set(releases)), "deleteReleases": drop_releases,
            "keepDockerReleases": keep_docker, "deleteContainers": drop_containers}
    print(json.dumps(plan, indent=1))
    if not args.apply:
        print("Plan only. Re-run with --apply to delete.")
        return

    for name in drop_backups:
        if not verified_on_mac(name, apply=True):
            raise SystemExit(f"{name}: Mac copy missing or different; nothing deleted for it. Investigate.")
    if drop_releases:
        ARCHIVE.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = ARCHIVE / f"releases-reports-{stamp}.tar.gz"
        excludes = " ".join(f"--exclude={shlex.quote(p)}" for p in DATA_EXCLUDES)
        members = " ".join(shlex.quote(f"youtube-observer/{r}") for r in drop_releases)
        target.write_bytes(remote(f"tar -C /home/marko/releases -czf - {excludes} {members}", binary=True))
        target.chmod(0o600)
        listed = subprocess.run(["tar", "-tzf", str(target)], capture_output=True, text=True, check=True).stdout
        missing = [r for r in drop_releases if f"youtube-observer/{r}/" not in listed]
        if missing:
            raise SystemExit(f"Archive incomplete for {missing}; nothing deleted")
        print(f"Archived reports: {target} sha256={local_digest(target)}")

    before = int(remote("df -B1M --output=used / | tail -1").strip())
    script = ["set -e"]
    script += [f"rm -rf -- {shlex.quote(BACKUPS + '/' + n)}" for n in drop_backups]
    script += [f"rm -rf -- {shlex.quote(RELEASES + '/' + n)}" for n in drop_releases]
    script += [f"docker rm {shlex.quote(c)} >/dev/null" for c in drop_containers]
    script += ["used=$(docker ps -a --format '{{.Image}}' | sort -u)",
               "for t in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^localhost:5555/youtube-observer:'); do",
               "  case \"$t\" in *:latest) continue;; esac",
               "  echo \"$used\" | grep -qx \"$t\" || docker rmi \"$t\" >/dev/null",
               "done"]
    remote("\n".join(script) + "\n")
    after = int(remote("df -B1M --output=used / | tail -1").strip())
    print(json.dumps({"freedMb": before - after, "rootUsedMb": after}))


if __name__ == "__main__":
    sys.exit(main())
