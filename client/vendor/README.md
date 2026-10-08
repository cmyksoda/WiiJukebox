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
Milkdrop presets remain byte-identical. The engine subset includes original
headers/source in libprojectM, Renderer, MilkdropPresetFactory and omptl, plus
stb_image_aug and the original LGPL license. No local WiiRadio patches or
precompiled libraries are used.

The original engine uses LGPL-2.1-or-later notices; Scanff's GX wrapper is marked
GPL. omptl retains its LGPL notice and the bundled stb image decoder is public
domain. Preset names preserve the original creator credits.

WiiJukebox-specific integration:

- `client/source/visualizer.cpp`: GX/VI setup, separate visualizer framebuffers,
  toggle/back lifecycle, PCM feed, and random 25-second changes with 5-second
  blends. This replaces the WiiRadio application/SDL wrapper, not the renderer.
- `tools/embed-presets.py`: embeds the original preset files for wiiload.
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
pair the first decoded MP3 byte position with ASND's sample counter for playback
timing. Output blocks are zero-padded when short instead of repeating stale
samples; padding is excluded from the playback clock. Decoder and resampler
algorithms are unchanged. This avoids synthesizing the same MP3 twice merely to
drive the visualizer. `libogc/LICENSE` is retained.

Source: https://github.com/devkitPro/libogc/blob/v3.1.0/libmad/mp3player.c

## Original project and asset credits

Built on the work of Scanff, Knarrff and everyone else who worked on
[WiiRadio](https://github.com/scanff/wiiradio).

The lightning bolt/radio tower icon and the WebUI background were designed by
TiMeBoMb of the original team. Wii Sans font by
[NotSoArtisty](https://www.deviantart.com/notsoartisty/art/Wii-Sans-v2-824335667).
