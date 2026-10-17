#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Builds the librespot (Spotify Connect, MIT) the desktop app ships, from crates.io with its own
# lockfile. rustls stands in for OpenSSL, and only the pipe audio backend is built, since the server
# reads the audio from stdout. Usage: build-librespot.sh <target> <output dir>
#   linux-x64 (scripts/build.js runs it in AlmaLinux 8), win-x64 (cross-built with mingw-w64),
#   mac-arm64, mac-x64 (on a Mac)
# Stays bash 3.2 compatible for macOS.
set -euo pipefail

target=${1:?usage: build-librespot.sh <linux-x64|win-x64|mac-arm64|mac-x64> <output dir>}
out=${2:?usage: build-librespot.sh <target> <output dir>}
work=${WIIJUKEBOX_BUILD_WORK:-$HOME/.cache/wiijukebox-desktop/librespot-work}/$target

LIBRESPOT=0.8.0
RUST=1.99.1
RUSTUP=1.29.1
RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
FEATURES=rustls-tls-native-roots,with-libmdns

case $target in
    linux-x64) triple=x86_64-unknown-linux-gnu exe=librespot ;;
    win-x64) triple=x86_64-pc-windows-gnu exe=librespot.exe ;;
    mac-arm64) triple=aarch64-apple-darwin exe=librespot ;;
    mac-x64) triple=x86_64-apple-darwin exe=librespot ;;
    *) echo "unknown target $target" >&2; exit 1 ;;
esac

rm -rf "$work"
mkdir -p "$work"
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export PATH="$CARGO_HOME/bin:$PATH"
if ! command -v rustup >/dev/null; then
    curl -fsSL --retry 3 -o "$work/rustup-init" \
        "https://static.rust-lang.org/rustup/archive/$RUSTUP/x86_64-unknown-linux-gnu/rustup-init"
    echo "$RUSTUP_SHA256  $work/rustup-init" | sha256sum -c -
    chmod +x "$work/rustup-init"
    "$work/rustup-init" -y -q --no-modify-path --profile minimal --default-toolchain none
fi
rustup toolchain install "$RUST" --profile minimal --target "$triple"
[ "$target" != win-x64 ] || export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
case $target in mac-*) export MACOSX_DEPLOYMENT_TARGET=11.0 ;; esac

CARGO_PROFILE_RELEASE_STRIP=symbols cargo "+$RUST" install librespot --version "$LIBRESPOT" --locked --no-default-features --features "$FEATURES" \
    --target "$triple" --root "$work/root"

crate=$(find "$CARGO_HOME/registry/src" -maxdepth 2 -type d -name "librespot-$LIBRESPOT" | head -1)
(cd "$crate" && cargo "+$RUST" metadata --format-version 1 --locked --filter-platform "$triple" \
    --no-default-features --features "$FEATURES") > "$work/metadata.json"

mkdir -p "$out"
cp "$work/root/bin/$exe" "$out/$exe"
# MIT and Apache ask for their notices with the binary; MPL code (Symphonia) for a pointer to its source.
python3 - "$work/metadata.json" "$crate/LICENSE" "$LIBRESPOT" > "$out/librespot-LICENSE.txt" <<'EOF'
import json, os, sys

meta = json.load(open(sys.argv[1]))
packages = {p['id']: p for p in meta['packages']}
nodes = {n['id']: n for n in meta['resolve']['nodes']}
seen, stack = set(), [meta['resolve']['root']]
while stack:
    current = stack.pop()
    if current in seen:
        continue
    seen.add(current)
    for dep in nodes[current]['deps']:
        if any(kind['kind'] is None for kind in dep['dep_kinds']):
            stack.append(dep['pkg'])

print(f'librespot {sys.argv[3]} (MIT)\n')
print(open(sys.argv[2]).read())
print('Crates built into librespot, each with its source at https://crates.io/crates/<name>/<version>:\n')
for pkg in sorted((packages[i] for i in seen), key=lambda p: (p['name'], p['version'])):
    if pkg['name'] == 'librespot' or any('proc-macro' in t['kind'] for t in pkg['targets']):
        continue
    folder = os.path.dirname(pkg['manifest_path'])
    files = sorted(f for f in os.listdir(folder)
                   if f.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')) and os.path.isfile(os.path.join(folder, f)))
    print(f"==== {pkg['name']} {pkg['version']} ({pkg.get('license') or 'see below'}) ====")
    if pkg.get('authors'):
        print('Authors: ' + ', '.join(pkg['authors']))
    for name in files:
        print(open(os.path.join(folder, name), errors='replace').read())
    if not files:
        print('(the crate carries no license file)\n')
EOF
rm -rf "$work"
echo "built $out/$exe"
