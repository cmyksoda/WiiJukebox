#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
from pathlib import Path
import hashlib
import json
root = Path(__file__).resolve().parents[1] / 'client/vendor/projectm'
manifest = json.loads((root/'UPSTREAM.json').read_text())
for name, evidence in manifest['files'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest() == evidence['sha256'], name
print(f"Verified {len(manifest['files'])} pristine upstream files at {manifest['commit']}")
