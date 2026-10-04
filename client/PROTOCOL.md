# Wii protocol version 1

The existing JSON API remains for the web UI. These additions keep service
credentials and full provider metadata on the server and give the Wii a small,
bounded parser. This is an initial protocol and not a public compatibility promise.

## Discovery

Client sends `WIIJUKEBOX_DISCOVER\t1\t<16 lowercase hex nonce>\n` to IPv4 UDP
broadcast port 4001. Server unicasts back to the sender's port:

```text
WIIJUKEBOX<TAB>1<TAB>nonce<TAB>server UUID<TAB>HTTP port<TAB>encoded name<TAB>encoded mount<LF>
```

Name/mount use URI percent encoding. The client verifies nonce/version and uses
the datagram sender's IPv4 address. The full UUID is persisted in server config
and on the Wii. Replies are bounded to 20 per second per server; discovery bind
failure is logged but does not prevent HTTP/audio startup.

## HTTP text responses

Each response starts with literal `WIIJUKEBOX\t1\n`. Following lines contain
URI-percent-encoded UTF-8 fields separated by tabs and terminated by LF. Every
field is encoded independently, including empty fields. Responses include
Content-Length and no-store. The Wii uses HTTP/1.0 and requests Connection: close.

| Request | Rows after the header |
|---|---|
| GET `/api/wii/info` | `server`, UUID, name, mount |
| GET `/api/wii/sources` | `source`, source ID, label, state (configured sources only) |
| GET `/api/wii/browse?source=...&ref=...&offset=...` | `page`, offset, total; then `item`, opaque reference, type, title, subtitle |
| POST `/api/wii/play?source=...&ref=...` | `ok`, `accepted`; work finishes asynchronously |
| POST `/api/wii/control?action=...` | `ok`, `accepted`; work finishes asynchronously |
| GET `/api/wii/status` | `status`, title, artist, playback state, source label, comma-separated supported controls; then `command`, last command result |

An empty browse ref opens the source root. Browse pages contain 12 entries.
Opaque item references last one hour and are scoped to their source. At most
4,096 are retained; oldest entries are evicted. A stale selection returns a
readable error and requires browsing again. References are navigation handles,
not authorization tokens. Source IDs remain strings, and provider IDs never need
to fit Wii integer types.

Synchronous errors use HTTP 400 and an `error`, message row. Unknown endpoints
use 404. Async commands expose “Working...”, “Done”, “End of queue” or an error in
status; another Wii command is refused while one is running. Web and Wii
transport operations share the same serialized pipeline.

The text protocol bounds each field to 256 Unicode code points, repairs lone
surrogates and removes NUL. Delimiters and control characters are escaped on the
wire. Client display sanitization is separate from parsing.

## Audio

GET the discovered mount without `Icy-MetaData: 1`. The existing broadcaster
returns 128 kbps, 44.1 kHz stereo MP3, close-delimited and without chunk framing.
The client rejects chunked or ICY-interleaved responses. Header reads stop exactly
at CRLFCRLF, preserving the first audio bytes. The socket stays connected across
source changes, pause, stop and queue transitions. Disconnects start retries.

The protocol assumes a trusted LAN. UUIDs and nonce echo prevent accidental
mismatches, not a malicious LAN peer. There is no controller authentication.
