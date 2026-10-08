// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_NET_H
#define WJ_NET_H
#include <stddef.h>
#define WJ_SERVERS 8
struct wj_server { char ip[16], id[37], name[128], mount[256]; int port; };
long long wj_milliseconds(void);
int wj_discover(struct wj_server *servers, int capacity, const char *target, int port);
int wj_lookup(struct wj_server *server, const char *endpoint);
int wj_open(const struct wj_server *server, const char *method, const char *path, int *status);
int wj_receive(int fd, void *buffer, int size, int timeout_ms);
void wj_close(int fd);
int wj_request(const struct wj_server *server, const char *method, const char *path,
               char *body, size_t capacity);
#endif
