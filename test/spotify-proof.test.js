// SPDX-License-Identifier: GPL-3.0-only
// The connection check, run as the settings button and as tools/spotify-proof.js would, over a fake Spotify.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { rig } = require('./helpers/spotify-rig');
const { parseTrack } = require('../src/sources/spotify-proof');

const TOOL = path.join(__dirname, '..', 'tools', 'spotify-proof.js');
const proof = async (r, body) => (await (await r.app.post('/api/sources/spotify/action/proof', body)).json()).steps;
const verdicts = (steps) => Object.fromEntries(steps.map((step) => [step.name, step.ok]));
const cli = (args) => new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

test('read-only check reports each step and does not touch playback', async () => {
    const r = await rig();
    try {
        const steps = await proof(r, { play: false });
        assert.deepEqual(verdicts(steps), {
            Authenticate: true, 'Read Liked Songs': true, 'Read one owned playlist': true,
            'Read a followed playlist (information only)': true, 'Find the receiver': false,
        });
        assert.match(steps[0].detail, /Signed in as Jaxi/);
        assert.match(steps[1].detail, /130 songs; the first is Liked Song 1 — Mika Ito/);
        assert.match(steps[2].detail, /"Road Trip" has 130 items/);
        assert.match(steps[3].detail, /hides its tracks.*expected/);
        assert.match(steps[4].detail, /receiver is not running/);
        assert.equal(r.fake.paths('PUT').length, 0, 'nothing was played');
        assert.equal(r.runs(), 0);
    } finally { await r.close(); }
});

test('the full check starts the receiver, finds it, plays a song into the stream and pauses it', async () => {
    const r = await rig();
    try {
        const steps = await proof(r, { play: true, wait: 3 });
        assert.ok(steps.every((step) => step.ok === true), JSON.stringify(steps));
        assert.deepEqual(steps.map((step) => step.name).slice(-4), ['Start the receiver', 'Find the receiver', 'Play a chosen track', 'Pause and resume']);
        assert.match(steps.find((step) => step.name === 'Find the receiver').detail, /Found "WiiJukebox"/);
        assert.match(steps.find((step) => step.name === 'Play a chosen track').detail, /Playing "Liked Song 1".*bytes of audio reached/);
        assert.deepEqual(r.fake.calls.filter((call) => call.path === '/me/player/play')[0].body, { uris: ['spotify:track:lk001'] });
        assert.equal(r.fake.player.playing, true);
        assert.equal(r.runs(), 1);
        assert.equal(r.app.pipeline.activeSource, r.source(), 'it played through the same stream the Wii listens to');

        const chosen = await proof(r, { play: true, wait: 3, track: 'https://open.spotify.com/intl-de/track/sh004?si=abc' });
        assert.ok(chosen.every((step) => step.ok !== false), JSON.stringify(chosen));
        assert.deepEqual(r.fake.calls.filter((call) => call.path === '/me/player/play').at(-2).body, { uris: ['spotify:track:sh004'] });
        assert.equal(r.runs(), 1, 'a second check does not restart the receiver');
        assert.equal((await proof(r, { play: true, wait: 3, track: 'not a track!' })).find((step) => step.name === 'Play a chosen track').ok, false);
    } finally { await r.close(); }
});

test('without a sign-in the check says so and skips the rest', async () => {
    const r = await rig({ signedIn: false });
    try {
        const steps = await proof(r, { play: true });
        assert.deepEqual(steps.map((step) => step.ok), [false, null, null, null, null]);
        assert.match(steps[0].detail, /Connect Spotify account/);
    } finally { await r.close(); }
});

test('track links, uris and bare ids are all understood', () => {
    for (const text of ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x', '4uLU6hMCjMI75M1A2tKUQC']) {
        assert.equal(parseTrack(text), '4uLU6hMCjMI75M1A2tKUQC', text);
    }
    assert.equal(parseTrack('spotify:album:4uLU6hMCjMI75M1A2tKUQC'), null);
    assert.equal(parseTrack(''), null);
});

test('the command-line tool prints pass or fail per step, exits by the result and never prints a token', async () => {
    const r = await rig();
    try {
        const ok = await cli(['--url', r.app.base, '--wait', '3']);
        assert.equal(ok.code, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, / PASS {2}Authenticate\n {7}Signed in as Jaxi/);
        assert.match(ok.stdout, /Every step passed/);
        assert.doesNotMatch(ok.stdout + ok.stderr, /ref-|acc-|code_verifier|Bearer/);
    } finally { await r.close(); }

    const free = await rig({ fake: { premium: false } });
    try {
        const bad = await cli(['--url', free.app.base, '--wait', '2']);
        assert.equal(bad.code, 1);
        assert.match(bad.stdout, / FAIL {2}Play a chosen track\n {7}Spotify Premium is required/);
    } finally { await free.close(); }

    const gone = await cli(['--url', 'http://127.0.0.1:9', '--no-play']);
    assert.equal(gone.code, 2);
    assert.match(gone.stderr, /Could not reach WiiJukebox/);
    assert.equal((await cli(['--bogus'])).code, 2);
});
