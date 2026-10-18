# Streaming services

WiiJukebox plays mainstream services through paths that use the listener's own
account and official or established open-source protocols. Nothing here
decrypts DRM (Widevine, FairPlay, PlayReady) or shares accounts. For your own
music server (Navidrome, Jellyfin or Plex), see
[Self-hosted music](self-hosted-services.md).

| Service | Path | You need | Browse on the Wii | Status |
|---|---|---|---|---|
| Spotify | Spotify Connect receiver (librespot) for audio, plus the Spotify Web API for your library and remote control | Premium, `librespot` binary, your own free Spotify developer app | Liked Songs, Playlists, Albums; pick a song or playlist and play, pause and skip from the Wii or web | Built and tested against a fake Spotify and a fake librespot; no real Spotify account was tested. Without the developer app it stays a plain receiver |
| AirPlay (Apple Music and any other app) | AirPlay receiver (shairport-sync) | An iPhone, iPad or Mac; `shairport-sync`, which the desktop app includes on Linux and macOS | Start entry; the sender controls playback | Built. Run end to end through the server with a stand-in AirPlay 1 sender (encrypted ALAC, now playing); cover art parsed against the real program; no Apple device was tested |
| YouTube Music | music.youtube.com search plus yt-dlp | `yt-dlp` (and your browser cookies for Premium or your library) | Saved links, Liked Music with cookies | Built. Search, albums and playback were run live |
| Podcasts | Apple's iTunes search and chart, then each show's own RSS feed | Nothing | Subscriptions, Top shows | Built. Search, the chart, a feed and one episode with seeking were run live |
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
speaker disappears from the phone). Play, pause and skip stay on the phone,
except for Spotify with a developer app connected (see below). Because the
server does not know a receiver's position in the track, no seek bar is drawn
for them.

The Wii source browser lists a single "start" entry per receiver. Choosing it
starts the receiver and shows "Waiting for Spotify" (or AirPlay) until a phone
connects. Spotify with an account connected lists that entry beside its library.

### Two ways to use Spotify

Both need Spotify Premium, and the phone or computer on the same network as WiiJukebox.

**The easy way: a speaker, with nothing to set up.**

1. On the Wii (or the web page), open **Spotify Connect** and choose **WiiJukebox**.
   This starts the receiver.
2. In the Spotify app on your phone or computer, tap the devices icon and pick
   **WiiJukebox**.
3. Music plays on the Wii, which shows the song and its cover art. You choose
   songs, pause and skip in the Spotify app.

**With browsing on the Wii: a one-time setup of about ten minutes.**

Spotify only lets a program browse your library through a developer app of your
own (free, but its owner needs Premium; Spotify allows five people per app and
offers no shared app for projects like this one). The steps are under
[Spotify library and remote control](#spotify-library-and-remote-control-spotify-web-api)
below, and Settings, Spotify Connect walks through them. Afterwards the Wii's
Spotify channel shows **Liked Songs**, **Playlists** and **Albums**, and you can
pick a song and play, pause or skip from the Wii; the phone stays in step.

**Forgetting an account.** The receiver remembers whoever first chose it in the
Spotify app and signs in as them on every start. **Forget this Spotify account**
on the Spotify Connect page stops the receiver, deletes that sign-in and
disconnects browsing, so a visitor's account doesn't stay behind. Your Client ID
stays in Settings.

### Spotify Connect (librespot)

Requires Spotify Premium and [librespot](https://github.com/librespot-org/librespot).
The desktop app includes it. Running the server on its own, build it with cargo:

```bash
cargo install librespot --locked --no-default-features --features rustls-tls-native-roots,with-libmdns
```

That takes a few minutes and needs no OpenSSL. Put the binary on `PATH` or set
its full path under Spotify settings (`binary`).

- Device name, bitrate (96, 160 or 320) and volume normalization are settings.
- The Spotify app's own volume slider is ignored (`--volume-ctrl fixed`); the Wii
  has the volume control.
- The first connection from the Spotify app signs librespot in with that
  account. Credentials are cached under `<config dir>/spotify/` (mode 0700);
  **Forget this Spotify account** deletes them.
- Zeroconf needs multicast DNS on the LAN. It works alongside Avahi.

### Spotify library and remote control (Spotify Web API)

Connect your own Spotify developer app and WiiJukebox can show your library on
the Wii and the web page, start what you pick on the receiver, and send play,
pause, next and previous to Spotify. Audio still comes from librespot, so the
receiver above is required. Spotify's own player owns the queue: WiiJukebox
sends the selection and mirrors what Spotify reports, and never advances a
second queue of its own.

**Set up (once):**

1. At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   create a free app. The app owner needs Spotify Premium. Any name and
   description will do; tick Web API.
2. Under the app's **Redirect URIs** add the address WiiJukebox shows in
   Settings, Spotify Connect, exactly as shown (use its Copy button). It has the
   form `http://127.0.0.1:<server port>/api/spotify/callback`, where the port is
   the one WiiJukebox runs on (4005 by default). Spotify accepts only the literal
   `127.0.0.1`, not `localhost`. If you change the server's port, add the new
   address too.
3. Under **User Management** add the Spotify account you will sign in with (a
   development-mode app allows up to five people).
4. Copy the app's **Client ID** into Settings, Spotify Connect, and press
   **Connect Spotify account**. Your browser on the computer that runs WiiJukebox
   opens Spotify's sign-in; approve it and the page says Spotify is connected.
   The desktop app hands the link to your system browser. Sign in from the
   computer that runs the server, since Spotify only returns to 127.0.0.1.
5. Start the receiver once (the WiiJukebox entry in the Spotify channel) and, the
   first time only, open Spotify and pick it in the device list. librespot signs
   in to Spotify's servers after a Spotify app has selected it once, keeps the
   credentials under `<config dir>/spotify/` and signs in by itself on later
   starts. The Web API can only control a receiver that has signed in this way.
6. Press **Test connection** in Settings, or run the proof tool below.

**What you get:**

- Roots: **Liked Songs**, **Playlists** (yours, collaborative and followed) and
  **Albums** (saved), plus the receiver entry. The web page also searches Spotify
  (ten results per kind, Spotify's limit). The Wii browses the same lists in
  12-item pages; a track keeps its absolute position in the playlist or album.
- Choosing a song starts the playlist or album at that song. Liked Songs, which
  Spotify has no playlist address for, queue the song and the next 99. Choosing
  a playlist or album itself starts it from the beginning.
- Selecting something while the receiver is running re-aims it; the receiver is
  not restarted and the Spotify app's own connection to it is left alone.
- Play, pause, next, previous, shuffle and repeat go to Spotify. A command
  finishes (the Wii's "Audio ready", "Paused") only when Spotify reports the
  change and audio is flowing, not when Spotify accepts the request. Pausing or
  skipping in the Spotify app on your phone shows up here within a few seconds.
- Stop still ends the receiver. After a server restart the receiver comes back,
  but no music starts by itself; pick something again.
- There is no seek bar or song length for Spotify, as before.

**Development-mode limits.** Spotify only returns the tracks of playlists you
own or collaborate on to a development-mode app. A followed playlist (Spotify's
own, or someone else's) still lists, and **Play** starts it whole, but opening
it says its tracks are not shared with the app, which is not the same as empty.
Liked Songs, saved albums and your own playlists are unaffected.

**Messages and what they mean:**

| Message | Meaning |
|---|---|
| Add your Spotify Client ID | No Client ID is saved yet |
| Spotify is not connected | A Client ID is saved but nobody signed in |
| Reconnect Spotify | Spotify revoked or no longer accepts the saved sign-in; press Reconnect Spotify |
| Spotify cannot see "WiiJukebox" on this account | The receiver is not signed in to the account you connected: pick it once in the Spotify app (step 5), and check both use the same account |
| Spotify Premium is required | Spotify only lets Premium accounts be controlled through the API |
| ...User Management... | Development mode refused the account; add it in the dashboard |
| Spotify is rate limiting this app; try again in N s | Spotify answered 429; nothing is sent until the wait is over |
| Tracks are not shared with this app | A followed playlist in development mode |

The Client ID is not secret. The sign-in (a refresh token) is kept in
`config.json` (mode 0600) like other service secrets and never reaches the web
page, the Wii, the log or the SD card. Scopes requested: `user-library-read`,
`playlist-read-private`, `playlist-read-collaborative`,
`user-read-playback-state`, `user-modify-playback-state`. Sign-in uses
Authorization Code with PKCE; no client secret is involved.

**Checking it against your account.** With WiiJukebox running (new build) and
signed in, run the same steps the first real test needs:

```bash
node tools/spotify-proof.js                    # server on http://127.0.0.1:4005
node tools/spotify-proof.js --url http://127.0.0.1:4005 --track spotify:track:ID --wait 90
node tools/spotify-proof.js --no-play          # read-only: no sound
```

It prints PASS, FAIL or SKIP for authenticating, reading Liked Songs, reading
one playlist you own, finding the receiver, playing a song (into the stream, so
the Wii hears it) and pausing and resuming it. Messages contain no tokens.
Settings has the same check as **Test connection** (read-only) and **Play a test
song**.

Spotify's [Developer Policy](https://developer.spotify.com/policy) applies to
the app you create; a five-person development app is for personal use. Whether
relaying a stream to a Wii, converting it to MP3 or the visualizer fit its
terms has not been reviewed here, and librespot's maintainers warn that Spotify
may forbid it.

### AirPlay (shairport-sync)

Requires [shairport-sync](https://github.com/mikebrady/shairport-sync) built with
the `stdout` audio backend and metadata support. Classic AirPlay (AirPlay 1) is
lossless 44.1 kHz and is what the stdout backend is tested against here.
Apple Music, Podcasts, any app's audio and macOS system audio can use it.
The desktop app includes a build of it on Linux and macOS
(`packaging/desktop/scripts/build-shairport.sh`); shairport-sync has no Windows
version. Running the server on its own, build it as below.

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
yt-dlp, so everything the Web links channel supports applies.

- Search returns songs, albums, playlists and artists. An artist result opens
  that artist's albums.
- Albums and playlists queue completely. Picking a track inside one starts there.
- For Premium audio quality and "Liked Music", add your browser cookies under
  Settings, Advanced, extra yt-dlp options:
  `--cookies-from-browser firefox`.
- If the search endpoint changes, the source falls back to titles from yt-dlp's
  own search.

## Podcasts

Show search and the "Top shows" chart use Apple's keyless iTunes Search API and
top-podcasts chart (the lookup API turns the chart's ids into feed addresses),
so no account or key is needed. Episodes come straight from each show's RSS feed.

- Subscribe and unsubscribe in the web UI. Subscriptions are saved in
  `sources.podcasts.subscriptions` and shared with the Wii, which browses
  Subscriptions, then a show, then its episodes (newest first, 12 per page).
  Top shows is browsable on both.
- Pasting a feed address into the search box finds that one show, for feeds Apple
  does not list. `sources.podcasts.country` (default `us`) picks Apple's store
  for search and the chart.
- Feeds are fetched with a 15 second timeout and an 8 MiB cap (episodes read
  before the cap are kept), follow redirects, identify as `WiiJukebox/0.1` and
  are cached for ten minutes. An unreachable host falls back to the cached copy.
- Only audio enclosures are used: `audio/*` types, or untyped links ending in
  `.mp3`, `.m4a` and similar. Video-only items are skipped. Addresses with a
  user name or password are refused; tokens in the query string work.
- An episode plays on its own and the stream stops when it ends. Neighbors in a
  newest-first list are the wrong "next" for serials and for news shows alike,
  so there is no queue, no skip, and no shuffle or repeat.
- Seeking needs `itunes:duration` in the feed and a host that honors byte
  ranges (most do). Episode artwork is used when the feed has it, else the
  show's.
- After a server restart the last episode starts again from the beginning, as
  every source does.
- The Wii shows the Podcasts channel with its generic note icon.

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

## Play history and scrobbling

WiiJukebox reports listening to the service it plays from, the way that service's
own apps do. Last.fm, ListenBrainz and similar links stay set up in the service;
WiiJukebox has no scrobbling settings of its own.

A track starts counting when its audio reaches the stream. It counts as played
after half its length or 4 minutes of listening, whichever comes first, and tracks
under 30 seconds never count (Last.fm's rules). Paused time does not count, and
seeking does not restart the count. Each replay under repeat-one is a new listen
and counts on its own.

| Service | What WiiJukebox reports | Where plays go next |
|---|---|---|
| Navidrome (and other Subsonic servers) | `scrobble.view`: now playing, then the play with its start time | Navidrome's play counts, and Last.fm or ListenBrainz when linked in Navidrome |
| Jellyfin | Playback start and stop, with the position | Jellyfin's play state and plugins such as its Last.fm scrobbler, which decide what counts |
| Plex | Timeline (playing, stopped) and a scrobble once played | Plex's play history and its Last.fm link |
| YouTube and YouTube Music | Marks a played video watched, with yt-dlp `--mark-watched` | YouTube history, which YouTube Music scrobblers read. Needs your cookies in Advanced, extra options |
| Spotify Connect | Nothing; librespot sends Spotify no listening reports | Plays through the receiver likely do not reach Spotify history or its Last.fm link |
| AirPlay | Nothing needed | The sending app (Apple Music on the iPhone or Mac) keeps its own history |
| Radio, podcasts, desktop audio | Nothing | |

Reports never block playback; a failure appears only as a warning in the log.

## Third-party code and assets

| Item | Use | License |
|---|---|---|
| [librespot](https://github.com/librespot-org/librespot) | Spawned as a separate program; the desktop app bundles a build of it (`packaging/desktop/scripts/build-librespot.sh`) | MIT; the licenses of the crates built into it ship in `librespot-LICENSE.txt` |
| [Spotify Web API](https://developer.spotify.com/documentation/web-api) | Library, search and playback commands with your own developer app; no Spotify code or artwork bundled | Spotify's Developer Terms and Policy |
| [shairport-sync](https://github.com/mikebrady/shairport-sync) | Spawned as a separate program; the desktop app bundles a build of it on Linux and macOS (`packaging/desktop/scripts/build-shairport.sh`) | MIT and BSD-style (see its LICENSES file); the build links in popt, libconfig (LGPL 2.1), OpenSSL and FFmpeg's ALAC and AAC decoders (LGPL v3) |
| [iTunes Search API](https://performance-partners.apple.com/search-api) and Apple's top-podcasts chart | Show search, feed lookup and the chart; keyless web requests, no Apple code or artwork bundled | Apple's API terms |
| [ytmusicapi](https://github.com/sigma67/ytmusicapi) | Search request format followed; no code copied | MIT |
| [Nunito](https://github.com/googlefonts/nunito) (`public/fonts/`) | Web UI typeface, latin subset | SIL OFL 1.1 (`public/fonts/OFL.txt`) |
| `public/images/*` | WiiRadio logo and tile, kept from the original project | See `client/vendor/README.md` |
| `public/images/jukebox.svg`, `favicon.*`, `apple-touch-icon.png` | Jukebox mark and favicons | Licensed separately; **not** covered by the GPL |

## Testing without the real programs

`test/spotify.test.js`, `test/airplay.test.js`, `test/ytmusic.test.js` and `test/podcasts.test.js` use small fake programs and fixture HTTP servers, so
`npm test` never contacts a streaming service. `test/helpers/fake-binary.js`
writes the fakes. `test/spotify-web.test.js` and `test/spotify-proof.test.js` run
the Spotify sign-in, library and remote control against `test/helpers/fake-spotify.js`,
a fake accounts service and Web API with a player behind it, and a fake librespot
that follows that player. `node test/spotify-ui-check.js` (Chromium and
playwright-core) drives the web screens over the same fake and takes screenshots.
