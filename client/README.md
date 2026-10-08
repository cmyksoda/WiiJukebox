# WiiJukebox native client prototype

This is a real devkitPPC/libogc app, with a console UI, background control worker
and libmad/ASND streaming audio. A successful build and host tests do not establish
physical Wii playback. The current DOL needs a Wii test before wider use.

## Build and install

```bash
make -C client
```

Requires devkitPPC and libogc, normally under `/opt/devkitpro`. The build uses
`-Wall -Wextra -Werror` and links libfat, wiiuse, libmad and ASND.
Copy `client/dist/apps/wiijukebox` to `sd:/apps/wiijukebox`. Start the server using
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
only that remembered server is auto-selected. Failed stream connections trigger
another discovery attempt after three retries; the remembered UUID can then
resolve to a different IP. Discovery retries every five seconds while a saved
server is absent. **This ID is an identifier, not authentication or a secret.**

Without writable SD, selection works for that run but is not saved. Returning
from the source screen to the server chooser lets you explicitly select a
different server. Source settings and favorites remain on the host.

The audio worker keeps a 64 KiB compressed buffer and starts decoding after
32 KiB (about two seconds at 128 kbps). The decoder reads memory instead of
waiting for the network. If it runs dry, playback refills before restarting.
The bottom rows show buffered seconds, audio restart count, and transient status.
An audio restart means the decoder stopped and needed recovery; this does not
count ordinary background top-ups, or every possible output underrun. Short
network gaps get a bounded 50 ms wait before the decoder treats them as EOF.
Navigation movement stays
responsive during requests; open/back and transport presses wait for the current
request to finish. Curly quotes and dashes are converted for the ASCII font.

## Controls

| Wii Remote input | Action |
|---|---|
| Up / Down | Select a row |
| A | Select server/source; open container; play track/station (continue the album/playlist from that track) |
| B (release) | Back |
| Left / Right | Previous/next library page |
| 2 | Toggle projectM visualizer |
| Hold B + A | Play the current or highlighted album/playlist from the beginning |
| Hold B + Left / Right | Previous/next queued track |
| Hold B + 1 | Pause/resume a supported source |
| Hold B + 2 | Stop the source |
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
request. Visible text is sanitized for terminal controls; non-ASCII bytes show
as `?` until a proper font renderer replaces the console.

## Still missing / unverified

- Long Wi-Fi jitter/reconnect runs and HOME/power edge cases. The user has
  confirmed physical Wii music playback, browsing and projectM rendering.
- A verified emulator render: the isolated offscreen boot produced no frames.
- Graphical library/now-playing UI, cover art, pointer support and text input.
  There is no Wii search keyboard yet.
- Authentication between LAN controllers and the server, manual addressing,
  IPv6 discovery, TLS on the Wii-to-server connection, queue editing and seeking.
- Real Plex/Jellyfin account tests and actual desktop monitor capture testing.

Original client code is GPL-3.0-only. See the repository LICENSE. libogc/libmad/
ASND/libfat retain their upstream licenses; obtain their corresponding sources
from devkitPro when distributing a linked binary.

## projectM visualizer

Press **2** to toggle the projectM GX renderer. **B** returns
to the browser. Volume and B+transport work in either view; browser selection
and page controls are inactive while the visualizer is visible. Presets are
embedded, so no extra SD assets are needed when using wiiload. Random presets
change every 25 seconds with a 5-second blend. Original upstream notices and
source provenance are in `vendor/README.md` and `vendor/projectm/UPSTREAM.json`.

The browser shows `Page X / Y` and the visible item range. Network connection
status is shown on screen; HTTP diagnostics stay in the optional SD log.
Commands show acceptance first, then a matching server
result. Play/skip completion waits for decoded audio on the server; existing
stream buffering can still delay what reaches the speakers. Old completion
messages do not repeatedly replace browser messages.

An ASCII progress bar above HOME shows elapsed and total time; unknown durations
use `--:--`. The native client sends its first decoded MP3 byte position and
ASND-consumed sample time with status requests. The server maps that cursor onto
its PCM timeline, including pauses, source changes and silence. This accounts for
the compressed buffer, decoder read-ahead and initial output silence. A selected
track waiting behind buffered audio reads `Queued`, then `Playing` when reached.
The display updates once per second and does not measure downstream TV latency.
The native stream format remains 44.1 kHz stereo MP3, resampled to 48 kHz ASND.
