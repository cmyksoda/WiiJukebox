// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_PROGRESS_H
#define WJ_PROGRESS_H
#include <stddef.h>
void wj_progress(char *text, size_t size, int elapsed_ms, int duration_ms);
#endif
