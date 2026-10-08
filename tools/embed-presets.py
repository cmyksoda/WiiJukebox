#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Embed the projectM preset collection so wiiload needs no companion SD files."""
from pathlib import Path
import json
root = Path(__file__).resolve().parents[1]
files = sorted([*(root / 'client/vendor/projectm/presets').glob('*.milk'),
                *(root / 'client/vendor/projectm/presets-extra').glob('*.milk')], key=lambda p: p.name)
assert len({p.name for p in files}) == len(files)
excluded = {line.strip() for line in (root / 'client/vendor/projectm/excluded-presets.txt').read_text().splitlines()
            if line.strip() and not line.startswith('#')}
assert excluded <= {p.name for p in files}, excluded - {p.name for p in files}
files = [p for p in files if p.name not in excluded]
out = root / 'client/build/presets.cpp'
with out.open('w') as f:
    f.write('#include "presets.h"\n#include <cstring>\n')
    f.write('const struct wj_preset wj_presets[] = {\n')
    for p in files:
        text = p.read_bytes()
        # ASCII literals compile identically on the host and PowerPC toolchains.
        f.write('{' + json.dumps(p.name, ensure_ascii=True) + ',\n')
        for line in text.splitlines(keepends=True):
            literal = ''.join(chr(b) if 32 <= b < 127 and b not in (34, 63, 92) else f'\\{b:03o}' for b in line)
            f.write('"' + literal + '"\n')
        f.write('},\n')
    f.write('};\nconst unsigned wj_preset_count = sizeof(wj_presets) / sizeof(wj_presets[0]);\n')
    f.write('int wj_preset_index(const char *name) {\n'
            ' for (unsigned i = 0; i < wj_preset_count; i++)\n'
            '  if (!std::strcmp(name, wj_presets[i].name)) return (int)i;\n'
            ' return -1;\n}\n')
    f.write('extern "C" const char *wj_builtin_preset(const char *path) {\n'
            ' if (std::strncmp(path, "builtin:/", 9)) return 0;\n'
            ' for (unsigned i = 0; i < wj_preset_count; i++)\n'
            '  if (!std::strcmp(path + 9, wj_presets[i].name)) return wj_presets[i].text;\n'
            ' return 0;\n}\n')
