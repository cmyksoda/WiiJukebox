// SPDX-License-Identifier: GPL-3.0-only
#include "pcm_snapshot.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    assert(!wj_pcm_init());
    int32_t left[1152] = {0}, right[1152] = {0};
    short output[1024];
    left[640] = (1 << 28);
    right[640] = -(1 << 28);
    left[1151] = (1 << 28) / 2;
    right[1151] = -(1 << 28) / 2;
    wj_pcm_publish(left, right, 1152);
    wj_pcm_snapshot(output);
    for (int i = 0; i < 1024; i++) assert(!output[i]);
    wj_pcm_enable(1);
    wj_pcm_publish(left, right, 1152);
    wj_pcm_snapshot(output);
    assert(output[0] == 32767 && output[1] == -32768);
    assert(output[1022] == 16384 && output[1023] == -16384);
    left[0] = (1 << 28) / 4;
    wj_pcm_publish(left, NULL, 1); wj_pcm_snapshot(output);
    assert(output[0] == 8192 && output[1] == 8192);
    for (int i = 2; i < 1024; i++) assert(!output[i]);
    wj_pcm_enable(0); wj_pcm_snapshot(output);
    for (int i = 0; i < 1024; i++) assert(!output[i]);
    puts("PCM snapshot: clipping, stereo, mono, short frame, enable and disable passed");
}
