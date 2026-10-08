#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Build the Wii UI fonts: Nunito, the web UI's typeface, for Latin and Cyrillic,
then Noto Sans for Greek and Noto Sans CJK JP for kana and common kanji.

Usage: python3 -I tools/subset-font.py /path/to/Nunito[wght].ttf /path/to/NotoSans[wght].ttf \
           /path/to/NotoSansCJK-VF.ttc
"""
from pathlib import Path
import hashlib
import io
import json
import sys

import fontTools
from fontTools.ttLib import TTCollection, TTFont, newTable
from fontTools.ttLib.tables._k_e_r_n import KernTable_format_0
from fontTools.varLib import instancer
from fontTools import subset

DROP = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'VORG', 'STAT', 'VVAR', 'HVAR', 'MVAR', 'DSIG', 'vhea', 'vmtx']
# One format 0 subtable holds at most this many pairs (its length field is 16 bits).
MAX_KERN_PAIRS = 10920
FONTS = [
    {
        'output': 'Nunito-SemiBold-WiiJukebox.ttf',
        'source_sha256': 'bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207',
        'source_file': 'ofl/nunito/Nunito[wght].ttf from google/fonts at 604936664fd62c14271209b51f98e7f495dd1a3e',
        'upstream': 'https://github.com/googlefonts/nunito (OFL-1.1)',
        # Heavier than the web UI's 400, since thin strokes flicker on interlaced TVs.
        'weight': 600,
        'ranges': [(0x20, 0x7E), (0xA0, 0x24F), (0x2B0, 0x36F), (0x400, 0x4FF),
                   (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x20A0, 0x20BF), (0x2100, 0x214F),
                   (0x2190, 0x21FF), (0x25A0, 0x25FF), (0x2600, 0x266F)],
        'kanji': False,
        'kern': True,
    },
    {
        'output': 'NotoSans-Greek-WiiJukebox.ttf',
        'source_sha256': 'fb53504de62e767a54695416123d68d67f71c9b69722175184ad56e7dd13547b',
        'source_file': 'NotoSans[wght].ttf, Fedora google-noto-sans-vf-fonts 20251201 (Noto Sans 2.015)',
        'upstream': 'https://github.com/notofonts/latin-greek-cyrillic (OFL-1.1)',
        'weight': 600,
        'ranges': [(0x370, 0x3FF), (0x1F00, 0x1FFF)],
        'kanji': False,
        'kern': False,
    },
    {
        'output': 'NotoSansCJKjp-Medium-WiiJukebox.otf',
        'source_sha256': 'd3d8256cdec8dbcb3552284bc6b20c734dd60c2ee9df83b5758e34807c4bac32',
        'source_file': 'NotoSansCJK-VF.ttc face 0 (Noto Sans CJK JP), Fedora google-noto-sans-cjk-vf-fonts 2.004',
        'upstream': 'https://github.com/notofonts/noto-cjk (Noto Sans CJK 2.004, OFL-1.1)',
        'weight': 500,
        'ranges': [(0x20, 0x7E), (0x3000, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF)],
        'kanji': True,
        'kern': False,
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


def kern_pairs(font):
    """Flattens GPOS pair kerning, which FreeType's FT_Get_Kerning cannot read, into pairs."""
    gpos = font['GPOS'].table
    order = font.getGlyphOrder()
    indices = {i for record in gpos.FeatureList.FeatureRecord if record.FeatureTag == 'kern'
               for i in record.Feature.LookupListIndex}
    pairs = {}
    for index in sorted(indices):
        lookup = gpos.LookupList.Lookup[index]
        for table in lookup.SubTable:
            if lookup.LookupType == 9:
                table = table.ExtSubTable
            if table.LookupType != 2:
                continue
            if table.Format == 1:
                for first, pair_set in zip(table.Coverage.glyphs, table.PairSet):
                    for record in pair_set.PairValueRecord:
                        value = getattr(record.Value1, 'XAdvance', 0) if record.Value1 else 0
                        if value:
                            pairs.setdefault((first, record.SecondGlyph), value)
            else:
                classes1, classes2 = table.ClassDef1.classDefs, table.ClassDef2.classDefs
                for first in table.Coverage.glyphs:
                    row = table.Class1Record[classes1.get(first, 0)].Class2Record
                    for second in order:
                        value = row[classes2.get(second, 0)].Value1
                        value = getattr(value, 'XAdvance', 0) if value else 0
                        if value:
                            pairs.setdefault((first, second), value)
    # Past the subtable limit, keep the pairs that move glyphs the most.
    return dict(sorted(pairs.items(), key=lambda item: -abs(item[1]))[:MAX_KERN_PAIRS])


def build(spec, path):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if digest != spec['source_sha256']:
        raise SystemExit(f'{path}: unexpected SHA-256 {digest}')
    font = TTCollection(path).fonts[0] if path.endswith('.ttc') else TTFont(path)
    font = instancer.instantiateVariableFont(font, {'wght': spec['weight']})
    options = subset.Options()
    options.layout_features = ['kern'] if spec['kern'] else []
    options.notdef_outline = True
    options.name_IDs = ['*']
    options.drop_tables += [] if spec['kern'] else DROP
    chars = {chr(code) for start, end in spec['ranges'] for code in range(start, end + 1)}
    if spec['kanji']:
        chars |= jis_level_1()
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=''.join(sorted(chars)))
    subsetter.subset(font)
    pairs = {}
    if spec['kern']:
        pairs = kern_pairs(font)
        table = KernTable_format_0()
        table.version, table.format, table.coverage, table.apple = 0, 0, 1, False
        table.kernTable = pairs
        font['kern'] = newTable('kern')
        font['kern'].version, font['kern'].kernTables = 0, [table]
        for tag in DROP:
            if tag in font:
                del font[tag]
    # Keep the source's timestamp so rebuilding produces identical bytes.
    font.recalcTimestamp = False
    output = io.BytesIO()
    font.save(output)
    record = {key: spec[key] for key in ('output', 'source_file', 'source_sha256', 'upstream')}
    record.update({
        'weight': spec['weight'],
        'kern_pairs': len(pairs),
        'ranges': [f'U+{start:04X}-U+{end:04X}' for start, end in spec['ranges']] +
                  (['JIS X 0208 level 1 kanji'] if spec['kanji'] else []),
        'glyphs': font['maxp'].numGlyphs,
        'sha256': hashlib.sha256(output.getvalue()).hexdigest(),
        'copyright': font['name'].getDebugName(0),
    })
    return output.getvalue(), record


def main():
    if len(sys.argv) != len(FONTS) + 1:
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
