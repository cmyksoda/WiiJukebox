#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Runs the Spotify connection check on a running WiiJukebox server and prints each step as pass or fail:
// sign-in, Liked Songs, an owned playlist, the receiver, and a song played to the Wii's stream.
//
//   node tools/spotify-proof.js [--url http://127.0.0.1:4005] [--track URI_OR_LINK] [--no-play] [--wait SECONDS]
//
// The server does the work with its own saved sign-in, so nothing secret passes through here.

const USAGE = `usage: node tools/spotify-proof.js [--url ADDRESS] [--track URI_OR_LINK] [--no-play] [--wait SECONDS]

  --url      the WiiJukebox server (default http://127.0.0.1:4005)
  --track    a song to play; by default your first Liked Song
  --no-play  only read: sign-in, Liked Songs, a playlist and the receiver
  --wait     seconds to wait for Spotify to list the receiver (default 45)`;

function parseArguments(argv) {
    const options = { url: 'http://127.0.0.1:4005', track: null, play: true, wait: 45 };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--no-play') options.play = false;
        else if (flag === '--url') options.url = argv[++i];
        else if (flag === '--track') options.track = argv[++i];
        else if (flag === '--wait') options.wait = Number(argv[++i]);
        else if (flag === '--help' || flag === '-h') options.help = true;
        else throw new Error(`unknown option ${flag}`);
    }
    if (!options.url || !(options.wait > 0)) throw new Error('--url needs an address and --wait a number of seconds');
    return options;
}

const MARK = { true: 'PASS', false: 'FAIL', null: 'SKIP' };

function report(steps) {
    for (const step of steps) {
        console.log(` ${MARK[step.ok]}  ${step.name}`);
        if (step.detail) console.log(`       ${step.detail}`);
    }
    const failed = steps.filter((step) => step.ok === false).length;
    console.log(failed ? `\n${failed} step${failed === 1 ? '' : 's'} failed.` : '\nEvery step passed.');
    return failed;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) return console.log(USAGE);
    const base = options.url.replace(/\/+$/, '');
    console.log(`Spotify check on ${base}`);
    if (options.play) {
        console.log('This starts the receiver and plays a song into the stream, so the Wii will hear it.');
        console.log('If Spotify has not seen the receiver yet, open Spotify and pick it in the device list now.');
    }
    console.log('');

    let response;
    try {
        response = await fetch(`${base}/api/sources/spotify/action/proof`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ play: options.play, track: options.track, wait: options.wait }),
            signal: AbortSignal.timeout((options.wait + 90) * 1000),
        });
    } catch (err) {
        const why = err.cause?.code || err.message;
        console.error(`Could not reach WiiJukebox at ${base} (${why}). Start it, or pass --url.`);
        return 2;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error(body.error || `The server answered HTTP ${response.status}.`);
        return 2;
    }
    return report(body.steps) ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
});
