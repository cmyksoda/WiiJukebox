#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Package only the experimental client runtime and license, never server config."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
app = root / "client/dist/apps/wiijukebox"
output = root / "client/dist/WiiJukebox-client-0.1.0-experimental.zip"
files = ["boot.dol", "meta.xml", "LICENSE"]
for name in files:
    if not (app / name).is_file():
        raise SystemExit(f"Missing {name}; build the client first")
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(app / name, f"apps/wiijukebox/{name}")
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert archive.namelist() == [f"apps/wiijukebox/{name}" for name in files]
print(output)
