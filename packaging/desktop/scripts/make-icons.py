#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Builds the desktop app's icons from the jukebox mark in public/images/jukebox.svg.

Needs Inkscape and Pillow. Usage: python3 scripts/make-icons.py
Writes build/ (icon.png, icon.ico, icon.icns), assets/ (window and tray icons) and ui/jukebox.svg.
"""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
MARK = HERE.parent.parent / "public" / "images" / "jukebox.svg"
MARK_RATIO = 981 / 1440  # width / height of the mark's view box
BRAND = "#1aa5e8"


def mark(x, y, height, fill):
    """The jukebox as a nested <svg> placed at (x, y) with the given height."""
    body = re.search(r"<svg[^>]*>(.*)</svg>", MARK.read_text(), re.S).group(1).replace(BRAND, fill)
    return (f'<svg x="{x}" y="{y}" width="{height * MARK_RATIO}" height="{height}" '
            f'viewBox="0 0 981 1440">{body}</svg>')


def tile(inset, radius, glyph_height):
    """A blue rounded square on a 1024 canvas with the white mark centered on it."""
    size = 1024 - 2 * inset
    x = inset + (size - glyph_height * MARK_RATIO) / 2
    y = inset + (size - glyph_height) / 2
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#42bdf4"/><stop offset="1" stop-color="#0b86c8"/>'
        '</linearGradient></defs>'
        f'<rect x="{inset}" y="{inset}" width="{size}" height="{size}" rx="{radius}" fill="url(#g)"/>'
        f'{mark(x, y, glyph_height, "#ffffff")}</svg>'
    )


def glyph(fill, margin=0.06):
    """The mark alone on a transparent square canvas, for the tray."""
    height = 1024 * (1 - 2 * margin)
    x = (1024 - height * MARK_RATIO) / 2
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'{mark(x, 1024 * margin, height, fill)}</svg>')


def render(svg, size, out):
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "icon.svg"
        source.write_text(svg)
        subprocess.run(["inkscape", str(source), "-w", str(size), "-h", str(size), "-o", str(out)],
                       check=True, capture_output=True)


def main():
    build, assets, ui = HERE / "build", HERE / "assets", HERE / "ui"
    for folder in (build, assets, ui):
        folder.mkdir(exist_ok=True)
    shutil.copyfile(MARK, ui / "jukebox.svg")

    flat = tile(0, 230, 770)
    render(flat, 1024, build / "icon.png")
    render(flat, 512, assets / "icon.png")

    with tempfile.TemporaryDirectory() as tmp:
        ico_sizes = [16, 24, 32, 48, 64, 128, 256]
        frames = []
        for size in ico_sizes:
            frame = Path(tmp) / f"ico-{size}.png"
            render(flat, size, frame)
            frames.append(Image.open(frame).convert("RGBA"))
        frames[-1].save(build / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])

        # macOS draws no rounded corners of its own; the artwork sits inside a margin.
        padded = tile(100, 185, 600)
        icns_frames = []
        for size in (16, 32, 64, 128, 256, 512, 1024):
            frame = Path(tmp) / f"icns-{size}.png"
            render(padded, size, frame)
            icns_frames.append(Image.open(frame).convert("RGBA"))
        icns_frames[-1].save(build / "icon.icns", format="ICNS", append_images=icns_frames[:-1])

    render(glyph(BRAND), 32, assets / "tray.png")
    render(glyph(BRAND), 64, assets / "tray@2x.png")
    render(glyph("#000000"), 22, assets / "trayTemplate.png")
    render(glyph("#000000"), 44, assets / "trayTemplate@2x.png")


if __name__ == "__main__":
    main()
