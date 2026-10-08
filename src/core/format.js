// The one audio format everything in the pipeline speaks.
//
// Sources decode to this, the pacer meters it, the encoder consumes it. Keeping
// a single interchange format is what lets sources swap mid-stream without the
// encoder ever restarting -- it never sees a format change, so its MP3 output
// stays one unbroken stream from boot until shutdown.
//
// Server PCM uses 44.1 kHz stereo s16le. The encoder resamples it to the MP3
// output rate; 48 kHz matches ASND, so the Wii plays it without resampling.

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // s16le

// One "frame" is one sample across all channels; PCM writes must never split it.
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE; // 4
const BYTES_PER_SECOND = SAMPLE_RATE * FRAME_BYTES; // 176400

// Output defaults, not decoder limits: libmad accepts every MPEG-1 Layer III rate.
const MP3_BITRATE_KBPS = 256;
const MP3_SAMPLE_RATE = 48000;
const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_SAMPLE_RATES = [32000, 44100, 48000];

// LAME's 576-sample encoder delay plus the decoder's 529-sample synthesis delay,
// counted at the MP3 rate. The resampler's own delay is compensated by FFmpeg.
const MP3_DELAY_SAMPLES = 1105;

/** Validated MP3 output settings; unknown values fall back to the defaults. */
function mp3Output({ bitrate, sampleRate } = {}) {
    const rate = Number(bitrate);
    const samples = Number(sampleRate);
    return {
        bitrate: MP3_BITRATES.includes(rate) ? rate : MP3_BITRATE_KBPS,
        sampleRate: MP3_SAMPLE_RATES.includes(samples) ? samples : MP3_SAMPLE_RATE,
    };
}

// ffmpeg arguments describing the PCM interchange format, as an *input*.
const FFMPEG_PCM_INPUT = [
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
];

// ...and as an *output*, for source decoders feeding the pacer.
const FFMPEG_PCM_OUTPUT = [
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
];

/** Round a byte count down to a whole number of PCM frames. */
function alignToFrame(bytes) {
    return bytes - (bytes % FRAME_BYTES);
}

/** How many bytes of PCM represent the given duration. */
function bytesForMs(ms) {
    return alignToFrame(Math.round((BYTES_PER_SECOND * ms) / 1000));
}

module.exports = {
    SAMPLE_RATE,
    CHANNELS,
    BYTES_PER_SAMPLE,
    FRAME_BYTES,
    BYTES_PER_SECOND,
    MP3_BITRATE_KBPS,
    MP3_SAMPLE_RATE,
    MP3_BITRATES,
    MP3_SAMPLE_RATES,
    MP3_DELAY_SAMPLES,
    mp3Output,
    FFMPEG_PCM_INPUT,
    FFMPEG_PCM_OUTPUT,
    alignToFrame,
    bytesForMs,
};
