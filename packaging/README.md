# Packaging

Everything here builds from source with scripts. Outputs go to `packaging/dist/`
(ignored by git). Only the Android release build is signed.

| Target | Source | Command | Output |
|---|---|---|---|
| Android controller | `android/` | `packaging/android/build.sh` (or `build.sh release`) | `dist/WiiJukebox-android-debug.apk` (or `dist/WiiJukebox-android.apk`) |
| Linux desktop | `desktop/` | `npm run dist:linux` in `packaging/desktop` | `dist/desktop/WiiJukebox-<version>-linux-x86_64.AppImage` |
| Windows desktop | `desktop/` | `npm run dist:win` | `dist/desktop/WiiJukebox-<version>-win-x64.zip` and `-win-setup-x64.exe` |

Run `npm ci` in the repository root first: the desktop builds copy `public/vendor`,
which `npm ci` creates. The desktop builds also need `npm install` inside
`packaging/desktop` (Electron and electron-builder).

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

## Desktop app (Linux, Windows)

Electron runs the same server code as `npm start` in a child process and shows
its web page in a native window.

Why Electron: the server is Node, and Electron carries its own Node runtime, so
users install nothing. It builds reliably here and produces AppImage, zip and
installer artifacts for both systems from Linux. A macOS build is left out
until it can be tested on a Mac. Tauri would need a separate
Node sidecar and system WebKit packages.

What the app does:

- FFmpeg is required. It uses a copy found on `PATH` or in the usual package
  manager folders first, then the one bundled in the app (FFmpeg 6.1.1 GPL build
  from eugeneware/ffmpeg-static, with its license text in `resources/bin`). If
  none works, it shows a page with the install command for the platform and a
  "Check again" button.
- yt-dlp is optional. On first launch the app offers to download the standalone
  yt-dlp release into its own folder; Settings, Install or update yt-dlp does the
  same later.
- Settings stay where the command-line server keeps them
  (`~/.config/wiijukebox`, `%APPDATA%\wiijukebox`). The port, discovery port and everything else in
  `config.json` apply.
- A server crash shows its last lines with a Restart button. Closing the window
  stops the server and its FFmpeg.
- Test hooks: `WIIJUKEBOX_FFMPEG` and `WIIJUKEBOX_YTDLP` name the one program to
  use. Pointing one at a missing file makes the app behave as if it were not
  installed. `WIIJUKEBOX_HIDDEN=1` keeps the window hidden.

`scripts/stage.js` copies `src/` and `public/` into `app/server` and downloads
the FFmpeg for the target (`WIIJUKEBOX_NO_FFMPEG=1` skips it). `build/icon.png`
was made with ImageMagick:

```bash
magick -size 1024x1024 xc:none -fill '#1aa5e8' -draw 'roundrectangle 0,0 1023,1023 200,200' \
  -fill white -draw 'polygon 412,300 712,512 412,724' \
  -draw 'roundrectangle 280,392 336,632 14,14' -draw 'roundrectangle 780,432 836,592 14,14' \
  build/icon.png
```

### Linux

An AppImage. It runs the window with `--no-sandbox` because an AppImage cannot
carry the setuid helper Chromium's sandbox wants; the window only ever shows the
local server and the app's own setup page. If the AppImage will not start for lack
of FUSE, run it with `--appimage-extract-and-run`.

The app menu has Copy Wii stream address, Open in browser, Restart server and Show settings folder.

### Windows

`win-x64.zip` is a portable folder (run `WiiJukebox.exe`). The NSIS installer
(`win-setup-x64.exe`) installs per user with a chosen folder. Both were built on
Linux without Wine by turning off executable editing (`signAndEditExecutable`),
so the `.exe` carries Electron's default icon and version strings.

Windows SmartScreen will warn about an unsigned download. Firewall prompts for
the app are expected: the Wii connects to the server's port and UDP discovery.

## What was and was not verified

Verified on this Linux machine:

- Android: the debug APK builds, `aapt2` reads its manifest, `apksigner` verifies
  its debug signature, and the discovery class (compiled on a plain JVM) found
  the test server through its real UDP discovery port. The app was not installed
  on a phone or emulator (none available).
- Linux: the AppImage builds; its extracted contents start under a virtual X
  server, run the packaged server and load the web page in the window. The
  missing-FFmpeg page appears when `WIIJUKEBOX_FFMPEG` points at nothing and
  "Start without it" starts the server. Node tests cover tool detection, server
  start/stop/crash reporting and the yt-dlp installer (`test/desktop-app.test.js`).

Not verified (no Windows machine available):

- That the Windows zip or the installer start at all, and that
  the server, FFmpeg or yt-dlp work there. FFmpeg and yt-dlp discovery on Windows
  folders (Scoop, WinGet, Chocolatey, Program Files) is untested.
- Installer behavior (shortcuts, uninstall), SmartScreen behavior and code
  signing.
- Wii discovery through the Windows firewall.
