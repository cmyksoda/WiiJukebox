#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Build the Wii UI fonts at weight 500: Noto Sans for Latin, Greek and
Cyrillic, with Noto Sans CJK JP as the fallback for kana and common kanji.

Usage: python3 -I tools/subset-font.py /path/to/NotoSans[wght].ttf /path/to/NotoSansCJK-VF.ttc
"""
from pathlib import Path
import hashlib
import io
import json
import sys

import fontTools
from fontTools.ttLib import TTCollection, TTFont
from fontTools.varLib import instancer
from fontTools import subset

WEIGHT = 500
DROP = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'VORG', 'STAT', 'VVAR', 'HVAR', 'MVAR', 'DSIG', 'vhea', 'vmtx']
FONTS = [
    {
        'output': 'NotoSans-Medium-WiiJukebox.ttf',
        'source_sha256': 'fb53504de62e767a54695416123d68d67f71c9b69722175184ad56e7dd13547b',
        'source_file': 'NotoSans[wght].ttf, Fedora google-noto-sans-vf-fonts 20251201 (Noto Sans 2.015)',
        'upstream': 'https://github.com/notofonts/latin-greek-cyrillic (OFL-1.1)',
        'ranges': [(0x20, 0x7E), (0xA0, 0x24F), (0x2B0, 0x36F), (0x370, 0x3FF), (0x400, 0x4FF),
                   (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x20A0, 0x20BF), (0x2100, 0x214F),
                   (0x2190, 0x21FF), (0x25A0, 0x25FF), (0x2600, 0x266F)],
        'kanji': False,
    },
    {
        'output': 'NotoSansCJKjp-Medium-WiiJukebox.otf',
        'source_sha256': 'd3d8256cdec8dbcb3552284bc6b20c734dd60c2ee9df83b5758e34807c4bac32',
        'source_file': 'NotoSansCJK-VF.ttc face 0 (Noto Sans CJK JP), Fedora google-noto-sans-cjk-vf-fonts 2.004',
        'upstream': 'https://github.com/notofonts/noto-cjk (Noto Sans CJK 2.004, OFL-1.1)',
        'ranges': [(0x20, 0x7E), (0x3000, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF)],
        'kanji': True,
    },
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


def build(spec, path):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if digest != spec['source_sha256']:
        raise SystemExit(f'{path}: unexpected SHA-256 {digest}')
    font = TTCollection(path).fonts[0] if path.endswith('.ttc') else TTFont(path)
    font = instancer.instantiateVariableFont(font, {'wght': WEIGHT})
    options = subset.Options()
    options.layout_features = []
    options.notdef_outline = True
    options.name_IDs = ['*']
    options.drop_tables += DROP
    chars = {chr(code) for start, end in spec['ranges'] for code in range(start, end + 1)}
    if spec['kanji']:
        chars |= jis_level_1()
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=''.join(sorted(chars)))
    subsetter.subset(font)
    output = io.BytesIO()
    font.save(output)
    record = {key: spec[key] for key in ('output', 'source_file', 'source_sha256', 'upstream')}
    record.update({
        'weight': WEIGHT,
        'ranges': [f'U+{start:04X}-U+{end:04X}' for start, end in spec['ranges']] +
                  (['JIS X 0208 level 1 kanji'] if spec['kanji'] else []),
        'glyphs': font['maxp'].numGlyphs,
        'sha256': hashlib.sha256(output.getvalue()).hexdigest(),
        'copyright': font['name'].getDebugName(0),
    })
    return output.getvalue(), record


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    root = Path(__file__).resolve().parents[1] / 'client/vendor/fonts'
    records = []
    for spec, path in zip(FONTS, sys.argv[1:]):
        data, record = build(spec, path)
        (root / spec['output']).write_bytes(data)
        records.append(record)
        print(f"{spec['output']}: {len(data)} bytes, {record['glyphs']} glyphs")
    (root / 'FONT.json').write_text(json.dumps({'fonttools': fontTools.version, 'fonts': records}, indent=2) + '\n')


if __name__ == '__main__':
    main()
