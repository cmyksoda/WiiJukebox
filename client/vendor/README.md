# Upstream components

WiiJukebox's original code is GPL-3.0-only. These imported components retain
all original notices and licenses.

## WiiRadio projectM

Source: https://github.com/scanff/wiiradio
Pinned commit: `58461f3e228912372051429edcc4fe3c90644657`.
A fresh clone of Scanff's upstream repository supplied every file, replacing the
initial exploratory copy from the locally modified WiiRadio workspace.

`projectm/UPSTREAM.json` records the original path and SHA-256 of every imported
file. `python3 tools/verify-projectm.py` checks that the vendored source and 565
Milkdrop presets remain byte-identical. The build skips the 111 listed in
`projectm/excluded-presets.txt`: 13 that produce NaN or Inf on a host run of the
engine, and 98 left out after a preset tour on a real Wii (duplicates, low quality,
broken or too laggy). The files themselves stay vendored unchanged. The engine subset includes original
headers/source in libprojectM, Renderer, MilkdropPresetFactory and omptl, plus
stb_image_aug and the original LGPL license. No local WiiRadio patches or
precompiled libraries are used.

The original engine uses LGPL-2.1-or-later notices; Scanff's GX wrapper is marked
GPL. omptl retains its LGPL notice and the bundled stb image decoder is public
domain. Preset names preserve the original creator credits.

## Added projectM 2.0.1 presets

`projectm/presets-extra/` holds 93 more presets, byte-identical to the official
projectM releases on <https://sourceforge.net/projects/projectm/files/>. Most come from
`projectM-complete-2.0.1-Source.tar.gz` (SHA-256
`c7e474002d718a9ef440e5eb99a2f84792e9bf0ceab3715aaa438e94c9a45fff`, matching SourceForge's
published checksum and the local WiiRadio-era copy). The rest come from libprojectM 0.99
and 1.0 and the 2.0.0 MilkDrop 2 preset pack, each archive also checked against
SourceForge's SHA-256. MilkDrop 2-format files qualify only without shader code.
`projectm/EXTRA.json` records each file's archive, path and SHA-256;
`tools/verify-projectm.py` checks both manifests.

They were chosen from the archive's MilkDrop 1.x folders after removing anything
already embedded (by content or name), MilkDrop 2 shader presets, user textures
and textured shapes. Every candidate was then loaded alone in the host engine
for 600 frames: presets whose equations the 2.0.1 parser dropped, that produced
NaN or infinity, or whose median frame cost or load heap exceeded the embedded
set's 90th/95th percentile were rejected. Host timings are x86 measurements
used only for comparison with the existing set, not Broadway performance. A preset
tour on a real Wii then removed the duplicates, low-quality, broken and too-laggy
presets from both sets.

WiiJukebox-specific integration:

- `client/source/visualizer.cpp`: GX/VI setup, toggle/back lifecycle, PCM feed,
  and random 25-second changes with 5-second blends. Like WiiRadio, the engine
  boots on "Aderrasi - Agitator.milk"; every entry then opens on a random preset.
  This replaces the WiiRadio application/SDL wrapper, not the renderer.
- `tools/embed-presets.py`: embeds the original and added preset files for wiiload.
- `tools/projectm-embedded-loader.py`: adds an in-memory alternative to
  `MilkdropPreset::loadPresetFile` in a generated build copy. The pristine
  upstream file remains unchanged.
- `client/projectm.mk`: current devkitPro build rules. The engine uses GNU C++98
  so upstream's original istream comparisons need no compatibility patch.

Upstream limitations remain: user textures and some filters are incomplete in
Scanff's GX port. This is the WiiRadio renderer, not current desktop projectM.
Host evaluation with no-op GX calls is not proof of rendered pixels or Wii
performance.

## libogc audio tap

`libogc/mp3player.c` is from devkitPro/libogc tag `v3.1.0`, matching the installed
library. Marked additions publish already-synthesized PCM for visualization and
pair the first decoded MP3 byte position and sample rate with ASND's sample
counter for playback timing. Output blocks are zero-padded when short instead of repeating stale
samples; padding is excluded from the playback clock. The player also joins its
decoder thread before starting another, even one that ended by itself, and marks
itself running before that thread starts: both threads share one static stack, so
a quick stop-and-restart (as a seek causes) could otherwise run a new decoder on
the old one's stack. Decoder and resampler algorithms are unchanged. This avoids synthesizing the same MP3 twice merely to
drive the visualizer. `libogc/LICENSE` is retained.

Source: https://github.com/devkitPro/libogc/blob/v3.1.0/libmad/mp3player.c

## Interface fonts

`fonts/Nunito-SemiBold-WiiJukebox.ttf` (Nunito, the web UI's typeface: Latin,
Cyrillic, punctuation and symbols) is the primary face. `fonts/NotoSans-Greek-WiiJukebox.ttf`
(Noto Sans 2.015: Greek) and `fonts/NotoSansCJKjp-Medium-WiiJukebox.otf` (Noto Sans
CJK JP 2.004: kana, fullwidth forms and the 2,965 JIS level 1 kanji) supply, in
that order, characters it lacks. All are under the SIL Open Font License 1.1
(`fonts/OFL.txt`, with every copyright notice, ships in the install archive).
`tools/subset-font.py` made them from `ofl/nunito/Nunito[wght].ttf` in
<https://github.com/google/fonts> at commit 604936664fd6 (weight 600), and Fedora's
`google-noto-sans-vf-fonts` 20251201 (weight 600) and `google-noto-sans-cjk-vf-fonts`
2.004 (weight 500), unmodified packages of <https://github.com/notofonts>. It
flattens Nunito's GPOS kerning into a legacy `kern` table, which FreeType's
`FT_Get_Kerning` reads. `fonts/FONT.json` records source and output SHA-256,
ranges and the fontTools version. Nunito and Noto Sans have no Reserved Font
Name; Noto CJK's is Adobe's "Source". All are linked into the DOL.

FreeType 2.14.1, libpng 1.6.55, zlib 1.3.1, bzip2 and brotli are linked from
devkitPro's portlibs; the install archive carries their licenses from
`$DEVKITPRO/portlibs/ppc/licenses`. FreeType is used under the FreeType License:
Portions of this software are copyright © 2025 The FreeType Project
(https://freetype.org). All rights reserved.

## Jukebox mark

The jukebox in the web UI (`public/images/jukebox.svg`, the favicons and
`apple-touch-icon.png`), the Wii header (`client/assets/jukebox-mark.i8`) and the
Homebrew Channel icon (`client/dist/apps/wiijukebox/icon.png`) is licensed
separately and **is not covered by the GPL**. `tools/make-wii-logo.py` renders the
Wii files from the SVG.

## Original project and asset credits

Built on the work of Scanff, Knarrff and everyone else who worked on
[WiiRadio](https://github.com/scanff/wiiradio).

The lightning bolt/radio tower icon and the WebUI background were designed by
TiMeBoMb of the original team. Wii Sans font by
[NotSoArtisty](https://www.deviantart.com/notsoartisty/art/Wii-Sans-v2-824335667).
