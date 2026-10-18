# Packaging

Everything here builds from source with scripts. Outputs go to `packaging/dist/`
(ignored by git). Only the Android release build is signed.

| Target | Source | Command | Output |
|---|---|---|---|
| Android controller | `android/` | `packaging/android/build.sh` (or `build.sh release`) | `dist/WiiJukebox-android-debug.apk` (or `dist/WiiJukebox-android.apk`) |
| Linux desktop | `desktop/` | `npm run dist:linux` in `packaging/desktop` | `dist/desktop/WiiJukebox-<version>-linux-x64.AppImage` |
| Linux desktop (Debian, Ubuntu) | `desktop/` | `npm run dist:linux-deb` (needs a system with `libcrypt.so.1`, such as Ubuntu) | `dist/desktop/wiijukebox_<version>_amd64.deb` |
| Linux desktop (Fedora, RHEL, openSUSE) | `desktop/` | `npm run dist:linux-rpm` (needs `rpmbuild` and `libcrypt.so.1`: build it on Ubuntu with the `rpm` package, or in CI) | `dist/desktop/wiijukebox-<version>-1.x86_64.rpm` |
| Windows desktop | `desktop/` | `npm run dist:win` | `dist/desktop/WiiJukebox-<version>-win-x64-setup.exe` and `-win-x64-portable.zip` |
| macOS desktop | `desktop/` | `npm run dist:mac` (on a Mac) | `dist/desktop/WiiJukebox-<version>-mac-arm64.dmg` and `-mac-x64.dmg`, each with a matching `.zip` |

Run `npm ci` in the repository root first: the desktop builds copy `public/vendor`,
which `npm ci` creates. The desktop builds also need `npm ci` inside
`packaging/desktop` (Electron and electron-builder). Pushes to GitHub build all of
these in Actions; see [Continuous integration](#continuous-integration).

## Android controller

A native shell around the controller web page. It:

- finds servers on the Wi-Fi network with the same UDP discovery the Wii client
  uses (`src/client/discovery.js`), on port 4005 plus any extra ports you enter;
- remembers the chosen server by its ID, so a changed IP address is found again;
- lets you type an address (`192.168.0.3:4005`) when discovery is blocked;
- shows the controller page in a WebView that follows the system light/dark
  setting unless the page's own Theme control (System, Light, Dark, in the menu button at
  the right of its toolbar) says otherwise, and sends its Back button to the page first (close a sheet, go up a
  folder) before leaving the app.

Requirements: JDK 17 or newer, the Android SDK with platform 37 and build-tools
36 (`ANDROID_HOME`, default `~/Android/Sdk`). Gradle 9.6.1 and Android Gradle
Plugin 9.3.1 are downloaded on first use. The app has no AndroidX dependencies.

Why the server does not run on the phone: it needs Node, FFmpeg, yt-dlp and the
receiver programs, and Android would stop a background process playing to the
Wii whenever the screen is off. A phone is the controller; the server stays on
a computer or NAS.

`build.sh release` signs with the key named in
`~/.local/share/wiijukebox-signing/keystore.properties` (or the file in
`WIIJUKEBOX_SIGNING`). The key never enters the repository. Android only installs
an update signed with the same key, so back up both files in that folder; without
the file, Gradle still makes debug builds.

The launcher icon is the jukebox mark in blue on white, with the cabinet centered
and the same drawing as the monochrome layer for themed icons.
`python3 -I android/make-icon.py` redraws it from `public/images/jukebox.svg`
after the mark changes.

Not done: a lock-screen media notification and a Play Store listing.

## Desktop app (Linux, Windows, macOS)

For people who should never need a terminal or a browser address: download, open,
and the music server runs. Electron runs the same server code as `npm start` in a
child process and shows its web page in a native window, so the web UI is the app's
interface. Electron carries its own Node runtime and each build carries FFmpeg, so
nothing is installed first. Tauri would need a separate Node sidecar and system
WebKit packages.

### What a person sees

- **First run.** A welcome page offers four choices, in this order: the included audio
  engine, the default server settings (both ticked and marked "(recommended)"), YouTube,
  SoundCloud and Bandcamp support by downloading yt-dlp (ticked), and start at login
  (unticked). It then starts the server and shows **Connect your Wii**: put the Wii on
  the same network, open WiiJukebox on it (it finds the computer by UDP discovery), or
  type the address shown (for example `192.168.0.3:4005`). The page also reports whether
  the server and discovery are working. After that the window shows the web UI.
- **Background.** A tray icon (menu bar icon on a Mac) keeps the server and the music
  going. The first time the window is closed (the bar's ×, Alt+F4, the taskbar)
  the app asks in a small card of its own: a bold title, one sentence, a "Remember my choice"
  line (ticked; unticked, the choice applies once and the card comes back next time) and three
  equal buttons, Cancel, Quit and Keep playing. Escape cancels, Enter keeps playing, and the
  answer is remembered ("Keep playing when the window is closed" in the menu changes it). Quit
  from the tray or application menu stops the server and its FFmpeg. If the app is killed
  without quitting, the server notices and stops by itself.
- **Audio engine and server settings.** Unticking "Use the included audio engine" makes
  the server use the FFmpeg already on the computer (see [FFmpeg and
  yt-dlp](#ffmpeg-and-yt-dlp)). Unticking "Use default server settings" shows two
  fields, prefilled with the current values:
  - *Server name*, the name the Wii lists. It is trimmed, cannot be empty or contain line
    breaks, and is at most 80 characters (what discovery sends).
  - *Port*, the web port: a whole number from 1024 to 65535 that is free right now.
  Both go into the server's `config.json` (`station.name` and `port`) before the server
  starts, and nothing else in that file changes. The discovery port is never touched:
  the Wii looks for servers on UDP 4005 and is told the web port in the answer, so
  it still finds the server by itself whatever the name and port. Left ticked, the page
  writes nothing, and its text ("Named WiiJukebox, on port 4005") shows what `config.json`
  and the server's defaults say, so a hand-edited file is kept.
- **Start at login** (menu item, offered unticked on first run). The app then opens quietly in
  the tray, so the Wii can connect after a restart. Windows and macOS use their login
  items; Linux writes `~/.config/autostart/wiijukebox.desktop`.
- **One copy.** Starting the app again brings the window forward. Starting it with
  `--quit` makes the running copy quit (scripts, installers).
- **Window bar.** The main window draws its own title bar in the web UI's colors, light or dark
  with the system: the jukebox mark and the title on the left, a menu button and minimize,
  maximize or restore, and close on the right. A Mac keeps its own traffic lights, inset into
  the bar, and its menu bar. The bar moves the window, and a double click maximizes it where the
  system does that. The bar covers the setup and error pages as well as the web UI.
  - **The title follows playback**, shaped like Feishin's: `(Paused) (2 / 34) Song — Artist —
    WiiJukebox`, or just `WiiJukebox` when nothing plays. It comes from the server's
    `/api/status` once a second while the player is showing (the `queue` field holds the place
    in the album or playlist; a station has none, so no count is shown), and it is also the title
    in the taskbar and the window switcher, with the system title bar too.
  - **Use system title bar** (menu and tray) turns the custom bar off. The window is rebuilt around
    the same page at once, so there is no restart, but the web UI reloads and the browser
    "Monitor" playback stops. It is grayed out until the first-run setup is done.
  - **The menu button** opens the menu entries below as a compact list the bar draws itself (28 px
    rows of 13 px text in the web UI's colors, light or dark), since a window without a system frame
    has no menu bar to show with Alt and a native popup cannot be made smaller. It takes the arrow
    keys, Enter and Escape, and a click anywhere else closes it. The light follows the pointer and goes
    when it leaves (the parent of an open submenu and an entry the keys chose stay lit), and an open
    submenu closes about 200 ms after the pointer rests on another entry, but not while it crosses the
    list on its way to the submenu. The Alt menu and the tray menu stay native, drawn by the system,
    with the same entries.
  - **Theme** (in the menu, the Alt menu and the tray menu) is System, Light or Dark for the web UI.
    The web UI keeps the choice itself, in its own storage, and the app only presses its System, Light
    or Dark buttons and reads the result back. The page keeps one `theme-color` tag at its effective
    background (set before first paint, and again when the choice or the system's scheme changes), and
    the app switches the bar the moment Chromium reports the tag changing, so the bar and the page change
    together. A slow poll of the page's choice only settles the menu's tick marks. The setup pages follow
    the system, so Theme is grayed out until the player shows.
  - **Sidebar settings…** (same three menus) presses the web UI's own control for its Sidebar settings
    sheet, where channels are shown or hidden. In a plain browser that sheet is behind the menu button
    at the right of the toolbar, which the desktop app hides, since the app has this entry.
  - **Fullscreen.** When a page goes fullscreen (F11 in the web UI, or the visualizer's own
    button) the bar steps aside and the page fills the whole display, on whichever monitor the
    window is on.
- **Menu and tray entries.** Connect your Wii, Copy Wii address, Copy stream address,
  Open in browser, Restart server, Server name and port, Install or update yt-dlp, Use
  included FFmpeg, Start at login, Keep playing when the window is closed, Use system title
  bar, Theme, Sidebar settings, Show settings folder, Show server log (`logs/server.log` in the app's data folder).
  - **Server name and port…** opens a small window with the same two fields as the
    welcome page. Saving stops the server, writes `config.json` and starts it again (a
    change of nothing does not restart it). Keeping the port the server already holds is
    allowed; a different one must be free. It is grayed out until the first-run setup is done.
  - **Use included FFmpeg** is a checkbox; changing it restarts the server. It is not
    shown when the app has no included FFmpeg (a development run).
- **Errors are pages, not console text.** A busy port shows "Port 4005 is in use" with
  a free port suggested; one click saves it in the server's `config.json` and
  restarts (the Wii finds the new port by discovery). A server crash shows its last
  lines and a Restart button. An FFmpeg problem shows a page that says which it is
  (none found, or one found that cannot make MP3), with install commands, a Check again
  button, "Start without it" and, if the included FFmpeg is unticked, a button that
  switches back to it. A failed yt-dlp download shows a note on the Connect page and can
  be retried from the menu.

### Ports and firewalls

The Wii needs the web port (default TCP 4005) and the discovery port (default UDP 4005:
the same number, a different protocol; the two can also be set apart in `config.json`).
Nothing in the app opens them to the internet; they are for the local network.

| System | What happens | What the app does |
|---|---|---|
| Windows | Windows Defender Firewall asks the first time the server listens. Allow, with Private networks ticked. A dismissed question leaves the Wii unable to connect, and a Wi-Fi network marked Public stays blocked. | The Connect page explains this and has **Allow WiiJukebox in Windows Firewall**, which asks for administrator permission once and adds an inbound rule for the program (any TCP or UDP port it uses) on Private and Domain networks. |
| macOS | If the system firewall is on, macOS asks whether WiiJukebox may accept incoming connections. macOS 15 and later can also ask about local network access. | The first-run page and Connect page name both prompts and where to change them. The app declares `NSLocalNetworkUsageDescription`. |
| Linux | Most systems allow it. With ufw or firewalld, TCP 4005 and UDP 4005 need to be opened. | The Connect page shows the exact `ufw` and `firewalld` commands for the current ports. |

The Connect page also asks the discovery port the way a Wii does, so a port that is
taken or blocked on this computer is reported with "press HOME on the Wii, choose Server address, and type the address".

### FFmpeg and yt-dlp

FFmpeg is bundled and used before anything on `PATH` by default, since some system builds
leave out the MP3 encoder the stream needs. The setting
`useBundledFfmpeg` in the app's `settings.json` (ticked by default; the welcome page and
the menu change it) turns that around: the included folder is skipped and the server gets
the first FFmpeg found among the overrides, `PATH` and the common install folders.
Whichever FFmpeg is chosen must list `libmp3lame` in `ffmpeg -encoders`. If none is
found, or the one found cannot encode MP3, the FFmpeg page says which of the two it is and
offers the included FFmpeg again. A development run has no included FFmpeg, so the option
is hidden and the computer's own is used. An override (`WIIJUKEBOX_FFMPEG`) wins over the
setting.

Every bundled FFmpeg is our own build, made by `scripts/build-ffmpeg.sh` from pinned, checksummed
sources: FFmpeg 8.1.3 under the LGPL v3, with LAME for MP3, zlib and a TLS library. Nothing GPL-only
or nonfree is enabled (`scripts/check-ffmpeg.sh` checks a build), so it can ship with the app, and
each release carries its exact sources in `WiiJukebox-<version>-sources.tar`. Its licenses and
a README with its configuration ship next to it in `resources/bin` (`ffmpeg-LICENSE.txt`,
`ffmpeg-README.txt`).

| System | TLS | Built in | Runs on |
|---|---|---|---|
| Linux x64 | OpenSSL 3.5 (Apache 2.0), linked in | an AlmaLinux 8 container | glibc 2.28 or newer |
| Windows x64 | Windows' own SChannel | a Debian 12 container, with mingw-w64 | Windows 10 or newer |
| macOS arm64 and x64 | Apple's Secure Transport | the Mac itself (in CI, macos-latest) | macOS 11 or newer, not yet tried |

`scripts/build.js ffmpeg <target>` builds a target the first time `stage.js` needs it and keeps it
in `~/.cache/wiijukebox-desktop/ffmpeg-build` (changing the build script starts a new folder); the
Linux and Windows builds need podman or docker. Only what the server writes is encoded: MP3, raw
PCM, and JPEG, PNG and raw pixels for cover art. Every decoder, demuxer, protocol and filter of
FFmpeg's own stays in. Desktop audio is recorded with `parec`, so no FFmpeg needs PulseAudio.

Before this, Linux used eugeneware's build (johnvansickle's FFmpeg 7.0.2) until it turned out to
crash on any URL that names a host. That build is linked fully statically, glibc included, and a
static glibc resolves names by loading the computer's NSS modules (`libnss_files.so.2` and the like)
with `dlopen`; another glibc's modules cannot be loaded into a static program, so the program dies
with SIGSEGV inside `getaddrinfo` (the server logged `decode failed: code null signal SIGSEGV`). It
failed the same way on glibc 2.35, 2.41 and 2.43, for radio stations, podcasts, yt-dlp links and a
library server reached by name; a literal address such as `http://127.0.0.1:4533` resolves nothing,
which is why a local Navidrome and the smoke test never showed it. Our Linux build links glibc
dynamically and everything else statically, so the computer's own libc does the lookup.
`test/decoder-hostname.test.js` decodes a stream from `http://localhost:<port>`; it runs in `npm
test`, and against our FFmpeg on every system in CI. Jellyfin's portable GPL build filled in for a
while on Linux and macOS, and gyan.dev's 6.1.1 on Windows, but Jellyfin's Linux build includes
libfdk-aac, whose license does not allow it to be shipped with GPL code.

yt-dlp is optional and not bundled. The first-run page (or Install or update yt-dlp
in the menu) downloads the standalone release into the app's own `bin` folder, and
that copy is used before one on `PATH` so updating it takes effect. The Spotify Connect
receiver (librespot) is bundled, see [librespot](#librespot-spotify-connect), and so is the
AirPlay receiver (shairport-sync) on Linux and macOS, see
[shairport-sync](#shairport-sync-airplay).

### Install notes (the builds are unsigned)

- **Windows.** Run `win-x64-setup.exe`, the normal choice (per user, shortcuts on the
  desktop and in the Start menu). `win-x64-portable.zip` is the no-install portable
  copy: unzip it anywhere and run `WiiJukebox.exe`. SmartScreen warns about
  an unsigned download: More info, then Run anyway.
- **macOS.** Open the `.dmg` and drag WiiJukebox to Applications (the `.zip` holds the
  same app). The app is ad-hoc signed, not notarized, so Gatekeeper refuses the first
  launch of a downloaded copy. Try to open it, then System Settings, Privacy &
  Security, scroll to the message about WiiJukebox, Open Anyway. On macOS 14 and
  earlier, right-click the app and choose Open works as well. `arm64` is for Apple
  silicon, `x64` for Intel Macs.
- **Linux.** On Fedora, RHEL and openSUSE open the `.rpm` in the software installer or
  run `sudo dnf install ./wiijukebox-*-1.x86_64.rpm`; on Debian and Ubuntu open the
  `.deb`. Both install into `/opt/WiiJukebox` with a menu entry and the icon in the
  standard theme sizes, and keep Chromium's sandbox. Or make the AppImage executable and
  run it; if it will not start for lack of FUSE (Ubuntu 22.04 and later do not install
  it), use a package or run the AppImage with `--appimage-extract-and-run`. The AppImage starts the window with `--no-sandbox`
  because it cannot carry the setuid helper Chromium's sandbox wants; the window only
  shows the local server and the app's own pages. GNOME shows the tray icon only with
  the AppIndicator extension; without it, start the app again to bring the window back.

### Building

```bash
cd packaging/desktop
npm ci
npm run dist:linux      # AppImage; also dist:linux-deb and dist:linux-rpm on Ubuntu
npm run dist:win        # zip and installer
npm run dist:mac        # on a Mac: arm64 and x64 dmg and zip
npm run icons           # only after the jukebox mark changes: needs Inkscape and Pillow
```

`scripts/stage.js` copies `src/` and `public/` into `app/server` and our FFmpeg for the
target into `app/bin`, building it first if needed (`WIIJUKEBOX_NO_FFMPEG=1` skips it). `scripts/make-icons.py`
renders every icon from `public/images/jukebox.svg`: `build/icon.png`, `icon.ico` and
`icon.icns` for the three systems, the tray icons and window icon in `assets/`, and the
copy of the mark the local pages show.

### Test hooks

| Setting | Effect |
|---|---|
| `WIIJUKEBOX_FFMPEG`, `WIIJUKEBOX_YTDLP` | Name the one program to use, whatever the included FFmpeg setting says. A path that does not exist makes the app behave as if the program were not installed, and a script that lists no `libmp3lame` in `-encoders` as an FFmpeg without MP3; use this instead of changing `PATH`. |
| `WIIJUKEBOX_HIDDEN=1` | Never shows any window. (`--hidden`, used by start at login, only starts quietly and still shows problems.) |
| `WIIJUKEBOX_USER_DATA=<dir>` | Keeps the app's own data (settings, bin, logs) in that folder. |
| `WIIJUKEBOX_STATE_FILE=<file>` | Writes the page shown, the server URL and the tools found as JSON whenever they change. |
| `XDG_CONFIG_HOME=<dir>` | Where the server's `wiijukebox/config.json` lives, so a test can set its ports. |
| `--quit` | Asks the running copy to quit. |
| `--remote-debugging-port=<n>` | Chromium's own switch; the smoke test uses it to click the setup page. |
| `--inspect=<n>` | Node's inspector for the main process; the smoke test uses it to press the "Server name and port" and "Use included FFmpeg" menu items (`getMenuItemById('server-settings')`, `'bundled-ffmpeg'`). |

`scripts/smoke.js` is the end-to-end check of a packaged app:

```bash
node scripts/smoke.js ../dist/desktop/linux-unpacked/wiijukebox --port 4680
```

It starts the app hidden on ports 4680 (web), 4681 (discovery), 4690 (debugging) and
4691 (inspector), and checks: the server URL, that the bundled FFmpeg is the one in use,
has MP3, is GPL and decodes a stream addressed by host name (`http://localhost:<port>`),
`/api/status`, `/`, a packaged vendor file, 8 KiB of MP3 from `/stream`, a discovery reply,
a clean `--quit`, and that the ports are free afterwards. Then it runs:

- the server with web and discovery on one port number (the default configuration);
- the first-run flow by clicking the real setup page, including that the audio engine
  and server settings options come first, are ticked, and show the real FFmpeg version,
  name and port;
- the choice of a server name and port: bad names and ports are refused, a good one
  reaches `config.json` and the discovery reply;
- the "Server name and port" window, opened from the menu, with a change of name and port;
- the busy-port flow and the missing-FFmpeg flow;
- the included FFmpeg unticked: no FFmpeg on the computer, an FFmpeg without MP3 (a
  stand-in shell script, so not on Windows), and the computer's own FFmpeg followed by the
  switch back to the included one;
- the menu button: the bar's view stretching over the window, the entries and their check marks,
  the keys, a click outside, that only the bar can use it, Theme (the menu to the web UI to the
  bar and back) and Sidebar settings…;
- the live title bar, in a window shown on Chromium's headless platform (Linux only, since a window
  that is never shown renders nothing): a theme chosen in the web UI or the menu reaches the bar within
  100 ms of the page, and the menu's hover (the light following the pointer and clearing, the submenu
  closing as soon as another entry is hovered, unless the pointer is heading for it and gets a short
  grace);
- the title bar: the bar view above the page, the window title while a stand-in Subsonic server
  (`scripts/fake-subsonic.js`) plays a five-track album (count, paused, next, stopped), the bar
  buttons reaching the window (with the window's maximize, minimize and hide recorded, since
  the window is never shown), the bar being the only page with the window bridge, fullscreen of
  the page and of the visualizer's stage hiding the bar and filling the window, F11, the
  fullscreen button, Escape and closing the visualizer;
- the close card: it opens from the bar's ×, from the window being asked to close by the system and
  from a minimized window (which is restored first); its three equal buttons, the safe default,
  Escape, Enter, the remember line, the card's own window closing, and Quit leaving the app and the
  answer behind; only the card can answer it;
- Use system title bar: the menu item rebuilds the window without the bar and back, the title
  keeps following playback, and a saved choice starts the app without the bar.

It exits non-zero if any check fails. The tests use 4680 and 4681 (once also 4681 as a TCP
web port, to try a port change) so they never touch a server on the default port; CI also
passes `--default-ports` to run the app once with the server's own defaults (4005).

### Continuous integration

`.github/workflows/build.yml` builds all three apps. The desktop jobs are modeled on
Feishin's build workflows: an OS matrix, Node 22 and electron-builder. A first job builds
our FFmpeg and librespot for Linux and Windows in containers, kept in the Actions cache
until their scripts change; macOS builds its own the same way. Every runner then
installs, builds, unit-tests the desktop code and smoke-tests the packaged app. Ubuntu
also runs `npm test` and `npm run smoke`, builds the `.deb` and installs it, and builds
the `.rpm` and installs it in a `fedora:latest` container, with the smoke test run against
each installed copy. Windows smoke-tests the zip and then the installer, installed and
uninstalled for real. macOS smoke-tests the arm64 app, and the Intel app under Rosetta.

The Wii job runs in devkitPro's `devkitppc` container, pinned to the release with
devkitPPC r50 and libogc 3.1.0 that every hardware-tested build used. It runs the client's
host tests (`make -C client host-test`) and builds both zips. The Android job builds the
debug APK, or for a `v*` tag the signed release APK (see [Releasing](#releasing)).

A push or pull request builds the desktop app for Linux only (on a private repository
Windows minutes count 2x and macOS 10x). Windows and macOS run when a commit message
contains `[ci all]`, `[ci windows]` or `[ci macos]`, from the Actions page ("Run
workflow", or `gh workflow run build.yml -f platforms=macos`), or for a `v*` tag. The Wii
and Android jobs run every time. A newer push cancels a run that is still going.

A private repository has 500 MB of Actions storage, and keeping the installers of every push
once filled it in a day. So a push keeps nothing except a failed run's smoke logs
(`smoke-logs-<system>`, 3 days). "Run workflow" keeps the apps as artifacts
(`WiiJukebox-linux`, `-windows`, `-macos`, `-wii`, `-android`) for one day. A `v*` tag
puts them on a draft release and then deletes the artifacts, since release files don't
count against that storage. `test/workflow-storage.test.js` fails `npm test` when an
upload would be kept more than 3 days or would run on an ordinary push.

### Releasing

A `v*` tag builds every app and puts it on a **draft** release, so nothing is public until
someone presses Publish on the Releases page.

1. Set the version. `package.json` is the one source; `test/versions.test.js` fails until
   the others match, and the Android version comes from it on its own:

   ```bash
   npm version 1.0.0 --no-git-tag-version
   npm --prefix packaging/desktop version 1.0.0 --no-git-tag-version
   # and <version> (plus <release_date>) in client/dist/apps/wiijukebox/meta.xml
   ```

2. Commit, then make the tag with a message. The message becomes the release notes
   (Markdown works), so this is where the changelog goes:

   ```bash
   git tag -a v1.0.0    # an editor opens for the notes
   git push origin main v1.0.0
   ```

   The first job fails within seconds if the tag doesn't match `package.json` or has no
   message (a plain `git tag v1.0.0`).

3. When the run finishes, the draft release has the AppImage, `.deb` and `.rpm`, the
   Windows installer and portable zip, the macOS `.dmg` and `.zip` for Apple silicon and
   Intel, the two Wii zips (`apps/wiijukebox/` for SD cards and the Open Shop Channel, and
   the wiiload one), the signed APK, and `WiiJukebox-<version>-sources.tar` (the source archives
   of FFmpeg and shairport-sync and everything built into them, with the build scripts). Check
   it, then Publish.

To fix the notes later, edit the release on GitHub. Re-running a failed tag run keeps the
draft and replaces its files.

The release APK needs the signing key as two repository secrets (Settings, Secrets and
variables, Actions). Without them a tag's Android job fails rather than shipping an APK
that can't update the installed one:

```bash
cd ~/.local/share/wiijukebox-signing
base64 -w0 wiijukebox-release.jks | gh secret set ANDROID_SIGNING_KEYSTORE
gh secret set ANDROID_SIGNING_PROPERTIES < keystore.properties
```

The job writes them to the runner's temporary folder only for the signing step and points
`storeFile` at its own copy. Pull requests from forks never receive secrets.

## What was and was not verified

### Checked in GitHub Actions

Run [37852158837](https://github.com/cmyksoda/WiiJukebox/actions/runs/37852158837) (commit `0e55f81`) built and tested all three systems (its Linux job passed on a re-run: an unrelated timing test in `test/wii-seek-art.test.js` failed once on the loaded runner):

| | Linux (ubuntu-latest, virtual display) | Windows (windows-latest) | macOS (macos-latest, Apple silicon) |
|---|---|---|---|
| Built | AppImage, deb, rpm | portable zip, NSIS installer | arm64 and x64 dmg and zip |
| Unit tests for the desktop code | yes, inside `npm test` | yes | yes |
| `npm test` and `npm run smoke` | yes | not run | not run |
| Packaged app started by the smoke test | the AppImage; the `.deb` installed with apt, with Chromium's sandbox on; the `.rpm` installed with dnf in a `fedora:latest` container (Fedora 44) | the portable zip; the setup exe, run silently | the arm64 app; the x64 app under Rosetta |

What the smoke test confirmed on each of those (`smoke-logs-*` artifacts hold the output):

- The app starts hidden, shows the first-run page, and its server comes up on port
  4680; `/api/status`, `/`, a vendor file and 8 KiB of MP3 from `/stream` are served;
  Wii discovery answers on UDP 4681; the tray icon was created. It also ran with web
  and discovery on one port number, and (AppImage, portable zip and the arm64 app) with
  the server's own default, 4005 for both.
- The bundled FFmpeg is the copy in use, has the MP3 encoder, reports a GPL license
  and encodes a test tone. Versions seen: 7.0.2 on Linux, 6.1.1 on Windows, 8.1.3
  (Jellyfin) on macOS.
- Clicking through the real first-run page starts the server, saves
  `settings.json`, shows a Wii address and no problems on the Connect page, and Open
  WiiJukebox moves the window to the web UI. With yt-dlp ticked it downloaded
  yt-dlp into the app folder and ran it (Linux, Windows and macOS arm64).
- A busy port shows the port-busy page and one click restarts on a free port and
  saves it; a missing FFmpeg shows its page and "Start without it" starts the server.
- A second launch with `--quit` makes the app exit, and the web and discovery ports are
  closed afterwards.
- Start at login was registered with the system: an autostart file on Linux, the
  `HKCU` Run key on Windows, a login item on macOS (arm64).

Also seen per system:

- Windows: the `.exe` carries the jukebox icon and `ProductName` WiiJukebox, not
  Electron's; the installer creates the Start menu and desktop shortcuts and the
  uninstaller removes the app and the Start menu shortcut; the firewall button's
  PowerShell adds an inbound rule for Private and Domain networks (the runner is an
  administrator without a permission prompt).
- macOS: `codesign --verify --deep --strict` passes on both apps (ad-hoc signature),
  both disk images mount and hold a verifying app, and `spctl` rejects the apps, as
  expected for an unsigned download. The bundled FFmpeg is a thin binary for the app's
  architecture.
- Linux: the `.deb` installs `/opt/WiiJukebox` and a menu entry and removes cleanly.
  The `.rpm` (name `wiijukebox`, GPL-3.0-only, `rpm -qip` metadata filled in) installs
  on Fedora 44 with `dnf`: before anything else is added, `ldd` finds every shared
  library of the app from the rpm's own dependencies; the files are `/opt/WiiJukebox`,
  `/usr/share/applications/wiijukebox.desktop` and icons from 16 to 512 pixels in
  `/usr/share/icons/hicolor`, with no `.build-id` links that could clash with another
  Electron package; the smoke test passes; `dnf remove` leaves nothing behind.

### Checked by hand on Fedora (Linux)

The AppImage and the unpacked app ran hidden on this machine against the real X11
session with the same smoke test, and each page (welcome, connect with and without
problems, port busy, crash, FFmpeg missing) was rendered and read.

### Not verified

- The welcome options, the "Server name and port" window and the "Use included FFmpeg"
  menu item were smoke-tested on Linux (the AppImage, on this Fedora machine) only. The
  menu items are pressed through Node's inspector there; that route has not run on
  Windows or macOS yet, and a real click on the menu and the new window on a visible
  screen was not tried.
- Anything that needs a person at a real screen: how the tray or menu bar icon and its
  menu look, the close-window question, and the pages on real Windows and macOS
  displays (CI drives them hidden). The pages were rendered in light and dark themes
  on Linux only.
- The custom title bar on a real desktop: dragging the window by the bar and a double click
  maximizing it (the bar sets `-webkit-app-region: drag`, which the smoke test reads but cannot
  press), the resize edges of the frameless window on X11, Wayland and KDE, the snap and
  maximize behavior on Windows, the traffic lights inset into the bar on macOS, the bar's menu
  button popping up in place, and fullscreen on the monitor the window is on (the smoke test
  checks the bar and the page against the window's own size, hidden, not a second display).
  Screenshots of the bar were taken on Chromium's headless platform, one view at a time, and
  laid together.
- A real Wii connecting through each system's firewall: the Windows Defender prompt
  and the Public network profile, the macOS firewall and Local Network prompts
  (macOS 15 and later), and ufw or firewalld. The runners' firewalls are not
  representative.
- Signing and notarization: none exists. SmartScreen (Windows) and Gatekeeper (macOS)
  warnings on a downloaded copy, and the Open Anyway steps above, were not tried on
  real downloads.
- Start at login actually launching the app after signing in (it is registered, but
  nothing was rebooted), and macOS login items for an app that is not in Applications.
- macOS on Intel hardware or older than the runner's macOS (the Intel app ran under
  Rosetta; Electron needs macOS 12), Windows on ARM, Linux on arm64.
- The `.rpm` on a real Fedora desktop (Wayland session, the menu entry and icon showing,
  the tray on GNOME or KDE) and on RHEL or openSUSE. The container run has no desktop or
  GPU and runs as root with `--no-sandbox`; the deb run is what covers Chromium's sandbox.
- GNOME without the AppIndicator extension shows no tray icon; the window then comes
  back by starting the app again. Not tried.
- The yt-dlp download on Intel macOS, and whether the receivers in
  `docs/streaming-services.md` (librespot, shairport-sync) can be used from the app.
- The Wii program itself is not part of the desktop app; install it on the Wii
  separately.
- Android: the debug APK builds, `aapt2` reads its manifest, `apksigner` verifies its
  debug signature, and the discovery class (compiled on a plain JVM) found the test
  server through its real UDP discovery port. The app was not installed on a phone or
  emulator (none available).

### librespot (Spotify Connect)

librespot publishes no builds, so `scripts/build-librespot.sh` builds 0.8.0 from crates.io with its
own lockfile, the same way and in the same places as FFmpeg (`scripts/build.js librespot <target>`).
It uses rustls instead of OpenSSL, so it needs no system libraries beyond the C library, and only
the pipe audio backend, since WiiJukebox reads its audio from stdout. librespot is MIT licensed;
`librespot-LICENSE.txt` next to it also carries the license of every crate built into it, with
where to find each crate's source (Symphonia, its audio decoder, is MPL 2.0).
`WIIJUKEBOX_NO_LIBRESPOT=1` leaves it out of a build.

### shairport-sync (AirPlay)

`scripts/build-shairport.sh` builds shairport-sync 5.5.2 for Linux and macOS (it has no Windows
version), the same way and in the same places as FFmpeg (`scripts/build.js shairport <target>`). It
is classic AirPlay (AirPlay 1) with the stdout audio backend and the metadata pipe, which is what
`src/sources/airplay.js` drives. Linked in: popt, libconfig (LGPL 2.1), OpenSSL's libcrypto and
FFmpeg 8.1.3's ALAC and AAC decoders (LGPL v3). It announces itself through the system's mDNS
service, so beyond the C library it needs Avahi's client library on Linux (`libavahi-client.so.3`,
which desktop Linux has; the `.deb` recommends `libavahi-client3` next to electron-builder's default
`libappindicator3-1`) and nothing extra on macOS, which has Bonjour. Its own tinysvcmdns responder is
left out: it claims the computer's host name with every interface's address, and in testing Avahi
then renamed the computer (`fedora.local` to `fedora-2.local`). `shairport-sync-LICENSE.txt` and
`shairport-sync-README.txt` (sources and configuration) ship next to it, and each release's
`WiiJukebox-<version>-sources.tar` has the source archives. `WIIJUKEBOX_NO_SHAIRPORT=1` leaves it out of a build.

macOS has its own AirPlay Receiver on port 5000 (System Settings, General, AirDrop & Handoff), which
shairport-sync also needs, so it has to be off there.
