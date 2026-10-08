// The one audio format everything in the pipeline speaks.
//
// Sources decode to this, the pacer meters it, the encoder consumes it. Keeping
// a single interchange format is what lets sources swap mid-stream without the
// encoder ever restarting -- it never sees a format change, so its MP3 output
// stays one unbroken stream from boot until shutdown.
//
// Server PCM uses 44.1 kHz stereo s16le. The native client subsequently
// resamples decoded audio to 48 kHz stereo for ASND.

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // s16le

// One "frame" is one sample across all channels; PCM writes must never split it.
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE; // 4
const BYTES_PER_SECOND = SAMPLE_RATE * FRAME_BYTES; // 176400

// Default output rate, not a decoder limit.
const MP3_BITRATE_KBPS = 128;

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
    FFMPEG_PCM_INPUT,
    FFMPEG_PCM_OUTPUT,
    alignToFrame,
    bytesForMs,
};
