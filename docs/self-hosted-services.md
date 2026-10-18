# Self-hosted music

WiiJukebox plays your own library, either straight from the folders on your
computer or from the music server you already run. With a server it signs in the
way that server's own apps do, asks for the original files, and does all the
decoding itself, so your server never has to transcode anything.

| Service | How WiiJukebox talks to it | You need | Browse on the Wii | Status |
|---|---|---|---|---|
| Local files | It reads the files itself | One or more folders on the computer running WiiJukebox | Artists, Albums, Songs, Folders, Playlists | Built and tested with generated files; not yet run against a large real library |
| Navidrome (and other Subsonic servers) | The Subsonic API (1.16.1) | The server address, a username and password | Artists, Albums, Playlists, Starred | Built. Run against a real Navidrome 0.64.2, including behind a reverse proxy with a path prefix. Other Subsonic servers were not tested |
| Jellyfin | Jellyfin's API, signed in as a device named WiiJukebox | The server address, a username and password | Artists, Albums, Playlists | Built and tested against a stand-in Jellyfin only; no real Jellyfin server was tested |
| Plex | The Plex Media Server API with your Plex token | The server address and a Plex token | Your music libraries, Playlists | Built and tested against a stand-in Plex only; no real Plex server was tested |

Each service is set up once in the web page (the WiiJukebox app's window, or
`http://<computer>:4005` in a browser): open the service's channel, press its
settings button, fill in the fields and press **Connect**. The Wii never sees an
address, a password or a token; it browses through WiiJukebox.

## What every self-hosted service gets

- **The original file.** Local files opens the file itself; WiiJukebox asks
  Navidrome for `format=raw`, Jellyfin for `static=true` and Plex for the file
  itself. It then decodes it with its own FFmpeg
  and sends the Wii one steady MP3 stream. Anything FFmpeg reads plays: FLAC,
  ALAC, Opus, Vorbis, AAC, MP3, WAV, WavPack, AIFF and more.
- **Seeking** within a track, from the Wii or the web page.
- **Whole albums and playlists.** Playing an album or playlist queues every
  track in it, not just the page you can see, so next, previous, shuffle and
  repeat work across all of it. On the Wii, A opens an album or playlist, B + A
  queues all of it, and A on a track queues the album or playlist and starts at
  that track. The Wii shows 12 entries per page.
- **Search** on the web page (the Wii has no text search yet).
- **Cover art** on the web page and the Wii. Art links are rewritten by the
  server's art proxy, so tokens and passwords inside them never reach a
  browser or the Wii.
- **Play history** reported back to your server like its own apps do, so play
  counts and Last.fm or ListenBrainz links set up there keep working. See
  [Play history and scrobbling](streaming-services.md#play-history-and-scrobbling).
- **Home screen suggestions.** One library service is the **primary**: its
  rows (below) fill the home screen. Until you choose, it is the first one set
  up, in the sidebar's order, except that a media server comes before Local
  files; **Set as primary** in a service's channel chooses it, and your choice
  stays until that service is no longer set up.

## Local files

No server needed: Local files plays the music files on the computer WiiJukebox
runs on.

**Set up:**

1. Open **Local files**. Its settings start with your Music folder, when you
   have one.
2. To add another folder, press **Add a folder…**, open folders until you're in
   the right one, and press **Use this folder**. The folders listed are the
   computer's, so this works from a phone too.
3. Press **Save**. WiiJukebox looks through the folders. A big library fills in
   as it is read, and the settings page counts the songs as they come in.

**What you get:**

- Roots: **Artists**, **Albums**, **Songs** (everything; B + A on the Wii plays
  all of it, with shuffle if it's on), **Folders** (exactly as they are on disk;
  a folder that holds songs plays like an album) and, when the folders hold
  `.m3u` or `.m3u8` files, **Playlists**.
- Tags from MP3 (ID3), FLAC, Ogg Vorbis, Opus, M4A (AAC and ALAC) and WAV, and
  through FFmpeg for anything else it plays (AIFF, WMA, WavPack, APE and more).
  A song without tags is named after its file, and its folder is its album.
- An album is the songs with the same album title in one folder (or in its
  `CD1`, `CD2` or `Disc 2` folders), or anywhere when they share an album artist.
- Covers: the picture inside the files, or else `cover.jpg`, `folder.jpg` or
  `front.jpg` (or any other picture) in the album's folder, shrunk to 300 pixels
  and kept in the settings folder's `local-art`.
- Home rows: **Recently added** and **Random albums**.

**Good to know:**

- The index is kept in `local-files.json` in the settings folder, so a restart
  is quick and only new or changed files are read again. WiiJukebox looks for
  changes the first time Local files is used after it starts, while you browse
  (at most every 10 minutes) and when you press **Scan again**.
- Folders whose names start with a dot are skipped. Folders that are symbolic
  links are followed.
- A folder that goes away, such as an unplugged drive, keeps its songs in the
  index, out of sight, until it is back.
- Nothing is reported anywhere, since there's no server to count plays.
- The web page has no sign-in, so anyone who can open it on your network can
  choose the folders and see what's in them. Keep WiiJukebox on a network you
  trust.

## Navidrome (and other Subsonic servers)

[Navidrome](https://www.navidrome.org/) is the one this project uses and tests
with the most. Gonic, Airsonic-Advanced, Ampache and other servers that speak
the Subsonic API should work the same way, but only Navidrome was tried.

**Set up:**

1. In WiiJukebox, open **Navidrome** and its settings. The same channel works with any Subsonic-compatible server.
2. **Server URL:** the address you open Navidrome at, such as
   `http://192.168.1.10:4533` (Navidrome's default port is 4533) or
   `https://music.example.com`. An address with a path, such as
   `https://example.com/navidrome`, works too.
3. **Username** and **Password:** your Navidrome login. A separate Navidrome
   user just for WiiJukebox is fine, and keeps its plays apart from yours.
4. Press **Connect**.

**What you get:**

- Roots: **Artists**, **Albums** (newest first), **Playlists** and **Starred**
  (the songs you've hearted in Navidrome).
- Home rows: **Recently added**, **Most played** and **Recently played**.
- Plays count in Navidrome (with `scrobble.view`, "now playing" first and the
  play once it counts) and go on to Last.fm or ListenBrainz if you've linked them
  in Navidrome's personal settings.

**Good to know:**

- Subsonic sign-in sends a salted MD5 of the password, not the password itself,
  but that is only as private as the connection. On your home network plain
  `http://` is fine; for a server reached over the internet, use `https://`.
  WiiJukebox warns when it connects over plain HTTP to an address that isn't
  local.
- "wrong username or password" means Navidrome refused the login (Subsonic
  error 40).

## Jellyfin

**Set up:**

1. In WiiJukebox, open **Jellyfin** and its settings.
2. **Server URL:** the address you open Jellyfin at, such as
   `http://192.168.1.10:8096` (Jellyfin's default port is 8096).
3. **Username** and **Password:** your Jellyfin login, or a separate user for
   WiiJukebox.
4. Press **Connect**. WiiJukebox signs in once and keeps the access token
   Jellyfin gives it, so it doesn't sign in again on every start.

**What you get:**

- Roots: **Artists**, **Albums** (newest first) and **Playlists**. Playlists
  that hold video are left out.
- Home row: **Latest** albums.
- WiiJukebox appears in Jellyfin's dashboard as a device called WiiJukebox, and
  its plays show up as that session: playback start, then stop with the position.
  Jellyfin decides what counts as played, and plugins such as its Last.fm
  scrobbler take it from there.

**Good to know:**

- "login rejected; check username and password" is Jellyfin answering 401.
- Choosing WiiJukebox from Jellyfin's own apps ("Play On") is not built yet;
  pick music from WiiJukebox or the Wii instead.

## Plex

**Set up:**

1. Find your Plex token: Plex's own guide,
   [Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/),
   shows how. In short: in Plex Web, open any song or album, choose **Get Info**,
   then **View XML**; the address that opens ends in `X-Plex-Token=` followed by
   the token.
2. In WiiJukebox, open **Plex** and its settings.
3. **Server URL:** your Plex Media Server's address, such as
   `http://192.168.1.10:32400` (Plex's default port is 32400).
4. **Plex token:** paste the token, then press **Connect**.

**What you get:**

- Roots: each of your **music libraries** by name, then **Playlists** (audio
  playlists only).
- Home rows: **Recently added** (across up to four music libraries) and
  **On Deck**.
- Plays show in Plex like its own players' (a timeline while playing, then the
  play once it counts), so Plex's history and its Last.fm link see them.

**Good to know:**

- The token is the key to your whole Plex account, so treat it like a
  password. WiiJukebox only ever sends it to the server address you entered,
  and refuses media links Plex returns for any other address.
- "Plex rejected the token" is Plex answering 401; the token may have been
  revoked when you signed out of devices in Plex. Find it again and paste the new one.
- Casting to WiiJukebox from Plex's own apps (Plex Companion) is not built yet.

## Where the settings live

Addresses, usernames, passwords and tokens are kept in WiiJukebox's
`config.json` (mode 0600, readable only by your user) in its settings folder
(`~/.config/wiijukebox` on Linux, `~/Library/Application Support/wiijukebox` on
macOS, `%APPDATA%\wiijukebox` on Windows). They are never sent to the web page,
the Wii, the log or the SD card; the settings form only shows that one is saved.
Leaving a password or token field empty keeps the saved one. Hiding a service in
Sidebar settings takes it off the sidebar and the Wii, but there is no button yet
that deletes its saved login: for now, quit WiiJukebox and remove the service's
entry under `sources` in `config.json`.

## Testing without a real server

`test/local-library.test.js`, `test/local.test.js` and `test/local-tags.test.js`
build small folders of generated audio files (with FFmpeg) and never read your
own music. `test/subsonic.test.js`, `test/plex.test.js` and the home, history and
listening tests use small stand-in servers (`test/helpers/fake-services.js` has Navidrome,
Jellyfin and Plex), so `npm test` never contacts a music server.
`test/navidrome-fixture.py` starts a real Navidrome (0.64.2, from
`NAVIDROME_BINARY` or `PATH`) on a generated library, and `test/navidrome-live.js`
runs against it, including a reverse-proxy path prefix. It writes a playlist and
a star, so it must never be pointed at a personal server.
