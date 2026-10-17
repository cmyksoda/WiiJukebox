#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Builds the FFmpeg the desktop app ships, from pinned sources: LGPL v3 with LAME, zlib and a TLS
# library, and nothing GPL-only or nonfree. Usage: build-ffmpeg.sh <target> <output dir>
#   sources    only downloads and checks the source archives, into the output dir
#   linux-x64  on an old glibc (scripts/build.js runs it in AlmaLinux 8, glibc 2.28)
#   win-x64    cross-built with mingw-w64
#   mac-arm64, mac-x64  on a Mac with the Xcode command line tools (and nasm for mac-x64)
# Stays bash 3.2 compatible for macOS.
set -euo pipefail

target=${1:?usage: build-ffmpeg.sh <linux-x64|win-x64|mac-arm64|mac-x64> <output dir>}
out=${2:?usage: build-ffmpeg.sh <target> <output dir>}
sources=${WIIJUKEBOX_BUILD_SOURCES:-$HOME/.cache/wiijukebox-desktop/ffmpeg-src}
work=${WIIJUKEBOX_BUILD_WORK:-$HOME/.cache/wiijukebox-desktop/ffmpeg-work}/$target
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)

FFMPEG=8.1.3
LAME=3.100
ZLIB=1.3.2
OPENSSL=3.5.9
# name|url|sha256; each signature was checked once when its checksum was pinned.
SOURCES="
ffmpeg-$FFMPEG.tar.xz|https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz|7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
lame-$LAME.tar.gz|https://downloads.sourceforge.net/project/lame/lame/$LAME/lame-$LAME.tar.gz|ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
zlib-$ZLIB.tar.gz|https://github.com/madler/zlib/releases/download/v$ZLIB/zlib-$ZLIB.tar.gz|bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
openssl-$OPENSSL.tar.gz|https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL/openssl-$OPENSSL.tar.gz|603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
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
    linux-x64) exe=ffmpeg tls=openssl threads=pthreads ;;
    win-x64) exe=ffmpeg.exe tls=schannel threads=w32threads cross=x86_64-w64-mingw32 ;;
    mac-arm64) exe=ffmpeg tls=securetransport threads=pthreads arch=arm64 ;;
    mac-x64) exe=ffmpeg tls=securetransport threads=pthreads arch=x86_64 ;;
    *) echo "unknown target $target" >&2; exit 1 ;;
esac

unpack() {
    tar -xf "$sources/$1" -C "$work"
}

fetch
rm -rf "$work"
mkdir -p "$work"
prefix=$work/prefix
export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig

flags=""
host_flag=""
if [ -n "${arch:-}" ]; then
    flags="-arch $arch -mmacosx-version-min=11.0"
    # LAME's 2017 config scripts know Apple silicon only by its aarch64 name.
    host_flag="--build=$(uname -m | sed s/arm64/aarch64/)-apple-darwin --host=$(echo "$arch" | sed s/arm64/aarch64/)-apple-darwin"
fi
[ -z "${cross:-}" ] || host_flag="--host=$cross"
export CFLAGS="-O2 $flags" LDFLAGS="$flags"

unpack "lame-$LAME.tar.gz"
(
    cd "$work/lame-$LAME"
    ./configure --prefix="$prefix" $host_flag --disable-shared --enable-static \
        --disable-frontend --disable-decoder --disable-gtktest
    make -j"$jobs"
    make install
)

# macOS has zlib in the SDK; elsewhere it is linked in so nothing beyond the C library is needed.
if [ -z "${arch:-}" ]; then
    unpack "zlib-$ZLIB.tar.gz"
    (
        cd "$work/zlib-$ZLIB"
        if [ -n "${cross:-}" ]; then
            make -f win32/Makefile.gcc PREFIX="$cross-" -j"$jobs" libz.a
            make -f win32/Makefile.gcc PREFIX="$cross-" SHARED_MODE=0 install \
                BINARY_PATH="$prefix/bin" INCLUDE_PATH="$prefix/include" LIBRARY_PATH="$prefix/lib"
        else
            ./configure --static --prefix="$prefix"
            make -j"$jobs"
            make install
        fi
    )
fi

if [ "$tls" = openssl ]; then
    unpack "openssl-$OPENSSL.tar.gz"
    (
        cd "$work/openssl-$OPENSSL"
        # Without certificate checks (FFmpeg 8's default) the config directory is never read.
        ./Configure linux-x86_64 no-shared no-docs no-tests no-module no-engine \
            --prefix="$prefix" --libdir=lib --openssldir=/etc/ssl
        make -j"$jobs" build_libs
        make install_dev
    )
fi

unpack "ffmpeg-$FFMPEG.tar.xz"
# The server only writes MP3, raw PCM and resized cover art.
encoders=libmp3lame,pcm_s16le,rawvideo,mjpeg,png
muxers=mp3,pcm_s16le,rawvideo,mjpeg,image2,image2pipe,wav,null
configure=(
    --prefix="$prefix" --pkg-config-flags=--static --extra-version=wiijukebox
    --enable-version3 --disable-autodetect --disable-debug --disable-doc
    --disable-ffplay --disable-ffprobe
    --enable-"$threads" --enable-"$tls" --enable-zlib --enable-libmp3lame
    --disable-encoders --enable-encoder="$encoders"
    --disable-muxers --enable-muxer="$muxers"
    --disable-indevs --enable-indev=lavfi --disable-outdevs
    --extra-cflags="-I$prefix/include $flags" --extra-ldflags="-L$prefix/lib $flags"
)
if [ -n "${cross:-}" ]; then
    configure+=(--arch=x86_64 --target-os=mingw32 --cross-prefix="$cross-" --extra-ldexeflags=-static)
elif [ -n "${arch:-}" ]; then
    configure+=(--cc=clang)
    [ "$(uname -m)" = "$arch" ] || configure+=(--enable-cross-compile --arch="$arch" --target-os=darwin)
fi
(
    cd "$work/ffmpeg-$FFMPEG"
    ./configure "${configure[@]}" || { tail -40 ffbuild/config.log; exit 1; }
    # configure skips a misspelled component without a word.
    for kind in encoder muxer; do
        list=$encoders
        [ "$kind" = encoder ] || list=$muxers
        for name in $(echo "$list" | tr , ' '); do
            upper=$(echo "${name}_$kind" | tr '[:lower:]' '[:upper:]')
            grep -q "^#define CONFIG_$upper 1" config_components.h || { echo "no $kind named $name" >&2; exit 1; }
        done
    done
    make -j"$jobs"
    make install
)

mkdir -p "$out"
cp "$prefix/bin/$exe" "$out/$exe"
licenses=$out/ffmpeg-LICENSE.txt
{
    echo "FFmpeg $FFMPEG is licensed under the GNU LGPL version 3, whose text follows, then the GNU GPL"
    echo "version 3 it builds on. After them come the licenses of the libraries built into it."
    echo
    cat "$work/ffmpeg-$FFMPEG/COPYING.LGPLv3"
    echo
    cat "$work/ffmpeg-$FFMPEG/COPYING.GPLv3"
    echo
    echo "==== LAME $LAME (GNU LGPL version 2) ===="
    cat "$work/lame-$LAME/COPYING"
    if [ -z "${arch:-}" ]; then
        echo
        echo "==== zlib $ZLIB ===="
        cat "$work/zlib-$ZLIB/LICENSE"
    fi
    if [ "$tls" = openssl ]; then
        echo
        echo "==== OpenSSL $OPENSSL (Apache License 2.0) ===="
        cat "$work/openssl-$OPENSSL/LICENSE.txt"
    fi
} > "$licenses"
{
    echo "FFmpeg $FFMPEG built for WiiJukebox ($target), licensed LGPL v3 (see ffmpeg-LICENSE.txt)."
    echo "No GPL-only or nonfree parts are enabled."
    echo
    echo "Built from these unmodified sources by packaging/desktop/scripts/build-ffmpeg.sh in the"
    echo "WiiJukebox repository; each WiiJukebox release also carries them as a source download."
    echo "$SOURCES" | while IFS='|' read -r name url sum; do
        [ -n "$name" ] || continue
        case $name in
            zlib-*) [ -z "${arch:-}" ] || continue ;;
            openssl-*) [ "$tls" = openssl ] || continue ;;
        esac
        echo "  $url"
        echo "    sha256 $sum"
    done
    echo
    echo "FFmpeg configuration:"
    printf '  %s\n' "${configure[@]}" | sed "s|$prefix|<prefix>|g"
} > "$out/ffmpeg-README.txt"
rm -rf "$work"
echo "built $out/$exe"
