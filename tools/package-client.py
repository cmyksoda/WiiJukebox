#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Package only the experimental client runtime and license, never server config."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import os

root = Path(__file__).resolve().parents[1]
portlibs = Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")) / "portlibs/ppc/licenses"
app = root / "client/dist/apps/wiijukebox"
version = json.loads((root / "package.json").read_text())["version"]
output = root / f"client/dist/WiiJukebox-{version}-wii.zip"
licenses = {
    "licenses/projectM-LGPL.txt": root / "client/vendor/projectm/LICENSE.txt",
    "licenses/omptl-LGPL.txt": root / "client/vendor/projectm/omptl/License.txt",
    "licenses/libogc.txt": root / "client/vendor/libogc/LICENSE",
    "licenses/fonts-OFL.txt": root / "client/vendor/fonts/OFL.txt",
    "licenses/freetype-FTL.txt": portlibs / "ppc-freetype/FTL.TXT",
    "licenses/libpng.txt": portlibs / "ppc-libpng/LICENSE",
    "licenses/zlib.txt": portlibs / "ppc-zlib/LICENSE",
    "licenses/bzip2.txt": portlibs / "ppc-bzip2/LICENSE",
    "licenses/brotli.txt": portlibs / "ppc-brotli/LICENSE",
    "THIRD_PARTY.txt": root / "client/vendor/README.md",
}
for name, source in licenses.items():
    destination = app / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())
files = ["boot.dol", "meta.xml", "icon.png", "LICENSE", *licenses]
for name in files:
    if not (app / name).is_file():
        raise SystemExit(f"Missing {name}; build the client first")
# The SD card archive unpacks at the card's root; the Homebrew Channel's wiiload
# install wants the app folder itself at the top of the zip.
layouts = {output: "apps/wiijukebox", output.with_name(f"WiiJukebox-{version}-wii-wiiload.zip"): "wiijukebox"}
for path, folder in layouts.items():
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(app / name, f"{folder}/{name}")
    with ZipFile(path) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == [f"{folder}/{name}" for name in files]
    print(path)
