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
  uses (`src/client/discovery.js`), on port 4001 plus any extra ports you enter;
- remembers the chosen server by its ID, so a changed IP address is found again;
- lets you type an address (`192.168.0.3:4000`) when discovery is blocked;
- shows the controller page in a WebView that follows the system light/dark
  setting, and sends its Back button to the page first (close a sheet, go up a
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

Not done: a lock-screen media notification and a Play Store listing.

## Desktop app (Linux, Windows, macOS)

For people who should never need a terminal or a browser address: download, open,
and the music server runs. Electron runs the same server code as `npm start` in a
child process and shows its web page in a native window, so the web UI is the app's
interface. Electron carries its own Node runtime and each build carries FFmpeg, so
nothing is installed first. Tauri would need a separate Node sidecar and system
WebKit packages.

### What a person sees

- **First run.** A welcome page offers two choices (YouTube, SoundCloud and Bandcamp
  support by downloading yt-dlp, and start at login), then starts the server and
  shows **Connect your Wii**: put the Wii on the same network, open WiiJukebox on it
  (it finds the computer by UDP discovery), or type the address shown (for example
  `192.168.0.3:4000`). The page also reports whether the server and discovery are
  working. After that the window shows the web UI.
- **Background.** A tray icon (menu bar icon on a Mac) keeps the server and the music
  going. The first time the window is closed the app asks whether to keep playing in
  the background or quit, and remembers the answer ("Keep playing when the window is
  closed" in the menu changes it). Quit from the tray or application menu stops the
  server and its FFmpeg. If the app is killed without quitting, the server notices
  and stops by itself.
- **Start at login** (menu item, offered on first run). The app then opens quietly in
  the tray, so the Wii can connect after a restart. Windows and macOS use their login
  items; Linux writes `~/.config/autostart/wiijukebox.desktop`.
- **One copy.** Starting the app again brings the window forward. Starting it with
  `--quit` makes the running copy quit (scripts, installers).
- **Menu and tray entries.** Connect your Wii, Copy Wii address, Copy stream address,
  Open in browser, Restart server, Install or update yt-dlp, Start at login, Show
  settings folder, Show server log (`logs/server.log` in the app's data folder).
- **Errors are pages, not console text.** A busy port shows "Port 4000 is in use" with
  a free port suggested; one click saves it in the server's `config.json` and
  restarts (the Wii finds the new port by discovery). A server crash shows its last
  lines and a Restart button. A missing FFmpeg shows install commands, a Check again
  button and "Start without it". A failed yt-dlp download shows a note on the Connect
  page and can be retried from the menu.

### Ports and firewalls

The Wii needs the web port (default TCP 4000) and the discovery port (UDP 4001).
Nothing in the app opens them to the internet; they are for the local network.

| System | What happens | What the app does |
|---|---|---|
| Windows | Windows Defender Firewall asks the first time the server listens. Allow, with Private networks ticked. A dismissed question leaves the Wii unable to connect, and a Wi-Fi network marked Public stays blocked. | The Connect page explains this and has **Allow WiiJukebox in Windows Firewall**, which asks for administrator permission once and adds an inbound rule for the program on Private and Domain networks. |
| macOS | If the system firewall is on, macOS asks whether WiiJukebox may accept incoming connections. macOS 15 and later can also ask about local network access. | The first-run page and Connect page name both prompts and where to change them. The app declares `NSLocalNetworkUsageDescription`. |
| Linux | Most systems allow it. With ufw or firewalld, TCP 4000 and UDP 4001 need to be opened. | The Connect page shows the exact `ufw` and `firewalld` commands for the current ports. |

The Connect page also asks the discovery port the way a Wii does, so a port that is
taken or blocked on this computer is reported with "type the address on the Wii".

### FFmpeg and yt-dlp

FFmpeg is bundled and always used before anything on `PATH`: a system build such as
Fedora's `ffmpeg-free` can lack the MP3 encoder the stream needs. Every bundled build
is GPL v3 with `libmp3lame`, and its license text and source pointer ship next to it
in `resources/bin` (`ffmpeg-LICENSE.txt`, `ffmpeg-README.txt`). `scripts/stage.js`
downloads each one and checks a pinned SHA-256.

| System | Build | Source |
|---|---|---|
| Linux x64 | FFmpeg 7.0.2 static | johnvansickle.com, through eugeneware/ffmpeg-static `b6.1.1` |
| Windows x64 | FFmpeg 6.1.1 essentials | gyan.dev, through eugeneware/ffmpeg-static `b6.1.1` |
| macOS x64 and arm64 | FFmpeg 8.1.3 (Jellyfin portable GPL build) | jellyfin/jellyfin-ffmpeg `v8.1.3-1` (needs macOS 12 or later) |

macOS does not use eugeneware's builds: its arm64 binary is configured
`--enable-nonfree`, reports "nonfree and unredistributable" and must not be shipped.

yt-dlp is optional and not bundled. The first-run page (or Install or update yt-dlp
in the menu) downloads the standalone release into the app's own `bin` folder, and
that copy is used before one on `PATH` so updating it takes effect. Spotify Connect
and AirPlay receivers (librespot, shairport-sync) are not bundled either; see
`docs/streaming-services.md`.

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

`scripts/stage.js` copies `src/` and `public/` into `app/server` and downloads the
FFmpeg for the target (`WIIJUKEBOX_NO_FFMPEG=1` skips it). `scripts/make-icons.py`
renders every icon from `public/images/jukebox.svg`: `build/icon.png`, `icon.ico` and
`icon.icns` for the three systems, the tray icons and window icon in `assets/`, and the
copy of the mark the local pages show.

### Test hooks

| Setting | Effect |
|---|---|
| `WIIJUKEBOX_FFMPEG`, `WIIJUKEBOX_YTDLP` | Name the one program to use. A path that does not exist makes the app behave as if the program were not installed; use this instead of changing `PATH`. |
| `WIIJUKEBOX_HIDDEN=1` | Never shows any window. (`--hidden`, used by start at login, only starts quietly and still shows problems.) |
| `WIIJUKEBOX_USER_DATA=<dir>` | Keeps the app's own data (settings, bin, logs) in that folder. |
| `WIIJUKEBOX_STATE_FILE=<file>` | Writes the page shown, the server URL and the tools found as JSON whenever they change. |
| `XDG_CONFIG_HOME=<dir>` | Where the server's `wiijukebox/config.json` lives, so a test can set its ports. |
| `--quit` | Asks the running copy to quit. |
| `--remote-debugging-port=<n>` | Chromium's own switch; the smoke test uses it to click the setup page. |

`scripts/smoke.js` is the end-to-end check of a packaged app:

```bash
node scripts/smoke.js ../dist/desktop/linux-unpacked/wiijukebox --port 4680
```

It starts the app hidden on ports 4680 (web), 4681 (discovery) and 4690 (debugging),
and checks: the server URL, that the bundled FFmpeg is the one in use, has MP3 and is
GPL, `/api/status`, `/`, a packaged vendor file, 8 KiB of MP3 from `/stream`, a
discovery reply, a clean `--quit`, and that the ports are free afterwards. Then it runs
the first-run flow by clicking the real setup page, the busy-port flow and the
missing-FFmpeg flow. It exits non-zero if any check fails.

### Continuous integration

`.github/workflows/desktop.yml` is modeled on Feishin's build workflows: an OS matrix,
Node 22, electron-builder, and the installers uploaded as artifacts. Every runner
installs, builds, unit-tests the desktop code, smoke-tests the packaged app and
uploads it. Ubuntu also runs `npm test` and `npm run smoke`, builds the `.deb` and
installs it, and builds the `.rpm` and installs it in a `fedora:latest` container, with
the smoke test run against each installed copy. Windows smoke-tests the zip and then the installer,
installed and uninstalled for real. macOS smoke-tests the arm64 app, and the Intel app
under Rosetta.

Because the repository is private (Windows minutes count 2x, macOS 10x), a push or pull
request builds Linux only. Windows and macOS run when a commit message contains
`[ci all]`, `[ci windows]` or `[ci macos]`, from the Actions page ("Run workflow", or
`gh workflow run desktop.yml -f platforms=macos`), or for a `v*` tag. A newer push
cancels a run that is still going. Artifacts are `WiiJukebox-linux`,
`WiiJukebox-windows` and `WiiJukebox-macos`, kept for 14 days, with the smoke logs in
`smoke-logs-<system>`.

## What was and was not verified

### Checked in GitHub Actions

Run RUN_URL (commit `COMMIT`) built and tested all three systems:

| | Linux (ubuntu-latest, virtual display) | Windows (windows-latest) | macOS (macos-latest, Apple silicon) |
|---|---|---|---|
| Built | AppImage, deb | zip, NSIS installer | arm64 and x64 dmg and zip |
| Unit tests for the desktop code | yes, inside `npm test` | yes | yes |
| `npm test` and `npm run smoke` | yes | not run | not run |
| Packaged app started by the smoke test | the AppImage; the `.deb` installed with apt, with Chromium's sandbox on | the portable zip; the setup exe, run silently | the arm64 app; the x64 app under Rosetta |

What the smoke test confirmed on each of those (`smoke-logs-*` artifacts hold the output):

- The app starts hidden, shows the first-run page, and its server comes up on port
  4680; `/api/status`, `/`, a vendor file and 8 KiB of MP3 from `/stream` are served;
  Wii discovery answers on UDP 4681; the tray icon was created.
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

### Checked by hand on Fedora (Linux)

The AppImage and the unpacked app ran hidden on this machine against the real X11
session with the same smoke test, and each page (welcome, connect with and without
problems, port busy, crash, FFmpeg missing) was rendered and read.

### Not verified

- Anything that needs a person at a real screen: how the tray or menu bar icon and its
  menu look, the close-window question, and the pages on real Windows and macOS
  displays (CI drives them hidden). The pages were rendered in light and dark themes
  on Linux only.
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
  Rosetta; the bundled FFmpeg needs macOS 12), Windows on ARM, Linux on arm64.
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
