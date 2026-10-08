// SPDX-License-Identifier: GPL-3.0-only
const { BYTES_PER_SECOND, SAMPLE_RATE } = require('./format');

// MP3 without a Xing gapless tag retains LAME's 576-sample encoder delay and
// the decoder's 529-sample synthesis delay. The stream clock includes both.
const MP3_DELAY_MS = 1105 * 1000 / SAMPLE_RATE;

class PlaybackTimeline {
    constructor() { this.reset(); }

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
        const time = encodedMs - MP3_DELAY_MS;
        const segment = this.segments.find((entry) => time >= entry.start && time < entry.end);
        if (!segment) return null;
        const position = segment.position + (segment.state === 'playing' ? (time - segment.start) / 1000 : 0);
        return { ...segment, position };
    }
}

module.exports = { PlaybackTimeline, MP3_DELAY_MS };
