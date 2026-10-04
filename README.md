<img src="./public/images/logo.webp" alt="WiiJukebox" width="360">

**A persistent music stream, a web controller, and a native Wii client prototype.**

WiiJukebox keeps one MP3 stream connected while its source changes. The server
fetches and decodes music; the Wii plays the stream and can browse and control it.
The web UI configures services, saves radio stations and links, and provides a
Butterchurn visualizer for browser playback.

The native client now builds with devkitPPC. Its networking code has been tested
on the host against the server and a real isolated Navidrome instance. **Physical
Wii playback and the native UI still need validation.** This is a development
checkpoint, not a release. See [the morning handoff](MORNING-HANDOFF.md) and
[client setup and controls](client/README.md).

## Sources

| Source | Available now | Validation in this checkpoint |
|---|---|---|
| Navidrome / Subsonic | Artists, albums, playlists, starred tracks, search, complete album/playlist queues | Real Navidrome 0.64.2 with generated music; native C client -> server -> Navidrome -> decoded MP3 |
| Internet radio | Direct HTTP(S) streams, saved stations, ICY titles | Generated HTTP audio and persistent-stream tests |
| Jellyfin | Existing library browsing, search and queues | Existing adapter; no live Jellyfin account tested here |
| Plex | Music libraries, artists, albums, audio playlists, search and queues | Local API fixture; real Plex account still needed |
| YouTube, SoundCloud, Bandcamp and other yt-dlp sites | Link playback, saved links, playlist queues; YouTube search | All 30 existing live YouTube checks passed; other sites depend on their extractors |
| Desktop audio on Linux | Select a PulseAudio / PipeWire-Pulse output monitor | Source selection tests; actual host capture still needs validation |

Desktop audio can carry audio played by a normal service app or browser. It does
not provide Spotify, Apple Music or Tidal account integration or remote controls.
AirPlay, Bluetooth, Plex Companion and Jellyfin “Play On” remain planned.

## Running the server

Requires Node 20+, FFmpeg, and `yt-dlp` for web-video/music links. Desktop audio
also needs `pactl`, a running PulseAudio-compatible session, and an FFmpeg build
with the `pulse` input device.

```bash
npm ci
npm start
```

Open the printed web address. Configuration is saved in
`~/.config/wiijukebox/config.json` (or below `XDG_CONFIG_HOME`). Use a separate
`XDG_CONFIG_HOME` when testing alongside another server.

The HTTP API is designed for a **trusted LAN**, with no account authentication
between controllers and WiiJukebox. Keep it off public port forwards. Service
credentials belong to the server; the Wii stores only the selected server ID.

## Navidrome setup

1. Choose **Navidrome / Subsonic** in the web UI.
2. Enter the server's base URL, username and Navidrome password. Include any
   deployment prefix, such as `https://music.example.com/navidrome`; omit `/rest`.
3. Connect, then browse Artists, Albums, Playlists or Starred. Search also works.
4. On the Wii choose the same source. **A** opens an album/playlist; **2** plays
   the complete selection. Left/right changes pages. A selected track plays alone.

The adapter uses the documented Subsonic 1.16.1 API and salted-token auth. It does
not depend on Navidrome's evolving native API. Password whitespace is preserved.
An SSO/reverse-proxy login page is not a Subsonic login; the configured account
must be able to authenticate to Navidrome's `/rest/` endpoints.

Browse pages contain 100 entries in the web UI and 12 on the Wii. Playing an album
or playlist queues the complete collection, including playlists longer than a
browse page. Track order follows the server. Scrobbling, ratings and editing
Navidrome playlists are not implemented.

## Wii setup

```bash
npm run build:client
```

With devkitPPC/libogc installed, this produces
`client/dist/apps/wiijukebox/boot.dol`. Copy that app directory to `sd:/apps/` and
launch it in Homebrew Channel. The Wii and server must share a LAN; discovery uses
UDP 4001, with control/audio on the server's HTTP port (4000 by default).

Choose the server by name and the ID shown in the web UI. Selection is saved on
SD and rediscovered by identity, so the IP address is not the saved identifier.
No `.pls` file or IP keyboard is needed for this client. Full controls and current
limits are in [client/README.md](client/README.md).

**WiiRadio compatibility remains:** download `/playlist.pls` into
`/apps/radiow/data/pls/`. Its address can become stale after a DHCP change; the
native discovery flow is the intended replacement.

## Saved links and desktop audio

Use **Save station for Wii** or **Save link for Wii** in the web UI to populate
the Wii source browser. Saved yt-dlp playlist/album links queue their contents.
Use the web UI for free-text searches and new URLs; the Wii has no keyboard yet.

Desktop audio lists output monitors, not microphones. Capture begins only when
you select one and ends on Stop or source change. It is not resumed automatically
when the server starts. Browser monitoring/visualization is disabled during
capture to prevent feeding the stream back into itself. Control the original
music app on the host; WiiJukebox cannot skip tracks in that app.

## Testing

```bash
npm test                 # host C parser/networking + isolated Node regressions
npm run smoke           # real FFmpeg, ICY framing, source swaps and backpressure
npm run build:client     # PowerPC build, warnings treated as errors
npm run test:ytdlp       # optional live internet/provider test
NAVIDROME_BINARY=/path/to/navidrome npm run test:navidrome
```

`npm test` needs a host C compiler and Make, but does not require devkitPPC.
The optional Navidrome test creates its own loopback instance, test account,
13 generated FLAC tracks and cover image, tests a 151-track playlist, and removes
its temporary instance afterward. It never uses a personal Navidrome library.
Tested with the official 0.64.2 Linux amd64 binary. See
[validation notes](client/VALIDATION.md) for exact evidence and remaining gaps.

## Architecture and next work

```text
source -> FFmpeg decoder -> PCM pacer -> MP3 encoder -> persistent broadcaster
                                  ^                         |
                       shared playback controls             Wii / browser
```

Pause preserves queued PCM while the persistent stream emits silence. Natural
track completion waits for buffered audio to drain before advancing. Source
changes and transport commands are serialized.

The Wii client uses UDP discovery, a bounded versioned text API for browsing and
metadata, and libogc/libmad for MP3. This first implementation is a text console;
artwork, a graphical UI, search input and the Wii projectM visualizer remain.
The existing 565 `.milk` presets are retained for that future work. Browser
visualization remains available through Butterchurn.

Other open work: physical Wii network/audio testing, Plex/Jellyfin account tests,
desktop capture validation, receiver protocols, service controls, queue editing,
and standalone server packaging. The earlier architecture notes are retained in
[HANDOFF.md](HANDOFF.md).

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
