// SPDX-License-Identifier: GPL-3.0-only
#include "playback_clock.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

uint32_t wj_clock_test_ticks;

int main(void) {
    wj_clock_test_ticks = 100000;
    wj_mp3_clock_start(64000);
    assert(!wj_mp3_clock().ready);
    wj_mp3_clock_frame(123);
    wj_clock_test_ticks = 0;
    wj_mp3_clock_begin();
    wj_clock_test_ticks = 2048;
    assert(!wj_mp3_clock().ready && !wj_mp3_clock().milliseconds);
    wj_mp3_clock_submit(8192);
    wj_mp3_clock_submit(0);
    wj_mp3_clock_submit(8192);
    wj_clock_test_ticks = 4096;
    struct wj_playback_clock first = wj_mp3_clock();
    assert(first.ready && first.byte == 64123 && first.milliseconds == 42);
    wj_clock_test_ticks = 5120;
    assert(wj_mp3_clock().milliseconds == first.milliseconds);
    wj_clock_test_ticks = 6144;
    assert(wj_mp3_clock().milliseconds == first.milliseconds);
    wj_clock_test_ticks = 8192;
    assert(wj_mp3_clock().milliseconds == 85);
    wj_mp3_clock_start(128000);
    assert(!wj_mp3_clock().ready);
    wj_clock_test_ticks = 0;
    wj_mp3_clock_begin();
    wj_clock_test_ticks = UINT32_MAX - 100;
    long long before = wj_mp3_clock().milliseconds;
    wj_clock_test_ticks = 100;
    assert(wj_mp3_clock().milliseconds >= before);
    puts("playback clock: startup, MP3 offset, real ASND ticks, output silence, restart and wrap passed");
}
