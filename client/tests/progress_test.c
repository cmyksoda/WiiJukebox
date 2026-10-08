// SPDX-License-Identifier: GPL-3.0-only
#include "progress.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char text[73];
    wj_progress(text, sizeof(text), 83000, 166000);
    assert(!strcmp(text, "1:23  [|||||||||||||||               ]  2:46"));
    wj_progress(text, sizeof(text), -100, 166000);
    assert(!strcmp(text, "0:00  [                              ]  2:46"));
    wj_progress(text, sizeof(text), INT_MAX, 166000);
    assert(!strcmp(text, "2:46  [||||||||||||||||||||||||||||||]  2:46"));
    wj_progress(text, sizeof(text), 65000, 0);
    assert(strstr(text, "1:05") && strstr(text, "--:--"));
    wj_progress(text, sizeof(text), INT_MAX, INT_MAX);
    assert(strlen(text) < 72 && strstr(text, "||||||||||||||||||||||||||||||"));
    char tiny[2];
    wj_progress(tiny, sizeof(tiny), 0, 1000);
    assert(tiny[1] == 0);
    puts("progress: elapsed, duration, bounds, unknown duration and truncation passed");
}
