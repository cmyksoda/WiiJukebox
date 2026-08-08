<img src="./public/images/logo.webp" alt="WiiStreamMusic" width="360">

**One persistent audio stream for your Wii, fed from any source you like.**

WiiStreamMusic is a rework of [wiiradio-stream-bridge](https://github.com/cmyksoda/wiiradio-stream-bridge).
Where the bridge converted individual internet radio stations into Wii-playable
mounts, this serves **a single stream that never stops**, and lets you change
what feeds it from a web interface.

That difference is the whole design. Because the stream address never changes,
you set up the Wii **once** — one `.pls` file on the SD card, forever — and
everything after that happens in the browser. Switching from a Navidrome album
to a radio station to your phone over Bluetooth doesn't interrupt the Wii at
all; it just starts playing something else.

> **Status: early.** The core pipeline, internet radio, Navidrome/Subsonic,
> Jellyfin and the WebUI work today. Plex, yt-dlp, the AirPlay/Bluetooth
> receivers and the standalone packaging are still to come — see
> [Roadmap](#roadmap).

## How it works

```
source ──> decoder ──> pacer ──> encoder ──> broadcaster ──> Wii
           (to PCM)   (real-    (to MP3)    (ICY fan-out)
                       time)
```

Everything from the pacer rightwards starts at boot and runs until shutdown.
Only the left-hand side is ever torn down, and the pacer fills the gap with
silence while a source is swapped — so the Wii's connection is never dropped.

This matters more than it sounds: WiiRadio falls back to its station list the
moment a stream ends. If the mount went down on every track change you'd have to
walk back through the Wii's menus each time.

**There is no Icecast.** The old bridge needed it to juggle 20 mountpoints; with
exactly one, `src/core/broadcaster.js` speaks ICY directly. That removes the
second container entirely, which is what makes a single self-contained
executable possible.

## Sources

| Source | Audio | Control & metadata | Status |
|---|---|---|---|
| Internet radio | Direct | ICY titles, split into artist/title | ✅ Working |
| Navidrome / Subsonic | Direct | Full library browse, search, queue | ✅ Working |
| Jellyfin | Direct | Full library browse, search, queue | ✅ Working |
| Plex | Direct | Browse + Plex Companion cast target | ⏳ Planned |
| YouTube, SoundCloud, Bandcamp | yt-dlp | Search + URL paste | ⏳ Planned |
| Spotify | AirPlay | Official Web API — seek, shuffle, queue | ⏳ Planned |
| Apple Music, Tidal, anything | AirPlay | DACP back-channel | ⏳ Planned |
| Any phone | Bluetooth | AVRCP | ⏳ Planned |
| Any app on this PC | Loopback capture | Whatever the app exposes | ⏳ Planned |

### A note on the closed platforms

Spotify, Apple Music and Tidal have **no API that returns audio**. Spotify's Web
API is metadata and remote control only, and the 30-second preview URLs were
removed. So rather than relying on unofficial clients, WiiStreamMusic takes the
audio via **receiver protocols** — it advertises itself as an AirPlay 2 speaker
and a Bluetooth sink, and you cast to it from whatever app you already use.

That's fully legitimate, needs no credentials, and covers every platform at once
including ones that don't exist yet. Transport controls still work, because
AirPlay carries DACP and Bluetooth carries AVRCP — both let the receiver send
play/pause/next back to the sender. For Spotify specifically, the official Web
API gives richer control still (seek, shuffle, queue) on top of AirPlay audio.

## Requirements

- Node 20+
- `ffmpeg` on your PATH

## Running

```bash
npm install
npm start
```

Then open the address it prints. On first run it auto-detects your LAN IP —
override it in the WebUI if it picks the wrong interface (VPNs and docker
bridges are the usual culprits).

### Setting up the Wii, once

1. Click **Download playlist** in the WebUI.
2. Put the `.pls` in `/apps/radiow/data/pls/` on your SD card.
3. Open it in WiiRadio.

That's it, permanently. From then on you control everything from the browser.

## Testing

```bash
npm run smoke
```

This runs the pipeline against real ffmpeg and asserts the claim the whole
project rests on: that a listener stays connected, with unbroken audio, while
sources are swapped underneath. It also checks ICY framing, bitrate accuracy and
fast-source backpressure.

## Visualizer

The WebUI includes a Butterchurn visualizer (380 milkdrop presets from `base`,
`extra` and `md1`). It needs the browser to be decoding the stream, so turning it
on starts local monitoring too. Press <kbd>Esc</kbd> to exit.

The 565 `.milk` presets in `assets/projectm/` are the vanilla WiiRadio set,
vendored for the Wii-side homebrew app — confirmed working on real hardware.

## Roadmap

- [x] Persistent stream core (ICY broadcaster, pacer, encoder)
- [x] Internet radio
- [x] Navidrome / Subsonic
- [x] Jellyfin
- [x] WebUI with library browsing and Butterchurn
- [ ] Plex (browse + Companion cast target)
- [ ] Jellyfin cast target ("Play On")
- [ ] yt-dlp source
- [ ] AirPlay 2 receiver + DACP control
- [ ] Bluetooth A2DP sink + AVRCP control
- [ ] Loopback capture
- [ ] Spotify Web API control layer
- [ ] Single Linux executable, no Node required
- [ ] Dedicated homebrew app (architecture TBD)

## Credits

Built on the work of Scanff, Knarrff and everyone else who worked on
[WiiRadio](https://github.com/scanff/wiiradio).

The lightning bolt/radio tower icon and the WebUI background were designed by
TiMeBoMb of the original team. Wii Sans font by
[NotSoArtisty](https://www.deviantart.com/notsoartisty/art/Wii-Sans-v2-824335667).

Visualizer presets via [Butterchurn](https://github.com/jberg/butterchurn);
integration approach follows the feishin fork's merge strategy.

[Deroverda's Recommended Radio Streams](https://github.com/deroverda/recommended-radio-streams)
is a good source of stations to try.

## License

GPL-3.0, inherited from wiiradio-stream-bridge.
