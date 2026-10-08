// SPDX-License-Identifier: GPL-3.0-only
#include "progress.h"
#include <stdio.h>
#include <string.h>

void wj_progress(char *text, size_t size, int elapsed_ms, int duration_ms) {
    if (elapsed_ms < 0) elapsed_ms = 0;
    if (duration_ms > 0 && elapsed_ms > duration_ms) elapsed_ms = duration_ms;
    int elapsed = elapsed_ms / 1000;
    if (duration_ms <= 0) {
        snprintf(text, size, "%d:%02d  [       duration unknown       ]  --:--", elapsed / 60, elapsed % 60);
        return;
    }
    char bar[31];
    int filled = (long long)elapsed_ms * 30 / duration_ms;
    memset(bar, ' ', 30);
    memset(bar, '|', filled);
    bar[30] = 0;
    int duration = duration_ms / 1000;
    snprintf(text, size, "%d:%02d  [%s]  %d:%02d", elapsed / 60, elapsed % 60,
             bar, duration / 60, duration % 60);
}
