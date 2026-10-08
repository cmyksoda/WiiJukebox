#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Exercise upstream Wii preset parsing/evaluation on the host, with GX calls stubbed.
This deliberately cannot verify pixels, GX synchronization, or Wii performance.
"""
from pathlib import Path
import concurrent.futures
import re
import subprocess
root = Path(__file__).resolve().parents[1]
pm = root / 'client/vendor/projectm'
build = root / 'client/build/projectm-host'
shim = build / 'shim'
(shim / 'ogc').mkdir(parents=True, exist_ok=True)
texts = '\n'.join(p.read_text(errors='replace') for p in pm.rglob('*')
                  if p.suffix in ('.cpp', '.h', '.hpp') and p.is_file())
functions = set(re.findall(r'\b(GX_\w+|gu\w+|DCFlushRange)\s*\(', texts)) - {'GX_Settings'}
constants = set(re.findall(r'\bGX_[A-Z0-9_x]+\b', texts))
header = '''#pragma once
#include <cstdint>
#include <cstring>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32;
typedef int8_t s8; typedef int16_t s16; typedef int32_t s32;
typedef float f32; typedef double f64;
typedef float Mtx[3][4]; typedef float Mtx44[4][4];
struct GXColor { u8 r,g,b,a; };
struct GXTexObj { unsigned unused; };
struct guVector { float x,y,z; };
struct GXRModeObj { int fbWidth, efbHeight, aa; int sample_pattern[12][2], vfilter[7]; };
inline GXRModeObj *VIDEO_GetPreferredMode(void*) {
 static GXRModeObj mode = {640,480,0,{}, {}}; return &mode;
}
'''
for i, name in enumerate(sorted(constants)):
    header += f'#define {name} {i}\n'
for name in sorted(functions):
    header += f'inline void {name}(...) {{}}\n'
(shim / 'gccore.h').write_text(header)
for name in ['gctypes.h', 'ogc/gx.h', 'ogc/gu.h']:
    (shim / name).write_text('#include <gccore.h>\n')
subprocess.run(['python3', str(root/'tools/embed-presets.py')], check=True)
subprocess.run(['python3', str(root/'tools/projectm-embedded-loader.py')], check=True)
sources = []
for d in [pm, pm/'Renderer', pm/'MilkdropPresetFactory']:
    sources.extend(d.glob('*.cpp'))
    sources.extend(d.glob('*.c'))
sources += [pm/'Renderer/SOIL/stb_image_aug.c', root/'client/build/presets.cpp', root/'client/tests/projectm_test.cpp']
flags = ['-O1','-g','-D_WII_','-DDISABLE_NATIVE_PRESETS','-DPROJECTM_PREFIX=""','-DDATADIR_PATH=""']
for d in [shim, pm, pm/'Renderer', pm/'MilkdropPresetFactory', pm/'Renderer/SOIL', pm/'omptl', root/'client/source']:
    flags += ['-I'+str(d)]

def compile_source(source):
    relative = str(source.relative_to(root)).replace('/', '_')
    output = build / (relative + '.o')
    actual = source
    if source.name == 'MilkdropPreset.cpp': actual = root/'client/build/embedded-MilkdropPreset.cpp'
    # The host shim uses stdint; the original parser's stream test requires C++98.
    if source.name == 'Parser.cpp':
        actual = build/'Parser.cpp'
        actual.write_text(source.read_text().replace('fs == NULL', '!fs'))
    compiler = 'cc' if source.suffix == '.c' else 'c++'
    standard = '-std=gnu11' if source.suffix == '.c' else '-std=gnu++11'
    subprocess.run([compiler, standard, '-Wno-deprecated-declarations', '-Wno-write-strings', *flags,
                    '-c', str(actual), '-o', str(output)], check=True)
    return str(output)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    objects = list(pool.map(compile_source, sources))
program = build/'projectm_test'
subprocess.run(['c++', *objects, '-lm', '-o', str(program)], check=True)
subprocess.run([str(program)], check=True, timeout=120)
