// SPDX-License-Identifier: GPL-3.0-only
// Finds or builds a program the app bundles (scripts/build-<tool>.sh) for one target. Linux and
// Windows builds run in a container on a Linux computer; Mac builds run on the Mac itself.
// Usage: node scripts/build.js <ffmpeg|librespot|shairport> <linux-x64|win-x64|mac-arm64|mac-x64>
// WIIJUKEBOX_BUILDS names a folder to keep the builds in (CI caches it) instead of ~/.cache,
// and WIIJUKEBOX_CONTAINER picks docker or podman.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const cache = path.join(os.homedir(), '.cache', 'wiijukebox-desktop');
const TARGETS = ['linux-x64', 'win-x64', 'mac-arm64', 'mac-x64'];

// AlmaLinux 8 has glibc 2.28, as Jellyfin's builds required, so its binaries run on any newer Linux.
const IMAGES = { 'linux-x64': 'docker.io/library/almalinux:8', 'win-x64': 'docker.io/library/debian:bookworm' };
const LINUX = 'dnf -y -q install gcc make pkgconf-pkg-config diffutils xz tar';
const DEBIAN = 'apt-get update -qq && apt-get install -y -qq --no-install-recommends'
    + ' gcc libc6-dev gcc-mingw-w64-x86-64 make pkg-config curl ca-certificates xz-utils';
const SETUP = {
    ffmpeg: {
        'linux-x64': `${LINUX} perl perl-IPC-Cmd && dnf -y -q --enablerepo=powertools install nasm`,
        'win-x64': `${DEBIAN} nasm`,
    },
    librespot: {
        'linux-x64': `${LINUX} python3`,
        'win-x64': `${DEBIAN} python3`,
    },
    // shairport-sync has no Windows version.
    shairport: {
        'linux-x64': `${LINUX} gcc-c++ perl perl-IPC-Cmd autoconf automake libtool`
            + ' && dnf -y -q --enablerepo=powertools install libstdc++-static avahi-devel',
    },
};

function script(tool) {
    return path.join(__dirname, `build-${tool}.sh`);
}

/** Where a build lives; changing its script changes the folder. */
function buildDir(tool, target) {
    if (process.env.WIIJUKEBOX_BUILDS) return path.join(process.env.WIIJUKEBOX_BUILDS, tool, target);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(script(tool))).digest('hex').slice(0, 12);
    return path.join(cache, `${tool}-build`, `${target}-${hash}`);
}

function containerTool() {
    const named = process.env.WIIJUKEBOX_CONTAINER;
    for (const tool of named ? [named] : ['podman', 'docker']) {
        try {
            execFileSync(tool, ['--version'], { stdio: 'ignore' });
            return tool;
        } catch {
            // try the next one
        }
    }
    throw new Error('building for Linux or Windows needs podman or docker');
}

function build(tool, target, dir) {
    const sources = path.join(cache, `${tool}-src`);
    const partial = `${dir}.part`;
    fs.mkdirSync(sources, { recursive: true });
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    if (target.startsWith('mac-')) {
        const env = { ...process.env, WIIJUKEBOX_BUILD_SOURCES: sources };
        execFileSync('bash', [script(tool), target, partial], { stdio: 'inherit', env });
    } else {
        const runner = containerTool();
        // Rootful Docker would leave root-owned files behind; rootless Podman maps root to the user.
        const chown = runner === 'docker' ? ` && chown -R ${process.getuid()}:${process.getgid()} /out` : '';
        execFileSync(runner, ['run', '--rm', '--pids-limit', '2048', '--security-opt', 'label=disable',
            '-v', `${__dirname}:/scripts:ro`, '-v', `${sources}:/sources`, '-v', `${partial}:/out`,
            '-e', 'WIIJUKEBOX_BUILD_SOURCES=/sources', '-e', 'WIIJUKEBOX_BUILD_WORK=/work',
            IMAGES[target], 'bash', '-euc',
            `${SETUP[tool][target]} >/dev/null && bash /scripts/build-${tool}.sh ${target} /out${chown}`,
        ], { stdio: 'inherit' });
    }
    fs.renameSync(partial, dir);
}

/** The folder holding the tool's build for the target, with its licenses, built first if needed. */
function bundledBuild(tool, target) {
    if (!SETUP[tool]) throw new Error(`unknown tool ${tool}; use ${Object.keys(SETUP).join(', ')}`);
    if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}; use ${TARGETS.join(', ')}`);
    if (!target.startsWith('mac-') && !SETUP[tool][target]) throw new Error(`${tool} has no ${target} build`);
    const dir = buildDir(tool, target);
    if (!fs.existsSync(dir)) build(tool, target, dir);
    return dir;
}

module.exports = { bundledBuild, buildDir };

if (require.main === module) {
    try {
        console.log(bundledBuild(process.argv[2], process.argv[3]));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
