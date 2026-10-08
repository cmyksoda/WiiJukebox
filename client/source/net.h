// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_NET_H
#define WJ_NET_H
#include <stddef.h>
#define WJ_SERVERS 8
#define WJ_TIMEOUT (-10000)
#define WJ_PROTOCOL (-10001)
#define WJ_TOO_LARGE (-10002)
#define WJ_TRUNCATED (-10003)
enum wj_http_stage { WJ_HTTP_SOCKET, WJ_HTTP_CONNECT, WJ_HTTP_SEND,
                     WJ_HTTP_HEADERS, WJ_HTTP_BODY, WJ_HTTP_DONE };
struct wj_http_trace {
    enum wj_http_stage stage;
    int error, status, received, expected;
    long long elapsed_ms;
};
const char *wj_http_stage_name(enum wj_http_stage stage);
struct wj_server { char ip[16], id[37], name[128], mount[256]; int port; };
long long wj_milliseconds(void);
int wj_discover(struct wj_server *servers, int capacity, const char *target, int port);
int wj_lookup(struct wj_server *server, const char *endpoint);
int wj_open(const struct wj_server *server, const char *method, const char *path, int *status);
int wj_receive(int fd, void *buffer, int size, int timeout_ms);
void wj_close(int fd);
int wj_request(const struct wj_server *server, const char *method, const char *path,
               char *body, size_t capacity);
int wj_request_traced(const struct wj_server *server, const char *method, const char *path,
                      char *body, size_t capacity, struct wj_http_trace *trace);
#endif
