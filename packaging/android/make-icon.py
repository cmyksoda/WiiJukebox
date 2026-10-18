#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Draws the launcher icon's jukebox from the mark in public/images/jukebox.svg.

Usage: python3 -I packaging/android/make-icon.py
Writes app/src/main/res/drawable/ic_launcher_foreground.xml, which is also the themed icon's monochrome layer.
"""
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
MARK = HERE.parent.parent / "public" / "images" / "jukebox.svg"
OUT = HERE / "app" / "src" / "main" / "res" / "drawable" / "ic_launcher_foreground.xml"
CANVAS = 108  # the adaptive icon's size in dp
SAFE_RADIUS = 33  # launchers may mask anything past the 66dp safe circle
DROP = 3  # dp the cabinet sits below the middle, which looked high with the notes above it


def subpaths(d):
    """The mark's path as subpaths of absolute (command, points) in its 981 x 1440 view box."""
    tokens = re.findall(r"[A-Za-z]|-?\d*\.?\d+", d)
    # The mark's group is translate(0,1440) scale(0.1,-0.1).
    place = lambda x, y: (x / 10, 1440 - y / 10)
    parts, i, cmd = [], 0, None
    x = y = start_x = start_y = 0.0
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd in "zZ":
                x, y = start_x, start_y
                parts[-1].append(("Z", []))
            continue
        count = 6 if cmd == "c" else 2
        v = [float(t) for t in tokens[i:i + count]]
        i += count
        if cmd in "Mm":
            x, y = v if cmd == "M" else (x + v[0], y + v[1])
            start_x, start_y = x, y
            parts.append([("M", [place(x, y)])])
            cmd = "L" if cmd == "M" else "l"
        elif cmd in "Ll":
            x, y = v if cmd == "L" else (x + v[0], y + v[1])
            parts[-1].append(("L", [place(x, y)]))
        elif cmd == "c":
            points = [place(x + v[0], y + v[1]), place(x + v[2], y + v[3])]
            x, y = x + v[4], y + v[5]
            parts[-1].append(("C", points + [place(x, y)]))
        else:
            raise ValueError(f"the mark uses a path command this script doesn't read: {cmd}")
    return parts


def main():
    d = re.search(r'\sd="([^"]*)"', MARK.read_text()).group(1)
    parts = subpaths(d)
    points = lambda part: [p for _, ps in part for p in ps]
    bounds = lambda ps: (min(p[0] for p in ps), min(p[1] for p in ps), max(p[0] for p in ps), max(p[1] for p in ps))

    # Place the cabinet (the largest part) rather than the whole mark, so the notes float above it.
    def area(part):
        left, top, right, bottom = bounds(points(part))
        return (right - left) * (bottom - top)
    left, top, right, bottom = bounds(points(max(parts, key=area)))
    cx, cy = (left + right) / 2, (top + bottom) / 2
    reach = lambda scale: max(((px - cx) * scale) ** 2 + ((py - cy) * scale + DROP) ** 2
                              for part in parts for px, py in points(part)) ** 0.5
    low, high = 0.0, 1.0  # the largest scale that still fits, by halving
    for _ in range(50):
        middle = (low + high) / 2
        if reach(middle) < SAFE_RADIUS:
            low = middle
        else:
            high = middle
    scale = low

    number = lambda n: f"{n:.2f}".rstrip("0").rstrip(".")
    place = lambda p: f"{number(CANVAS / 2 + (p[0] - cx) * scale)},{number(CANVAS / 2 + DROP + (p[1] - cy) * scale)}"
    path = "".join(command + " ".join(place(p) for p in ps) for part in parts for command, ps in part)

    OUT.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- The jukebox mark, written by make-icon.py from public/images/jukebox.svg. -->\n"
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        f'    android:width="{CANVAS}dp"\n'
        f'    android:height="{CANVAS}dp"\n'
        f'    android:viewportWidth="{CANVAS}"\n'
        f'    android:viewportHeight="{CANVAS}">\n'
        "    <path\n"
        '        android:fillColor="#FFFFFF"\n'
        f'        android:pathData="{path}" />\n'
        "</vector>\n"
    )
    print(f"cabinet {number((bottom - top) * scale)}dp tall, mark reaches {number(reach(scale))}dp from center")


if __name__ == "__main__":
    main()
