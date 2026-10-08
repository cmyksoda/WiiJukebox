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
extra = json.loads((root/'EXTRA.json').read_text())
embedded = {path.name.lower() for path in (root/'presets').glob('*.milk')}
on_disk = {path.name for path in (root/'presets-extra').glob('*.milk')}
assert on_disk == set(extra['files']), on_disk ^ set(extra['files'])
for name, evidence in extra['files'].items():
    assert name.lower() not in embedded, name
    assert hashlib.sha256((root/'presets-extra'/name).read_bytes()).hexdigest() == evidence['sha256'], name
others = len(extra.get('additional_archives', {}))
print(f"Verified {len(extra['files'])} added presets from {extra['archive_name']} ({extra['archive_sha256']})"
      + (f" and {others} other projectM archives" if others else ""))
