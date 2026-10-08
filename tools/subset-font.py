#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Build the Wii UI font: Noto Sans CJK JP at weight 500, subset to the scripts
music titles commonly use, as a static CFF2 font FreeType renders directly.

Usage: python3 -I tools/subset-font.py /path/to/NotoSansCJK-VF.ttc
"""
from pathlib import Path
import copy
import hashlib
import io
import json
import sys

import fontTools
from fontTools.ttLib import TTCollection
from fontTools.varLib import instancer
from fontTools import subset

SOURCE_SHA256 = 'd3d8256cdec8dbcb3552284bc6b20c734dd60c2ee9df83b5758e34807c4bac32'
WEIGHT = 500
RANGES = [
    (0x20, 0x7E), (0xA0, 0x24F), (0x370, 0x3FF), (0x400, 0x4FF), (0x1E00, 0x1EFF),
    (0x2000, 0x206F), (0x20A0, 0x20BF), (0x2100, 0x214F), (0x2190, 0x21FF),
    (0x25A0, 0x25FF), (0x2600, 0x266F), (0x3000, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF),
]


def jis_level_1():
    """The 2,965 JIS X 0208 level 1 kanji (rows 16-47), via EUC-JP."""
    kanji = set()
    for row in range(16, 48):
        for cell in range(0xA1, 0xFF):
            try:
                kanji.add(bytes([row + 0xA0, cell]).decode('euc_jp'))
            except UnicodeDecodeError:
                pass
    return kanji


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f'{source}: unexpected SHA-256 {digest}')
    font = copy.deepcopy(TTCollection(str(source)).fonts[0])
    font = instancer.instantiateVariableFont(font, {'wght': WEIGHT})
    options = subset.Options()
    options.layout_features = []
    options.notdef_outline = True
    options.name_IDs = ['*']
    options.drop_tables += ['GSUB', 'GPOS', 'BASE', 'VORG', 'STAT', 'VVAR', 'HVAR', 'MVAR', 'DSIG', 'vhea', 'vmtx']
    chars = {chr(code) for start, end in RANGES for code in range(start, end + 1)} | jis_level_1()
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=''.join(sorted(chars)))
    subsetter.subset(font)
    output = io.BytesIO()
    font.recalcTimestamp = False
    font.save(output)
    root = Path(__file__).resolve().parents[1] / 'client/vendor/fonts'
    target = root / 'NotoSansCJKjp-Medium-WiiJukebox.otf'
    target.write_bytes(output.getvalue())
    record = {
        'upstream': 'https://github.com/notofonts/noto-cjk (Noto Sans CJK 2.004, OFL-1.1)',
        'source_file': 'NotoSansCJK-VF.ttc, face 0 (Noto Sans CJK JP), Fedora google-noto-sans-cjk-vf-fonts 2.004',
        'source_sha256': digest,
        'weight': WEIGHT,
        'ranges': [f'U+{start:04X}-U+{end:04X}' for start, end in RANGES] + ['JIS X 0208 level 1 kanji'],
        'fonttools': fontTools.version,
        'glyphs': font['maxp'].numGlyphs,
        'sha256': hashlib.sha256(output.getvalue()).hexdigest(),
        'copyright': font['name'].getDebugName(0),
    }
    (root / 'FONT.json').write_text(json.dumps(record, indent=2) + '\n')
    print(f"{target}: {len(output.getvalue())} bytes, {record['glyphs']} glyphs")


if __name__ == '__main__':
    main()
