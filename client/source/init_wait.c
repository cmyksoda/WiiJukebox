// SPDX-License-Identifier: GPL-3.0-only
#include "init_wait.h"
#include <errno.h>

int wj_wait_for_network(const struct wj_init_ops *ops, int *deadline_expired) {
    *deadline_expired = 0;
    long long deadline = ops->now() + WJ_INIT_TIMEOUT_MS;
    int result = ops->start();
    while (result >= 0 || result == -EBUSY) {
        if (ops->cancelled()) return -ECANCELED;
        result = ops->status();
        if (result != -EBUSY) break;
        if (ops->now() >= deadline) {
            *deadline_expired = 1;
            return -ETIMEDOUT;
        }
        ops->sleep();
    }
    return result;
}
