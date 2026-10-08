# Streaming services

WiiJukebox plays mainstream services through paths that use the listener's own
account and official or established open-source protocols. Nothing here
decrypts DRM (Widevine, FairPlay, PlayReady) or shares accounts.

| Service | Path | You need | Browse on the Wii | Status |
|---|---|---|---|---|
| Spotify | Spotify Connect receiver (librespot) | Premium, `librespot` binary | Start entry; the Spotify app controls playback | Built. Receiver starts and advertises over zeroconf; no real Spotify session was tested |
| Apple Music | AirPlay receiver (shairport-sync) | An iPhone, iPad or Mac, `shairport-sync` binary | Start entry; the sender controls playback | Built. Receiver, metadata pipe and cover art parsed against the real program; no Apple sender was tested |
| YouTube Music | music.youtube.com search plus yt-dlp | `yt-dlp` (and your browser cookies for Premium or your library) | Saved links, Liked Music with cookies | Built. Search, albums and playback were run live |
| Tidal | none | | | Not offered. See below |
| Amazon Music | none | | | Not possible. See below |
| Deezer | none | | | Not possible. See below |

## Receivers: Spotify Connect and AirPlay

A receiver is a program that runs next to the server and appears as a speaker
on the sending device. Audio arrives as raw PCM on the program's standard
output and goes through the same pipeline as every other source, so the Wii
sees one unbroken stream.

Receivers are push sources: the phone decides what plays. The web UI and the
Wii show now-playing text and cover art, and **Stop** ends the receiver (the
speaker disappears from the phone). Play, pause and skip stay on the phone.
Because the server does not know a receiver's position in the track, no seek
bar is drawn for them.

The Wii source browser lists a single "start" entry per receiver. Choosing it
starts the receiver and shows "Waiting for Spotify" (or AirPlay) until a phone
connects.

### Spotify Connect (librespot)

Requires Spotify Premium and [librespot](https://github.com/librespot-org/librespot).

```bash
cargo install librespot --locked --no-default-features --features native-tls,with-libmdns
```

Fedora, with `openssl-devel` installed, builds this in a few minutes. Put the
binary on `PATH` or set its full path under Spotify settings (`binary`).

- Device name, bitrate (96, 160 or 320) and volume normalization are settings.
- The Spotify app's own volume slider is ignored (`--volume-ctrl fixed`); the Wii
  has the volume control.
- The first connection from the Spotify app signs librespot in with that
  account. Credentials are cached under `<config dir>/spotify/` (mode 0700).
- Zeroconf needs multicast DNS on the LAN. It works alongside Avahi.

### AirPlay (shairport-sync)

Requires [shairport-sync](https://github.com/mikebrady/shairport-sync) built with
the `stdout` audio backend and metadata support. Classic AirPlay (AirPlay 1) is
lossless 44.1 kHz and is what the stdout backend is tested against here.
Apple Music, Podcasts, any app's audio and macOS system audio can use it.

On Fedora:

```bash
sudo dnf install autoconf automake gcc make libtool popt-devel libconfig-devel \
    openssl-devel avahi-devel ffmpeg-free-devel
git clone --depth 1 --branch 5.5.2 https://github.com/mikebrady/shairport-sync.git
cd shairport-sync
autoreconf -fi
./configure --prefix=$HOME/.local --sysconfdir=$HOME/.local/etc \
    --with-stdout --with-avahi --with-ssl=openssl --with-metadata --with-ffmpeg
make && make install
```

Build with `--with-ffmpeg`. Without it shairport-sync falls back to an older
ALAC decoder that rejected a test sender's stream in this project's testing.

- The `port` setting is passed through but shairport-sync 5.5.x ignores it for
  classic AirPlay, so it stays on 5000. Macs already use 5000 for their own
  AirPlay receiver, so run the server on a Linux host.
- A password is optional (`password`).
- Metadata arrives a little ahead of the audio. `latencyMs` (default 1500)
  delays the label to match.
- Not available on Windows.

## YouTube Music

Search uses the same public endpoint as the music.youtube.com page (as
open-source clients such as ytmusicapi do) and needs no account. Playback is
yt-dlp, so everything the YouTube / SoundCloud source supports applies.

- Search returns songs, albums, playlists and artists. An artist result opens
  that artist's albums.
- Albums and playlists queue completely. Picking a track inside one starts there.
- For Premium audio quality and "Liked Music", add your browser cookies under
  Settings, Advanced, extra yt-dlp options:
  `--cookies-from-browser firefox`.
- If the search endpoint changes, the source falls back to titles from yt-dlp's
  own search.

## Why not Tidal, Amazon Music and Deezer

**Tidal.** Its public developer API gives metadata only. Streaming needs the
private API that Tidal's own apps use, signed in with one of those apps' OAuth
client identities, which Tidal's terms do not allow third parties to use.
Alternative: Tidal Connect is closed, but the Tidal app can play over AirPlay
from an Apple device, or be captured with the Desktop audio source.

**Amazon Music.** Streams are delivered with Widevine. Amazon offers no
receiver protocol or public streaming API to third parties, and there is no
supported way to get an unencrypted stream. Decrypting it would circumvent DRM.
Alternative: use Amazon Music on a phone or computer and capture it with the
Desktop audio source (Linux), or play it over AirPlay from an Apple device.

**Deezer.** The public API provides 30-second previews. Full tracks are served
in a Blowfish-encrypted form that third-party tools decrypt with keys taken from
Deezer's own player, which circumvents the service's protection and breaks its
terms. There is no Connect-style receiver. Alternative: Deezer in a browser or
app with Desktop audio capture, or AirPlay from an Apple device.

**Apple Music directly.** MusicKit streams are FairPlay-protected, so Apple
Music is only offered through the AirPlay receiver, where Apple's own devices
send the audio.

## Third-party code and assets

| Item | Use | License |
|---|---|---|
| [librespot](https://github.com/librespot-org/librespot) | Spawned as a separate program, not bundled | MIT |
| [shairport-sync](https://github.com/mikebrady/shairport-sync) | Spawned as a separate program, not bundled | MIT and BSD-style (see its LICENSES folder) |
| [ytmusicapi](https://github.com/sigma67/ytmusicapi) | Search request format followed; no code copied | MIT |
| [Nunito](https://github.com/googlefonts/nunito) (`public/fonts/`) | Web UI typeface, latin subset | SIL OFL 1.1 (`public/fonts/OFL.txt`) |
| `public/images/*` | WiiRadio logo and tile, kept from the original project | See `client/vendor/README.md` |

## Testing without the real programs

`test/spotify.test.js`, `test/airplay.test.js` and `test/ytmusic.test.js` use small fake programs and fixture HTTP servers, so
`npm test` never contacts a streaming service. `test/helpers/fake-binary.js`
writes the fakes.
