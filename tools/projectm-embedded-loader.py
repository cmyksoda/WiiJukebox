#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Adapt upstream's file loader in build/, leaving vendored source byte-identical."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = root / 'client/vendor/projectm/MilkdropPresetFactory/MilkdropPreset.cpp'
text = source.read_text()
needle = 'int MilkdropPreset::loadPresetFile(const std::string & pathname)\n{'
assert text.count(needle) == 1
text = '#include <sstream>\n' + text.replace(needle, '''// WiiJukebox integration: presets may come from the executable instead of SD.
extern "C" const char *wj_builtin_preset(const char *path);
int MilkdropPreset::loadPresetFile(const std::string & pathname)
{
  if (const char *text = wj_builtin_preset(pathname.c_str())) {
    std::istringstream input(text);
    return readIn(input);
  }
''')
(root / 'client/build/embedded-MilkdropPreset.cpp').write_text(text)
