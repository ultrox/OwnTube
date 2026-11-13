#!/usr/bin/env python3
"""Run Android capture/outbox against a disposable Observer binary, never production."""
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

binary = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="owntube-observer-") as directory:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    admin = secrets.token_hex(32)
    env = dict(os.environ, DATA_DIR=directory, BIND=f"127.0.0.1:{port}",
               ADMIN_TOKEN=admin, COOKIE_SECURE="false", PUBLIC_DIR=directory)
    with open(Path(directory) / "server.log", "w") as log:
        server = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError("Disposable Observer exited before startup")
                try:
                    with urllib.request.urlopen(origin + "/health", timeout=1):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError("Disposable Observer did not start")
            env = dict(os.environ, OWNTUBE_TEST_OBSERVER=origin, OWNTUBE_TEST_ADMIN=admin)
            subprocess.run([str(repo / "gradlew"), ":owntube:testDebugUnitTest", "--rerun-tasks",
                            "--tests", "com.ultrox.owntube.ObserverIntegrationTest"],
                           cwd=repo, env=env, check=True)
        finally:
            server.terminate()
            server.wait(timeout=10)
