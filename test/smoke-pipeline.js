// End-to-end proof that the persistent stream actually is persistent.
//
// The whole design rests on one claim: a listener can connect once and keep
// receiving unbroken MP3 while sources are swapped underneath. If that is
// wrong, a player drops its connection on every track change and the
// project's entire premise fails. So this test asserts it directly rather than
// trusting the architecture.
//
// It runs against real ffmpeg with generated tone files -- no network needed.

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { Pipeline } = require('../src/core/pipeline');
const { Source } = require('../src/sources/base');
const { BYTES_PER_SECOND } = require('../src/core/format');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-smoke-'));

let failures = 0;
function check(label, ok, detail = '') {
    const mark = ok ? '  ok  ' : ' FAIL ';
    console.log(`[${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tone file standing in for "some source of audio". */
function makeTone(name, freq, seconds) {
    const file = path.join(TMP, name);
    execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
         '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`,
         '-ac', '2', '-y', file],
        { stdio: 'pipe' },
    );
    return file;
}

/** Minimal pull source that plays one local file. */
class ToneSource extends Source {
    static id = 'tone';
    static label = 'Test Tone';
    constructor(file, title) {
        super();
        this.file = file;
        this.title = title;
    }
    get capabilities() {
        return { play: true, stop: true };
    }
    async open() {
        this._setState('playing');
        this._emitMetadata({ artist: 'Test', title: this.title });
        return { type: 'uri', uri: this.file };
    }
}

/**
 * An ICY listener that records what it receives, as a compatible music player would:
 * requests metadata, then walks the metaint framing separating audio from
 * metadata blocks.
 */
function connectListener(port, mount) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        const state = {
            socket: sock,
            headers: '',
            audioBytes: 0,
            titles: [],
            // Gaps are what actually matter: a real dropout means the socket
            // stalled, so track the longest silence between data events.
            lastDataAt: 0,
            maxGapMs: 0,
            closed: false,
            error: null,
        };

        sock.on('connect', () => {
            sock.write(
                `GET ${mount} HTTP/1.0\r\nHost: 127.0.0.1\r\n` +
                    `Icy-MetaData: 1\r\nUser-Agent: smoke-test\r\n\r\n`,
            );
        });

        let buf = Buffer.alloc(0);
        let phase = 'headers';
        let metaint = 0;
        let audioLeft = 0;
        let metaLeft = 0;
        let resolved = false;

        sock.on('data', (chunk) => {
            const now = Date.now();
            if (state.lastDataAt) {
                state.maxGapMs = Math.max(state.maxGapMs, now - state.lastDataAt);
            }
            state.lastDataAt = now;

            buf = Buffer.concat([buf, chunk]);

            if (phase === 'headers') {
                const end = buf.indexOf('\r\n\r\n');
                if (end === -1) return;
                state.headers = buf.toString('latin1', 0, end);
                buf = buf.subarray(end + 4);
                metaint = parseInt(
                    (state.headers.match(/^icy-metaint:\s*(\d+)/im) || [])[1],
                    10,
                );
                state.metaint = metaint;
                phase = metaint ? 'audio' : 'raw';
                audioLeft = metaint;
                if (!resolved) {
                    resolved = true;
                    resolve(state);
                }
            }

            while (buf.length) {
                if (phase === 'raw') {
                    state.audioBytes += buf.length;
                    buf = Buffer.alloc(0);
                } else if (phase === 'audio') {
                    const n = Math.min(audioLeft, buf.length);
                    state.audioBytes += n;
                    buf = buf.subarray(n);
                    audioLeft -= n;
                    if (audioLeft === 0) phase = 'metalen';
                } else if (phase === 'metalen') {
                    metaLeft = buf[0] * 16;
                    buf = buf.subarray(1);
                    if (metaLeft === 0) {
                        phase = 'audio';
                        audioLeft = metaint;
                    } else {
                        phase = 'meta';
                    }
                } else if (phase === 'meta') {
                    if (buf.length < metaLeft) return;
                    const meta = buf.toString('utf8', 0, metaLeft).replace(/\0+$/, '');
                    buf = buf.subarray(metaLeft);
                    phase = 'audio';
                    audioLeft = metaint;
                    const title = (meta.match(/StreamTitle='(.*?)';/) || [])[1];
                    if (title != null) state.titles.push(title);
                }
            }
        });

        sock.on('error', (err) => {
            state.error = err;
            if (!resolved) reject(err);
        });
        sock.on('close', () => {
            state.closed = true;
        });
    });
}

async function main() {
    console.log('\n=== WiiJukebox pipeline smoke test ===\n');

    console.log('generating test audio...');
    const toneA = makeTone('a.wav', 440, 30);
    const toneB = makeTone('b.wav', 880, 30);

    const pipeline = new Pipeline({ station: { name: 'SmokeTest', mount: '/stream' } });
    const warnings = [];
    pipeline.on('warning', (m) => warnings.push(m));

    const server = http.createServer((req, res) => {
        if (pipeline.broadcaster.handles(req)) {
            pipeline.broadcaster.handleRequest(req, res);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    pipeline.start();
    console.log(`listening on 127.0.0.1:${port}\n`);

    // --- the encoder must produce audio with no source at all ---------------
    const listener = await connectListener(port, '/stream');

    check('ICY headers returned', /200/.test(listener.headers), listener.headers.split('\r\n')[0]);
    check('icy-metaint advertised', listener.metaint === 16000, `metaint=${listener.metaint}`);
    check(
        'icy-br advertised (clients estimate buffered duration from this)',
        new RegExp(`icy-br:\\s*${pipeline.encoder.bitrate}\\r`, 'i').test(listener.headers),
        `encoder ${pipeline.encoder.bitrate} kbps`,
    );
    check(
        'icy-sr advertised at the encoder output rate',
        new RegExp(`icy-sr:\\s*${pipeline.encoder.sampleRate}\\r`, 'i').test(listener.headers),
    );
    check('icy-name advertised', /icy-name:\s*SmokeTest/i.test(listener.headers));
    check(
        'not chunked (ICY clients cannot parse chunk framing)',
        !/transfer-encoding/i.test(listener.headers),
    );

    await sleep(2000);
    const idleBytes = listener.audioBytes;
    check('stream flows with no source attached', idleBytes > 0, `${idleBytes} bytes of silence`);

    // --- attach a source; audio must continue without interruption ----------
    const before = listener.audioBytes;
    await pipeline.attach(new ToneSource(toneA, 'Tone A'));
    await sleep(3000);
    check('audio continues after attaching a source', listener.audioBytes > before);

    // --- the actual claim: swap sources, stream must not break --------------
    console.log('\nswapping source mid-stream (the critical case)...');
    const beforeSwap = listener.audioBytes;
    listener.maxGapMs = 0;

    await pipeline.attach(new ToneSource(toneB, 'Tone B'));
    await sleep(3000);

    check('listener still connected after source swap', !listener.closed && !listener.error);
    check('audio kept flowing across the swap', listener.audioBytes > beforeSwap);
    check(
        'no dropout during swap (<1s gap)',
        listener.maxGapMs < 1000,
        `largest gap ${listener.maxGapMs}ms`,
    );

    // --- metadata must reach the listener in-band ---------------------------
    check(
        'song titles delivered over ICY',
        listener.titles.some((t) => t.includes('Tone A')) &&
            listener.titles.some((t) => t.includes('Tone B')),
        `saw: ${[...new Set(listener.titles.filter(Boolean))].join(', ')}`,
    );

    // --- detaching entirely must still leave the mount up -------------------
    const beforeDetach = listener.audioBytes;
    await pipeline.detach();
    await sleep(1500);
    check('stream survives having no source at all', listener.audioBytes > beforeDetach);
    check('listener never disconnected', !listener.closed);

    // --- rate sanity: the measured rate must match the encoder's bitrate ----
    // A pacer bug would show up here as a stream running fast or slow, which on
    // the Wii means either a starved buffer or steadily growing latency.
    const totalMs = Date.now() - (listener.lastDataAt - listener.maxGapMs) || 1;
    const observed = listener.audioBytes;
    const elapsedSec = 9.5; // approximate total sleep above
    const kbps = (observed * 8) / elapsedSec / 1000;
    check(
        `bitrate close to ${pipeline.encoder.bitrate} kbps`,
        kbps > pipeline.encoder.bitrate * 0.78 && kbps < pipeline.encoder.bitrate * 1.29,
        `measured ~${kbps.toFixed(1)} kbps over ~${elapsedSec}s`,
    );

    // --- fast-source backpressure -------------------------------------------
    // A local file decodes far faster than real time. If backpressure is broken
    // the pacer overflows and drops the oldest audio, which sounds like the
    // track skipping forward.
    console.log('\nchecking fast-source backpressure...');
    let overflows = 0;
    pipeline.pacer.on('overflow', () => overflows++);
    await pipeline.attach(new ToneSource(toneA, 'Tone A again'));
    await sleep(4000);
    check('no pacer overflow with a fast local source', overflows === 0, `${overflows} overflows`);

    listener.socket.destroy();
    await pipeline.shutdown();
    server.close();

    if (warnings.length) {
        console.log(`\nwarnings emitted (${warnings.length}):`);
        for (const w of [...new Set(warnings)].slice(0, 10)) console.log(`  - ${w}`);
    }

    fs.rmSync(TMP, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('\nsmoke test crashed:', err);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
});
