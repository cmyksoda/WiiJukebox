# Streaming services

WiiJukebox plays mainstream services through paths that use the listener's own
account and official or established open-source protocols. Nothing here
decrypts DRM (Widevine, FairPlay, PlayReady) or shares accounts.

| Service | Path | You need | Browse on the Wii | Status |
|---|---|---|---|---|
| Spotify | Spotify Connect receiver (librespot) | Premium, `librespot` binary | Start entry; the Spotify app controls playback | Built. Receiver starts and advertises over zeroconf; no real Spotify session was tested |
| Apple Music | AirPlay receiver (shairport-sync) | An iPhone, iPad or Mac, `shairport-sync` binary | Start entry; the sender controls playback | Built. Receiver, metadata pipe and cover art parsed against the real program; no Apple sender was tested |
| YouTube Music | music.youtube.com search plus yt-dlp | `yt-dlp` (and your browser cookies for Premium or your library) | Saved links, Liked Music with cookies | Built. Search, albums and playback were run live |
| Tidal | Official device-code login, then the v1 API | Tidal subscription, an OAuth client ID and secret (see below) | Playlists, favorite albums, tracks and artists | Built against a fixture server. Not tested with a real account |
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

## Tidal

Sign-in uses Tidal's device-code flow: the web UI shows a code and a link, you
approve on tidal.com, and the server stores refresh tokens (mode 0600 in
`config.json`). No password is typed into WiiJukebox.

**This is an unofficial interface.** Tidal's public developer API gives
metadata only. Streaming uses the same private API as Mopidy-Tidal and
tidalapi, and needs the OAuth client identity of a Tidal app. That identity is
not bundled with WiiJukebox. It is read from one of two places:

1. The `clientId` and `clientSecret` settings (Settings, Advanced), or
2. The Python package `tidalapi` if it is installed (`pip install tidalapi`),
   which the server queries once at sign-in.

Tidal's terms restrict unofficial clients. Use it on your own subscription at
your own risk.

- Only unencrypted streams are played. A track that reports encryption, or that
  Tidal offers only as a segmented stream, is skipped with a warning and never
  decrypted. Quality defaults to High (320 kbps AAC); Lossless asks for FLAC
  where Tidal returns a plain file.
- Hi-res (MQA, Atmos, 24-bit) is not requested. The pipeline encodes to 128 kbps
  MP3 for the Wii.
- Nothing is written to the account: no playlist edits, favorites or scrobbles.

## Why not Amazon Music and Deezer

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
| [tidalapi](https://github.com/tamland/python-tidal) / Mopidy-Tidal | API shapes (endpoint names, login flow, manifest fields) followed; no code copied | LGPL-3.0 |
| [ytmusicapi](https://github.com/sigma67/ytmusicapi) | Search request format followed; no code copied | MIT |
| [Nunito](https://github.com/googlefonts/nunito) (`public/fonts/`) | Web UI typeface, latin subset | SIL OFL 1.1 (`public/fonts/OFL.txt`) |
| `public/images/*` | WiiRadio logo and tile, kept from the original project | See `client/vendor/README.md` |

## Testing without the real programs

`test/spotify.test.js`, `test/airplay.test.js`, `test/ytmusic.test.js` and
`test/tidal.test.js` use small fake programs and fixture HTTP servers, so
`npm test` never contacts a streaming service. `test/helpers/fake-binary.js`
writes the fakes.
