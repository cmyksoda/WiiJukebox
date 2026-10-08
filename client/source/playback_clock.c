// SPDX-License-Identifier: GPL-3.0-only
#include "playback_clock.h"
#include <stdint.h>
#ifdef GEKKO
#include <asndlib.h>
#include <ogc/machine/processor.h>
#define PLAYBACK_TICKS() ASND_GetTickCounterVoice(0)
#else
extern uint32_t wj_clock_test_ticks;
#define PLAYBACK_TICKS() wj_clock_test_ticks
#define _CPU_ISR_Disable(level) ((level) = 0)
#define _CPU_ISR_Restore(level) ((void)(level))
#endif

/* WiiJukebox: correlate the first decoded frame with ASND's playback clock. */
static long long clock_byte;
static int clock_ready;
static uint32_t clock_last_ticks;
static unsigned long long clock_ticks;
static unsigned long long clock_submitted, clock_silence;
static struct { unsigned long long start, end; } clock_padding[32];
static unsigned clock_head, clock_count;

void wj_mp3_clock_submit(int bytes)
{
	if(bytes < 8192 && clock_count < 32) {
		unsigned slot = (clock_head + clock_count++) % 32;
		clock_padding[slot].start = clock_submitted + bytes / 4;
		clock_padding[slot].end = clock_submitted + 2048;
	}
	clock_submitted += 2048;
}

void wj_mp3_clock_start(long long byte)
{
	uint32_t level;
	_CPU_ISR_Disable(level);
	clock_byte = byte;
	clock_ready = 0;
	clock_last_ticks = 0;
	clock_ticks = 0;
	clock_submitted = 2048;
	clock_silence = 0;
	clock_head = clock_count = 0;
	_CPU_ISR_Restore(level);
}

struct wj_playback_clock wj_mp3_clock(void)
{
	uint32_t level;
	_CPU_ISR_Disable(level);
	if(clock_ready) {
		uint32_t ticks = PLAYBACK_TICKS();
		clock_ticks += (uint32_t)(ticks - clock_last_ticks);
		clock_last_ticks = ticks;
	}
	/* The 44.1 kHz MP3 synth frame becomes 1254 output frames in the
	   existing fixed-point resampler; ASND counts at 48 kHz. */
	while(clock_count && clock_padding[clock_head].end <= clock_ticks) {
		clock_silence += clock_padding[clock_head].end - clock_padding[clock_head].start;
		clock_head = (clock_head + 1) % 32;
		clock_count--;
	}
	unsigned long long silence = clock_silence;
	if(clock_count && clock_ticks > clock_padding[clock_head].start)
		silence += clock_ticks - clock_padding[clock_head].start;
	long long played = clock_ticks > 2048 + silence ? (clock_ticks - 2048 - silence) * 1152 * 1000 / (1254 * 44100) : 0;
	struct wj_playback_clock result = { clock_byte, played, clock_ready && clock_ticks > 2048 };
	_CPU_ISR_Restore(level);
	return result;
}

void wj_mp3_clock_frame(long long offset) {
    uint32_t level;
    _CPU_ISR_Disable(level);
    clock_byte += offset;
    _CPU_ISR_Restore(level);
}

void wj_mp3_clock_begin(void) { clock_ready = 1; }
