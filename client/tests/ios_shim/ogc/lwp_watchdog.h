// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_TEST_WATCHDOG_H
#define WJ_TEST_WATCHDOG_H
#include <stdint.h>
#include <time.h>
static inline uint64_t gettime(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}
#define ticks_to_millisecs(ticks) ((ticks) / 1000000)
#endif
