#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Builds the shairport-sync (AirPlay receiver, MIT) the desktop app ships, from pinned sources, with
# popt, libconfig, OpenSSL and FFmpeg's ALAC and AAC decoders linked in. It has no Windows version.
# It announces itself through the system's mDNS service (Avahi, or Bonjour on macOS), since a second
# responder would contest the computer's host name with it.
# Usage: build-shairport.sh <target> <output dir>
#   sources    only downloads and checks the source archives, into the output dir
#   linux-x64  on an old glibc (scripts/build.js runs it in AlmaLinux 8, glibc 2.28)
#   mac-arm64, mac-x64  on a Mac with the Xcode command line tools
# Stays bash 3.2 compatible for macOS.
set -euo pipefail

target=${1:?usage: build-shairport.sh <linux-x64|mac-arm64|mac-x64> <output dir>}
out=${2:?usage: build-shairport.sh <target> <output dir>}
sources=${WIIJUKEBOX_BUILD_SOURCES:-$HOME/.cache/wiijukebox-desktop/shairport-src}
work=${WIIJUKEBOX_BUILD_WORK:-$HOME/.cache/wiijukebox-desktop/shairport-work}/$target
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)

SHAIRPORT=5.5.2
POPT=1.19
LIBCONFIG=1.8.2
OPENSSL=3.5.9
FFMPEG=8.1.3
# name|url|sha256
SOURCES="
shairport-sync-$SHAIRPORT.tar.gz|https://github.com/mikebrady/shairport-sync/archive/refs/tags/$SHAIRPORT.tar.gz|abcdb59674b6eedb4f3f6228f3c702e65d2cdc037231b0c48617fd90891b49e9
popt-$POPT.tar.gz|https://ftp.osuosl.org/pub/rpm/popt/releases/popt-1.x/popt-$POPT.tar.gz|c25a4838fc8e4c1c8aacb8bd620edb3084a3d63bf8987fdad3ca2758c63240f9
libconfig-$LIBCONFIG.tar.gz|https://hyperrealm.github.io/libconfig/dist/libconfig-$LIBCONFIG.tar.gz|e59ffb902dd5731d5d4e4fb81d3b989697615feab72dfd7c30618167b91a42ee
openssl-$OPENSSL.tar.gz|https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL/openssl-$OPENSSL.tar.gz|603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
ffmpeg-$FFMPEG.tar.xz|https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz|7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
"

sha256() {
    if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

fetch() {
    mkdir -p "$sources"
    echo "$SOURCES" | while IFS='|' read -r name url sum; do
        [ -n "$name" ] || continue
        file=$sources/$name
        if [ ! -f "$file" ]; then
            curl -fsSL --retry 3 -o "$file.part" "$url"
            mv "$file.part" "$file"
        fi
        actual=$(sha256 "$file")
        if [ "$actual" != "$sum" ]; then
            rm -f "$file"
            echo "$name: checksum $actual does not match the pinned $sum" >&2
            exit 1
        fi
    done
}

if [ "$target" = sources ]; then
    sources=$out
    fetch
    exit 0
fi

case $target in
    linux-x64) os=linux mdns=avahi openssl_target=linux-x86_64 ;;
    mac-arm64) os=darwin mdns=dns_sd openssl_target=darwin64-arm64-cc arch=arm64 ;;
    mac-x64) os=darwin mdns=dns_sd openssl_target=darwin64-x86_64-cc arch=x86_64 ;;
    *) echo "unknown target $target (shairport-sync has no Windows version)" >&2; exit 1 ;;
esac

unpack() {
    tar -xf "$sources/$1" -C "$work"
}

fetch
rm -rf "$work"
mkdir -p "$work"
prefix=$work/prefix
export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig PKG_CONFIG="pkg-config --static"

flags=""
host_flag=""
if [ -n "${arch:-}" ]; then
    flags="-arch $arch -mmacosx-version-min=11.0"
    host_flag="--build=$(uname -m | sed s/arm64/aarch64/)-apple-darwin --host=$(echo "$arch" | sed s/arm64/aarch64/)-apple-darwin"
fi
export CFLAGS="-O2 $flags" LDFLAGS="$flags"
# It links with g++, so carry the C++ runtime inside rather than needing libstdc++ installed.
[ -n "${arch:-}" ] || LDFLAGS="-static-libstdc++ -static-libgcc"

unpack "popt-$POPT.tar.gz"
(
    cd "$work/popt-$POPT"
    ./configure --prefix="$prefix" $host_flag --disable-shared --enable-static --disable-nls
    make -j"$jobs"
    make install
)

unpack "libconfig-$LIBCONFIG.tar.gz"
(
    cd "$work/libconfig-$LIBCONFIG"
    ./configure --prefix="$prefix" $host_flag --disable-shared --enable-static \
        --disable-cxx --disable-examples --disable-tests
    make -j"$jobs" -C lib
    make -C lib install
)

unpack "openssl-$OPENSSL.tar.gz"
(
    cd "$work/openssl-$OPENSSL"
    # AirPlay 1 only needs libcrypto, for the session key; nothing reads certificates.
    ./Configure "$openssl_target" no-shared no-docs no-tests no-module no-engine \
        --prefix="$prefix" --libdir=lib --openssldir=/etc/ssl
    make -j"$jobs" build_libs
    make install_dev
)

unpack "ffmpeg-$FFMPEG.tar.xz"
configure=(
    --prefix="$prefix" --pkg-config-flags=--static --enable-static --disable-shared
    --enable-version3 --disable-autodetect --disable-debug --disable-doc --disable-programs
    --disable-everything --enable-decoder=alac,aac --enable-pthreads --disable-x86asm
    --disable-avdevice --disable-avfilter --disable-swscale --disable-network
    --extra-cflags="$flags" --extra-ldflags="$flags"
)
if [ -n "${arch:-}" ]; then
    configure+=(--cc=clang)
    [ "$(uname -m)" = "$arch" ] || configure+=(--enable-cross-compile --arch="$arch" --target-os=darwin)
fi
(
    cd "$work/ffmpeg-$FFMPEG"
    ./configure "${configure[@]}" || { tail -40 ffbuild/config.log; exit 1; }
    make -j"$jobs"
    make install
)

unpack "shairport-sync-$SHAIRPORT.tar.gz"
features=(--with-os="$os" --with-stdout --with-pipe --with-metadata --with-"$mdns" --with-ssl=openssl --with-ffmpeg)
(
    cd "$work/shairport-sync-$SHAIRPORT"
    autoreconf -fi
    ./configure $host_flag --sysconfdir=/etc "${features[@]}" || { tail -40 config.log; exit 1; }
    make -j"$jobs"
)

mkdir -p "$out"
cp "$work/shairport-sync-$SHAIRPORT/shairport-sync" "$out/shairport-sync"
strip "$out/shairport-sync"
src=$work/shairport-sync-$SHAIRPORT
{
    echo "shairport-sync $SHAIRPORT (MIT, with the notices of the parts it includes), then the libraries"
    echo "built into it."
    echo
    cat "$src/LICENSES"
    echo
    echo "==== alac.c ===="
    sed -n '1,/\*\//p' "$src/alac.c"
    echo
    echo "==== tinyhttp ===="
    cat "$src/tinyhttp/LICENSE"
    echo
    echo "==== popt $POPT ===="
    cat "$work/popt-$POPT/COPYING"
    echo
    echo "==== libconfig $LIBCONFIG (GNU LGPL version 2.1) ===="
    cat "$work/libconfig-$LIBCONFIG/COPYING.LIB"
    echo
    echo "==== OpenSSL $OPENSSL (Apache License 2.0) ===="
    cat "$work/openssl-$OPENSSL/LICENSE.txt"
    echo
    echo "==== FFmpeg $FFMPEG libraries (GNU LGPL version 3, then the GNU GPL version 3 it builds on) ===="
    cat "$work/ffmpeg-$FFMPEG/COPYING.LGPLv3"
    echo
    cat "$work/ffmpeg-$FFMPEG/COPYING.GPLv3"
} > "$out/shairport-sync-LICENSE.txt"
{
    echo "shairport-sync $SHAIRPORT built for WiiJukebox ($target). See shairport-sync-LICENSE.txt."
    echo
    echo "Built from these unmodified sources by packaging/desktop/scripts/build-shairport.sh in the"
    echo "WiiJukebox repository; each WiiJukebox release also carries them as a source download."
    echo "$SOURCES" | while IFS='|' read -r name url sum; do
        [ -n "$name" ] || continue
        echo "  $url"
        echo "    sha256 $sum"
    done
    echo
    echo "shairport-sync configuration:"
    printf '  %s\n' "${features[@]}"
    echo "FFmpeg configuration:"
    printf '  %s\n' "${configure[@]}" | sed "s|$prefix|<prefix>|g"
} > "$out/shairport-sync-README.txt"
rm -rf "$work"
echo "built $out/shairport-sync"
