# WiiJukebox native client prototype

This is a real devkitPPC/libogc app with a GX interface in the style of the Wii
Menu, a background control worker and libmad/ASND streaming audio. Music playback,
browsing and projectM rendering were tested on a physical Wii with the earlier
console interface; the graphical interface has not yet run on hardware.

## Interface

A light, pinstriped background with Wii-blue accents. Servers and music sources
are channel-style tiles; folders and tracks are a list with type icons and
subtitles, and long selected titles scroll. The right-hand card shows album art
(fetched from `/api/wii/art`, with a note placeholder when there is none), the
title, artist, playback state, a seek bar with elapsed/total time, and
previous/play-pause/next/stop buttons. The dock at the bottom has Back and
Visualizer buttons in raised pods either side of the Wii's clock and date.
Messages appear as a pill above the dock and fade after about four seconds;
ones that describe an ongoing condition (loading, reconnecting, a pending
command) stay until it ends. When no server is found, the panel explains why
and what to do instead. Empty folders say so in the list. Volume changes show
a meter. The header reports the connection (with a colored dot), bitrate,
buffered seconds and audio restarts. Pointing at the album art and pressing A
(or holding B and pressing +) shows the cover large over a dimmed screen,
using a 192-pixel image from the server; A or B closes it. 16:9 consoles get a wider layout rather than stretched shapes.

Text is drawn with FreeType from embedded Nunito (Latin, Cyrillic), the web UI's
typeface, with its kerning applied, then Noto Sans (Greek) and Noto Sans CJK JP
(kana and common kanji) subsets; characters outside both,
such as Hangul or emoji, show a missing-glyph box instead of `?`. Building the host tests needs FreeType
development headers (`pkg-config freetype2`).

## Build and install

```bash
make -C client
```

Requires devkitPPC and libogc, normally under `/opt/devkitpro`. The build uses
`-Wall -Wextra -Werror` and links libfat, wiiuse, libmad and ASND.
Copy `client/dist/apps/wiijukebox` to `sd:/apps/wiijukebox`, or run `make -C client package`
and install over the network from Homebrew Channel with
`WIILOAD=tcp:<wii-ip> wiiload client/dist/WiiJukebox-client-wiiload.zip`. Start the server using
`npm ci && npm start`, configure sources in its web UI, then launch the app from
Homebrew Channel. Do not put upstream service passwords on the SD card.

Allow UDP 4001 and the configured HTTP port (default TCP 4000) on the host's LAN
interface. Guest Wi-Fi/client isolation or different subnets can block discovery.
The prototype supports IPv4. For networks that block broadcast discovery,
pass an IPv4 address and HTTP port as a launch argument, for example:

```sh
WIILOAD=tcp:192.168.0.8 wiiload client/dist/apps/wiijukebox/boot.dol 192.168.0.3:4280
```

The client initializes networking, verifies `/api/wii/info`, then selects that
server directly. An unavailable direct address falls back to discovery. Network
initialization errors and the Wii's assigned IP are shown on screen; failed
discovery retries automatically. During initialization, `1` cancels and restarts
the attempt. The screen shows the attempt number and elapsed seconds; a
30-second initialization deadline requests network cleanup before retrying.
There is no on-screen address keyboard yet.

For alternate ports, set `port` and `discoveryPort` in the server's `config.json`
and rebuild with the matching discovery port, for example
`make -C client package DISCOVERY_PORT=4281` for `discoveryPort: 4281`.
The build automatically recompiles when this port changes. The HTTP port is
advertised by discovery and does not need to be compiled into the client.

Select the server name and match its eight-character ID prefix to the web UI.
The complete UUID is saved in `sd:/apps/wiijukebox/server.id`. On future launches
only that remembered server is auto-selected. After three failed audio or status
attempts the client rediscovers in the background, every ten seconds, and moves
to the remembered UUID's new address without leaving the current screen.
Discovery retries every five seconds while a saved server is absent at startup.
**This ID is an identifier, not authentication or a secret.**

Without writable SD, selection works for that run but is not saved. Returning
from the source screen to the server chooser lets you explicitly select a
different server. Source settings and favorites remain on the host.

The audio thread owns the stream connection and a 384 KiB compressed buffer.
Sizes are durations at the advertised bitrate: decoding starts after two seconds
of audio, and the server's four-second burst is the normal buffer depth. If the
connection drops or stalls for three seconds, before the buffer runs dry, the
thread reconnects (0.25, 0.5,
1, 2, 2, then 3 seconds apart) and asks for the exact byte it stopped at, so a
short Wi-Fi gap continues without skipping or repeating audio. A gap the server
no longer holds, or a server restart, starts a fresh decoder run. After an
underrun, more than six seconds of backlog is trimmed to four, and more than
nine seconds while playing reconnects at the live edge, so recovery never
leaves controls lagging far behind. The decoder reads memory instead of waiting
for the network; short gaps get a bounded 50 ms wait before it treats them as
EOF. Status polling backs off to eight seconds while the server is unreachable
and keeps the last song on screen.

Seeking, next/previous, choosing something new and stop no longer wait for the
four buffered seconds of old audio to play out. The server reports the byte where
the change begins, the client jumps straight there and the server sends the
first new seconds at once (see "Jumps" in PROTOCOL.md). On the host this cut
seek-to-audible time from about 4.3 s to 0.3 s, measured with real-time playout;
a Wii adds its Wi-Fi round trip and decoder restart. Navigation movement stays responsive during
requests; open/back and transport presses wait for the current request to
finish.

## Controls

| Wii Remote input | Action |
|---|---|
| Point | Highlight a row or tile; buttons and the seek bar light up |
| Up / Down | Select a row; move between tile rows |
| A | Select server/source; open container; play track/station (continue the album/playlist from that track). When pointing at a button, press it |
| A on the seek bar | Seek there; hold A and move to preview, release to seek |
| B (release) | Back |
| Left / Right | Previous/next library page; move between tiles |
| 2 | Toggle projectM visualizer |
| Hold B + A | Play the current or highlighted album/playlist from the beginning |
| Hold B + Left / Right | Previous/next queued track |
| Hold B + 1 | Pause/resume a supported source |
| Hold B + 2 | Stop the source |
| Hold B + Up / Down | Seek 10 seconds forward/back; repeated presses add up, then it seeks |
| A on the album art, or hold B + + | Show the cover large; A or B closes it |
| + / - | Local Wii volume |
| 1 | Refresh current page / scan servers |
| HOME | Exit |

Wii commands that may need extraction are acknowledged immediately; status
polling reports completion/failure. They run one at a time. Control and browsing
use a worker so the UI can continue drawing while a request is in progress.
HOME waits for an in-flight bounded network operation before returning; a slow
network may delay exit. Audio/control latency also includes stream buffering.

## Navidrome

Use the web UI to connect **Navidrome / Subsonic**. Then the Wii can browse Artists,
Albums, Playlists and Starred without knowing the service credentials. A opens a
container; B + A queues its entirety, including when viewing its tracks. A on a
track queues the album/playlist and starts at that track. The Wii displays 12 entries per page, while
complete playlist queues stay on the server. Both normal MD5-token authentication
and a reverse-proxy deployment prefix were exercised with a real fixture.

## Protocol

See [PROTOCOL.md](PROTOCOL.md). The audio socket requests no ICY metadata and reads
unframed MP3. Structured song information arrives through `/api/wii/status` every
second during playback, three seconds while idle/paused, and twice per second
while a command is pending. Network and text parsing are shared with a host-compiled C probe.
The source selector can reach every configured server adapter.

Text payloads are percent-encoded tab-separated fields. Buffers are bounded:
80 KB response body, 8 KB HTTP headers, 16 rows, 7 fields/row, 1,024 decoded bytes
per field, 8 discovered servers and 16 folder levels. Invalid framing fails the
request. Control characters are skipped when text is drawn.

## Still missing / unverified

- Long Wi-Fi jitter/reconnect runs and HOME/power edge cases. The user has
  confirmed physical Wii music playback, browsing and projectM rendering.
- The graphical interface on hardware: GX rendering, the pointer, the
  visualizer handoff in both directions, and memory with projectM loaded.
- Text input; there is no Wii search keyboard yet.
- Authentication between LAN controllers and the server, manual addressing,
  IPv6 discovery, TLS on the Wii-to-server connection and queue editing.
- Real Plex/Jellyfin account tests and actual desktop monitor capture testing.

Original client code is GPL-3.0-only. See the repository LICENSE. libogc/libmad/
ASND/libfat retain their upstream licenses; obtain their corresponding sources
from devkitPro when distributing a linked binary.

## projectM visualizer

Press **2** to toggle the projectM GX renderer. **B** returns
to the browser. Volume and B+transport work in either view; browser selection
and page controls are inactive while the visualizer is visible. 545 presets are
embedded (111 WiiRadio presets are skipped, for invalid math or after a hardware
preset tour; see `vendor/projectm/excluded-presets.txt`), so no extra SD assets are needed when using wiiload. Each entry opens
on a random preset; presets then change every 25 seconds with a 5-second blend.

For checking every preset on hardware, `make -C client package PRESET_TOUR=1` builds
a preset tour instead: presets play in name order without changing on their own,
with `123/545  Name` at the bottom of the screen. Left and Right step one preset, Up
and Down step ten, and 1 flags or unflags the current preset in `sd:/apps/wiijukebox/flagged-presets.txt`. Original upstream notices and
source provenance are in `vendor/README.md` and `vendor/projectm/UPSTREAM.json`.

The list header shows the visible range, with page arrows when there is more
than one page. Network status is shown on screen; HTTP diagnostics stay in the
optional SD log.
Commands show acceptance first, then a matching server
result. Play/skip completion waits for decoded audio on the server; existing
stream buffering can still delay what reaches the speakers. Old completion
messages do not repeatedly replace browser messages.

The seek bar shows elapsed and total time; live streams read `Live`. The native client sends its first decoded MP3 byte position and
ASND-consumed sample time with status requests. The server maps that cursor onto
its PCM timeline, including pauses, source changes and silence. This accounts for
the compressed buffer, decoder read-ahead and initial output silence. A selected
track waiting behind buffered audio reads `Queued`, then `Playing` when reached.
The display updates once per second and does not measure downstream TV latency.

The stream defaults to 48 kHz stereo MP3 at 256 kbps. ASND plays 48 kHz without
resampling; mp3player's converter repeats or drops whole samples, so 44.1 kHz
streams lose detail on the Wii. The server's `config.json` can restore the
original format without rebuilding the client:

```json
"audio": { "bitrate": 128, "sampleRate": 44100 }
```

Restart the server after changing it. The client adapts its buffers and clock to
whatever the stream advertises.
