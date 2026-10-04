#!/usr/bin/env python3
"""Run the optional real Navidrome integration test in a disposable loopback instance."""
# SPDX-License-Identifier: GPL-3.0-only
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "fixture-pass-2026"


def wait_for(check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Navidrome fixture did not become ready")


def create_user(binary, config):
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        [binary, "user", "create", "--admin", "--username", "fixture", "-c", str(config)],
        stdin=slave, stdout=slave, stderr=slave,
    )
    os.close(slave)
    try:
        for prompt in [b"Enter new password", b"Confirm new password"]:
            buffer = b""
            deadline = time.monotonic() + 15
            while prompt not in buffer:
                if time.monotonic() > deadline or proc.poll() is not None:
                    raise RuntimeError("Navidrome fixture account setup failed")
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    buffer += os.read(master, 8192)
            os.write(master, (PASSWORD + "\n").encode())
        if proc.wait(timeout=15):
            raise RuntimeError("Navidrome fixture user creation failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)


def main():
    binary = os.environ.get("NAVIDROME_BINARY") or shutil.which("navidrome")
    if not binary:
        raise SystemExit("Set NAVIDROME_BINARY to an official Navidrome 0.64.2 binary")
    binary = str(Path(binary).resolve())
    subprocess.run(["make", "-C", "client", "host-test"], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix="wiijukebox-nav-test-") as folder:
        root = Path(folder)
        music, data = root / "music", root / "data"
        music.mkdir()
        data.mkdir()
        for i in range(1, 14):
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                f"sine=frequency={400 + i * 20}:duration=1.5",
                "-metadata", "artist=WiiJukebox Test Artist", "-metadata", "album=Test Album",
                "-metadata", f"title=Tone {i:02}", "-metadata", f"track={i}",
                "-c:a", "flac", str(music / f"{i:02}.flac"),
            ], check=True)
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=64x64",
            "-frames:v", "1", str(music / "cover.jpg"),
        ], check=True)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        config = root / "navidrome.toml"
        config.write_text(f'''Address = "127.0.0.1"
Port = {port}
BaseURL = "/music"
MusicFolder = {json.dumps(str(music))}
DataFolder = {json.dumps(str(data))}
EnableExternalServices = false
EnableInsightsCollector = false
EnableGravatar = false
LogLevel = "warn"
''')
        url = f"http://127.0.0.1:{port}/music"
        with (root / "server.log").open("w") as log:
            server = subprocess.Popen([binary, "-c", str(config)], cwd=root, stdout=log, stderr=log)
            try:
                wait_for(lambda: urllib.request.urlopen(url + "/", timeout=1).status == 200)
                create_user(binary, config)
                params = urllib.parse.urlencode({
                    "u": "fixture", "s": "test", "t": hashlib.md5((PASSWORD + "test").encode()).hexdigest(),
                    "v": "1.16.1", "c": "WiiJukeboxTest", "f": "json",
                })

                def scanned():
                    with urllib.request.urlopen(url + "/rest/getScanStatus.view?" + params, timeout=1) as reply:
                        status = json.load(reply)["subsonic-response"]["scanStatus"]
                    return status["count"] == 13 and not status["scanning"]

                wait_for(scanned)
                env = dict(os.environ, NAVIDROME_FIXTURE="1", NAVIDROME_TEST_URL=url)
                subprocess.run(["node", "test/navidrome-live.js"], cwd=ROOT, env=env, check=True)
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()


if __name__ == "__main__":
    main()
