#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Embed WiiRadio's preset collection so wiiload needs no companion SD files."""
from pathlib import Path
import json
root = Path(__file__).resolve().parents[1]
files = sorted((root / 'client/vendor/projectm/presets').glob('*.milk'))
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
    f.write('extern "C" const char *wj_builtin_preset(const char *path) {\n'
            ' if (std::strncmp(path, "builtin:/", 9)) return 0;\n'
            ' for (unsigned i = 0; i < wj_preset_count; i++)\n'
            '  if (!std::strcmp(path + 9, wj_presets[i].name)) return wj_presets[i].text;\n'
            ' return 0;\n}\n')
