// SPDX-License-Identifier: GPL-3.0-only
#include "init_wait.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>

static long long clock_ms, ready_ms, cancel_ms;
static int start_result, final_result, starts, polls;
static int start(void) { starts++; return start_result; }
static int status(void) { polls++; return clock_ms >= ready_ms ? final_result : -EBUSY; }
static int cancelled(void) { return cancel_ms >= 0 && clock_ms >= cancel_ms; }
static long long now(void) { return clock_ms; }
static void nap(void) { clock_ms += 20; }
static const struct wj_init_ops ops = { start, status, cancelled, now, nap };
static void setup(long long ready, long long cancel, int initial, int final) {
    clock_ms = starts = polls = 0;
    ready_ms = ready; cancel_ms = cancel;
    start_result = initial; final_result = final;
}
int main(void) {
    int deadline;
    setup(12500, -1, 0, 0);
    assert(!wj_wait_for_network(&ops, &deadline));
    assert(clock_ms == 12500 && starts == 1 && !deadline);
    setup(12000, -1, -EBUSY, -ETIMEDOUT);
    assert(wj_wait_for_network(&ops, &deadline) == -ETIMEDOUT && !deadline);
    setup(60000, -1, 0, 0);
    assert(wj_wait_for_network(&ops, &deadline) == -ETIMEDOUT && deadline);
    assert(clock_ms == WJ_INIT_TIMEOUT_MS);
    setup(60000, 140, 0, 0);
    assert(wj_wait_for_network(&ops, &deadline) == -ECANCELED && clock_ms == 140 && !deadline);
    setup(0, -1, -ENETDOWN, 0);
    assert(wj_wait_for_network(&ops, &deadline) == -ENETDOWN && !polls);
    setup(0, -1, 0, 0);
    assert(!wj_wait_for_network(&ops, &deadline) && !clock_ms && starts == 1);
    puts("init wait: late success, IOS failure, app deadline, cancellation and retry passed");
}
