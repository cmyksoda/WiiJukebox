#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Render the jukebox mark for the Wii: a tiled I8 coverage texture for the
header, and the Homebrew Channel icon.png with the Nunito wordmark.

Needs Inkscape and ImageMagick. Usage:
    python3 -I tools/make-wii-logo.py /path/to/Nunito[wght].ttf
"""
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[1]
MARK = ROOT / 'public/images/jukebox.svg'
TEXTURE = ROOT / 'client/assets/jukebox-mark.i8'
ICON = ROOT / 'client/dist/apps/wiijukebox/icon.png'
# GX I8 textures are 8x4 texel tiles, so both sides must be multiples of those.
TEXTURE_W, TEXTURE_H = 32, 48
BLUE, INK = '#1aa5e8', '#2b3138'


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def coverage(svg, width, height, workdir):
    png = workdir / 'mark.png'
    run('inkscape', '--export-type=png', f'--export-filename={png}', f'--export-height={height - 2}', str(svg))
    return run('magick', str(png), '-background', 'none', '-gravity', 'center', '-extent', f'{width}x{height}',
               '-alpha', 'extract', '-depth', '8', 'gray:-')


def tile_i8(pixels, width, height):
    out = bytearray()
    for ty in range(0, height, 4):
        for tx in range(0, width, 8):
            for y in range(ty, ty + 4):
                out += pixels[y * width + tx:y * width + tx + 8]
    return bytes(out)


def text_path(font, text, x, baseline, size):
    """SVG path for `text`; SVG's nonzero fill keeps an instanced font's overlapping contours solid."""
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    scale = size / font['head'].unitsPerEm
    parts = []
    for char in text:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        parts.append(f'<path transform="translate({x:g} {baseline:g}) scale({scale:g} {-scale:g})" '
                     f'd="{pen.getCommands()}"/>')
        x += font['hmtx'][name][0] * scale
    return ''.join(parts), x


def icon(font, workdir):
    mark = MARK.read_text()
    view = re.search(r'viewBox="([^"]+)"', mark).group(1)
    mark_w, mark_h = (float(v) for v in view.split()[2:])
    body = mark[mark.index('>') + 1:mark.rindex('</svg>')]
    size, height = 19, 44
    wii, wii_end = text_path(font, 'Wii', 0, 0, size)
    jukebox, jukebox_end = text_path(font, 'Jukebox', 0, 0, size)
    text_w, width = max(wii_end, jukebox_end), height * mark_w / mark_h
    left = (128 - (text_w + 6 + width)) / 2
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="48" viewBox="0 0 128 48">'
           f'<rect x="0.5" y="0.5" width="127" height="47" rx="9" fill="#f4f6f8" stroke="#cfd6dc"/>'
           f'<g transform="translate({left:g} 21)" fill="{BLUE}">{wii}</g>'
           f'<g transform="translate({left:g} 40)" fill="{INK}">{jukebox}</g>'
           f'<svg x="{left + text_w + 6:g}" y="{(48 - height) / 2:g}" width="{width:g}" height="{height}" '
           f'viewBox="{view}">{body}</svg></svg>')
    path = workdir / 'icon.svg'
    path.write_text(svg)
    run('inkscape', '--export-type=png', f'--export-filename={ICON}', '--export-width=128', '--export-height=48',
        str(path))


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        pixels = coverage(MARK, TEXTURE_W, TEXTURE_H, workdir)
        TEXTURE.parent.mkdir(parents=True, exist_ok=True)
        TEXTURE.write_bytes(tile_i8(pixels, TEXTURE_W, TEXTURE_H))
        icon(instancer.instantiateVariableFont(TTFont(sys.argv[1]), {'wght': 800}), workdir)
    print(f'{TEXTURE.relative_to(ROOT)}: {TEXTURE_W}x{TEXTURE_H} I8; {ICON.relative_to(ROOT)}: 128x48')


if __name__ == '__main__':
    main()
