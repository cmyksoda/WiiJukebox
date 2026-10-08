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
The prototype supports IPv4; it does not have a manual-address entry fallback.

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

## Controls

| Wii Remote input | Action |
|---|---|
| Up / Down | Select a row |
| A | Select server/source; open container; play track/station |
| B (release) | Back |
| Left / Right | Previous/next library page |
| 2 | Play selected track, station, album or playlist |
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
container; 2 queues its entirety. The Wii displays 12 entries per page, while
complete playlist queues stay on the server. Both normal MD5-token authentication
and a reverse-proxy deployment prefix were exercised with a real fixture.

## Protocol

See [PROTOCOL.md](PROTOCOL.md). The audio socket requests no ICY metadata and reads
unframed MP3. Structured song information arrives through `/api/wii/status` every
three seconds. Network and text parsing are shared with a host-compiled C probe.
The source selector can reach every configured server adapter.

Text payloads are percent-encoded tab-separated fields. Buffers are bounded:
80 KB response body, 8 KB HTTP headers, 16 rows, 7 fields/row, 1,024 decoded bytes
per field, 8 discovered servers and 16 folder levels. Invalid framing fails the
request. Visible text is sanitized for terminal controls; non-ASCII bytes show
as `?` until a proper font renderer replaces the console.

## Still missing / unverified

- Physical Wii audio, Wi-Fi jitter, HOME/power behavior and long reconnect runs.
- A verified emulator render: the isolated offscreen boot produced no frames.
- Graphical library/now-playing UI, cover art, pointer support, text input and
  the projectM visualizer. There is no Wii search keyboard yet.
- Authentication between LAN controllers and the server, manual addressing,
  IPv6 discovery, TLS on the Wii-to-server connection, queue editing and seeking.
- Real Plex/Jellyfin account tests and actual desktop monitor capture testing.

Original client code is GPL-3.0-only. See the repository LICENSE. libogc/libmad/
ASND/libfat retain their upstream licenses; obtain their corresponding sources
from devkitPro when distributing a linked binary.
