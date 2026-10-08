// SPDX-License-Identifier: GPL-3.0-only
const { BYTES_PER_SECOND, MP3_DELAY_SAMPLES, MP3_SAMPLE_RATE } = require('./format');

// MP3 without a Xing gapless tag retains the codec delay; the stream clock includes it.
const mp3DelayMs = (sampleRate) => MP3_DELAY_SAMPLES * 1000 / sampleRate;

class PlaybackTimeline {
    constructor({ sampleRate = MP3_SAMPLE_RATE } = {}) {
        this.delayMs = mp3DelayMs(sampleRate);
        this.reset();
    }

    reset() {
        this.time = 0;
        this.segments = [];
    }

    write(bytes, { generation, position, state, metadata }) {
        const duration = bytes * 1000 / BYTES_PER_SECOND;
        const previous = this.segments.at(-1);
        if (previous && previous.generation === generation && previous.state === state &&
            previous.metadata.title === metadata.title && previous.metadata.artist === metadata.artist) {
            previous.end += duration;
        } else {
            this.segments.push({ start: this.time, end: this.time + duration,
                generation, position, state, metadata: { ...metadata } });
        }
        this.time += duration;
        while (this.segments.length > 1 &&
            (this.segments[1].start < this.time - 120000 || this.segments.length > 6000)) this.segments.shift();
    }

    at(encodedMs) {
        const time = encodedMs - this.delayMs;
        const segment = this.segments.find((entry) => time >= entry.start && time < entry.end);
        if (!segment) return null;
        const position = segment.position + (segment.state === 'playing' ? (time - segment.start) / 1000 : 0);
        return { ...segment, position };
    }
}

module.exports = { PlaybackTimeline, mp3DelayMs };
