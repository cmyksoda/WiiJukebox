#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Fails unless the FFmpeg in <build dir> is our own LGPL build, with nothing GPL-only or nonfree.
set -euo pipefail

dir=${1:?usage: check-ffmpeg.sh <build dir>}
bin=$dir/ffmpeg
[ -f "$bin" ] || bin=$dir/ffmpeg.exe
conf=$(strings "$bin" | grep -m1 -e '--extra-version=wiijukebox' || true)
if [ -z "$conf" ]; then
    echo "$bin is not our FFmpeg build" >&2
    exit 1
fi
echo "$conf"
case $conf in
    *--enable-gpl* | *--enable-nonfree* | *fdk*)
        echo "$bin enables GPL-only or nonfree code" >&2
        exit 1
        ;;
esac
grep -q 'licensed LGPL v3' "$dir/ffmpeg-README.txt"
grep -q 'GNU LESSER GENERAL PUBLIC LICENSE' "$dir/ffmpeg-LICENSE.txt"
echo "$bin is LGPL v3 only"
