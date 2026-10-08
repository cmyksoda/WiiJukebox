// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_INIT_WAIT_H
#define WJ_INIT_WAIT_H
#define WJ_INIT_TIMEOUT_MS 30000
/* libogc's IP polling alone can take ten seconds after earlier startup work. */
struct wj_init_ops {
    int (*start)(void);
    int (*status)(void);
    int (*cancelled)(void);
    long long (*now)(void);
    void (*sleep)(void);
};
int wj_wait_for_network(const struct wj_init_ops *ops, int *deadline_expired);
#endif
