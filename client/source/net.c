// SPDX-License-Identifier: GPL-3.0-only
#include "net.h"
#include "wire.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/time.h>
#ifdef GEKKO
#include <network.h>
#include <ogc/lwp_watchdog.h>
#else
#include <unistd.h>
#include <time.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <sys/select.h>
#define net_socket socket
#define net_bind bind
#define net_connect connect
#define net_fcntl fcntl
#define net_select select
#define net_getsockopt getsockopt
#define net_setsockopt setsockopt
#define net_send send
#define net_recv recv
#define net_sendto sendto
#define net_recvfrom recvfrom
#define net_close close
#endif

/* IOS uses the eight-byte IPv4 address, without BSD's sin_zero padding. */
#ifdef GEKKO
#define ADDRESS_SIZE 8
#else
#define ADDRESS_SIZE sizeof(struct sockaddr_in)
#endif

long long wj_milliseconds(void) {
#ifdef GEKKO
    return ticks_to_millisecs(gettime());
#else
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC, &time);
    return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
#endif
}

static int socket_result(int result) {
#ifdef GEKKO
    return result;
#else
    return result < 0 ? -errno : result;
#endif
}

static int transient(int result) {
    return result == -EAGAIN || result == -EWOULDBLOCK || result == -EINTR;
}

static int ready(int fd, int writing, int timeout_ms) {
    if (fd < 0 || fd >= FD_SETSIZE) return -EINVAL;
    long long deadline = wj_milliseconds() + timeout_ms;
    for (;;) {
        long long left = deadline - wj_milliseconds();
        if (left <= 0) return WJ_TIMEOUT;
        fd_set set;
        FD_ZERO(&set);
        FD_SET(fd, &set);
        struct timeval timeout = { left / 1000, (left % 1000) * 1000 };
        int result = socket_result(net_select(fd + 1, writing ? NULL : &set,
                                             writing ? &set : NULL, NULL, &timeout));
        if (!result) return WJ_TIMEOUT;
        if (!transient(result)) return result;
    }
}

const char *wj_http_stage_name(enum wj_http_stage stage) {
    static const char *names[] = { "socket", "connect", "send", "headers", "body", "done" };
    return stage >= WJ_HTTP_SOCKET && stage <= WJ_HTTP_DONE ? names[stage] : "unknown";
}

static int address(struct sockaddr_in *out, const char *ip, int port) {
    memset(out, 0, sizeof(*out));
    out->sin_family = AF_INET;
#ifdef GEKKO
    out->sin_len = ADDRESS_SIZE;
#endif
    out->sin_port = htons((uint16_t)port);
    return inet_aton(ip, &out->sin_addr) && port > 0 && port <= 65535 ? 0 : -1;
}

void wj_close(int fd) { if (fd >= 0) net_close(fd); }

static int receive_flags(int fd, void *buffer, int size, int timeout_ms, int flags) {
    /* libogc shares a 64 KiB network heap between sockets. Keep each read
       small enough that audio and a browse response can coexist. */
    if (size > 4096) size = 4096;
    long long deadline = wj_milliseconds() + timeout_ms;
    for (;;) {
        int result = ready(fd, 0, (int)(deadline - wj_milliseconds()));
        if (result < 0) return result;
        result = socket_result(net_recv(fd, buffer, size, flags));
        if (!transient(result)) return result;
        if (wj_milliseconds() >= deadline) return WJ_TIMEOUT;
    }
}

int wj_receive(int fd, void *buffer, int size, int timeout_ms) {
    return receive_flags(fd, buffer, size, timeout_ms, 0);
}

static int open_http(const struct wj_server *server, const char *method, const char *path,
                     int *status, int *content_length, struct wj_http_trace *trace, struct wj_stream_clock *clock) {
    struct sockaddr_in addr;
    trace->stage = WJ_HTTP_SOCKET;
    int error = -EINVAL;
    if (address(&addr, server->ip, server->port) || path[0] != '/' ||
        strpbrk(path, "\r\n ")) { trace->error = error; return error; }
    int fd = socket_result(net_socket(AF_INET, SOCK_STREAM, 0));
    if (fd < 0) { trace->error = fd; return fd; }
#ifdef GEKKO
    /* net_fcntl expects IOS flags, not newlib's O_NONBLOCK value. */
    int nonblocking = 1;
    error = socket_result(net_ioctl(fd, FIONBIO, &nonblocking));
#else
    error = socket_result(net_fcntl(fd, F_SETFL, O_NONBLOCK));
#endif
    if (error < 0) goto fail;
    trace->stage = WJ_HTTP_CONNECT;
    error = socket_result(net_connect(fd, (struct sockaddr *)&addr, ADDRESS_SIZE));
    if (error < 0) {
        if (error != -EINPROGRESS && error != -EALREADY && !transient(error)) goto fail;
        error = ready(fd, 1, 3000);
        if (error < 0) goto fail;
        /* libogc's net_getsockopt is unimplemented. On Wii, the first send
           verifies the connection after the bounded writable wait. */
#ifndef GEKKO
        int pending = 0;
        socklen_t size = sizeof(pending);
        error = socket_result(net_getsockopt(fd, SOL_SOCKET, SO_ERROR, &pending, &size));
        if (error < 0) goto fail;
        if (pending) { error = -pending; goto fail; }
#endif
    }
    trace->stage = WJ_HTTP_SEND;
    char request[2048];
    int length = snprintf(request, sizeof(request),
        "%s %s HTTP/1.0\r\nHost: %s:%d\r\nUser-Agent: WiiJukebox/0.1\r\n"
        "Connection: close\r\nContent-Length: 0\r\n\r\n",
        method, path, server->ip, server->port);
    if (length < 0 || length >= (int)sizeof(request)) { error = WJ_TOO_LARGE; goto fail; }
    long long deadline = wj_milliseconds() + 8000;
    for (int sent = 0; sent < length;) {
        error = ready(fd, 1, (int)(deadline - wj_milliseconds()));
        if (error < 0) goto fail;
        error = socket_result(net_send(fd, request + sent, length - sent, 0));
        if (transient(error)) continue;
        if (error <= 0) { if (!error) error = WJ_TRUNCATED; goto fail; }
        sent += error;
    }
    trace->stage = WJ_HTTP_HEADERS;
    // Peek in blocks, then consume only through the header delimiter. This
    // preserves the first MP3 bytes without hundreds of one-byte IOS calls.
    char headers[8192];
    int used = 0;
    while (used < (int)sizeof(headers) - 1) {
        int left = (int)(deadline - wj_milliseconds());
        int n = receive_flags(fd, headers + used, sizeof(headers) - 1 - used, left, MSG_PEEK);
        if (n <= 0) { error = n ? n : WJ_TRUNCATED; goto fail; }
        headers[used + n] = 0;
        char *end = strstr(headers, "\r\n\r\n");
        int take = end ? (int)(end + 4 - headers) - used : n;
        int consumed = wj_receive(fd, headers + used, take, left);
        if (consumed <= 0) { error = consumed ? consumed : WJ_TRUNCATED; goto fail; }
        used += consumed;
        if (used >= 4 && !memcmp(headers + used - 4, "\r\n\r\n", 4)) break;
    }
    headers[used] = 0;
    error = WJ_PROTOCOL;
    if (used < 4 || memcmp(headers + used - 4, "\r\n\r\n", 4)) goto fail;
    if (sscanf(headers, "HTTP/%*d.%*d %d", status) != 1) goto fail;
    trace->status = *status;
    // Our server sends close-delimited MP3 and Content-Length text, never chunks.
    for (int i = 0; i < used; i++) {
        if (headers[i] >= 'A' && headers[i] <= 'Z') headers[i] += 'a' - 'A';
    }
    if (strstr(headers, "\r\ntransfer-encoding:") || strstr(headers, "\r\nicy-metaint:")) goto fail;
    if (clock) {
        *clock = (struct wj_stream_clock){ .byte_start = -1, .bitrate = 128 };
        const char *names[] = { "\r\nx-wiijukebox-byte-start:", "\r\nx-wiijukebox-epoch:", "\r\nicy-br:" };
        for (int i = 0; i < 3; i++) {
            const char *header = strstr(headers, names[i]);
            if (!header) continue;
            const char *value = header + strlen(names[i]);
            char *end;
            errno = 0;
            long long parsed = strtoll(value, &end, 10);
            if (errno || end == value || parsed < 0 || strncmp(end, "\r\n", 2)) goto fail;
            if (i == 0) clock->byte_start = parsed;
            else if (i == 1 && parsed > 0 && parsed <= 2147483647) clock->epoch = (int)parsed;
            else if (i == 2 && parsed > 0 && parsed <= 320) clock->bitrate = (int)parsed;
            else goto fail;
        }
    }
    if (content_length) {
        *content_length = -1;
        char *length_header = strstr(headers, "\r\ncontent-length:");
        if (length_header) {
            char *end;
            const char *value = length_header + strlen("\r\ncontent-length:");
            errno = 0;
            long length = strtol(value, &end, 10);
            if (errno || end == value || length < 0 || strncmp(end, "\r\n", 2)) goto fail;
            if (length >= WJ_BODY) { error = WJ_TOO_LARGE; goto fail; }
            *content_length = (int)length;
            trace->expected = (int)length;
        }
    }
    return fd;
fail:
    trace->error = error;
    wj_close(fd);
    return error;
}

int wj_open(const struct wj_server *server, const char *method, const char *path, int *status) {
    struct wj_http_trace trace = { .expected = -1 };
    return open_http(server, method, path, status, NULL, &trace, NULL);
}

int wj_open_audio(const struct wj_server *server, const char *path, int *status, struct wj_stream_clock *clock) {
    struct wj_http_trace trace = { .expected = -1 };
    return open_http(server, "GET", path, status, NULL, &trace, clock);
}

int wj_request(const struct wj_server *server, const char *method, const char *path,
               char *body, size_t capacity) {
    struct wj_http_trace trace;
    return wj_request_traced(server, method, path, body, capacity, &trace);
}

int wj_request_traced(const struct wj_server *server, const char *method, const char *path,
                      char *body, size_t capacity, struct wj_http_trace *trace) {
    *trace = (struct wj_http_trace){ .expected = -1 };
    long long started = wj_milliseconds();
    if (capacity) body[0] = 0;
    if (capacity < 2) { trace->error = -EINVAL; return trace->error; }
    int status = 0, length = -1;
    int fd = open_http(server, method, path, &status, &length, trace, NULL);
    if (fd < 0) goto done;
    trace->stage = WJ_HTTP_BODY;
    if (length >= 0 && (size_t)length >= capacity) { trace->error = WJ_TOO_LARGE; goto done; }
    size_t used = 0;
    long long deadline = wj_milliseconds() + 8000;
    for (;;) {
        if (length >= 0 && used == (size_t)length) break;
        if (used == capacity - 1) { trace->error = WJ_TOO_LARGE; break; }
        int left = (int)(deadline - wj_milliseconds());
        int want = length >= 0 ? length - (int)used : (int)(capacity - 1 - used);
        int n = wj_receive(fd, body + used, want, left);
        if (n == 0) {
            if (length >= 0 && used != (size_t)length) trace->error = WJ_TRUNCATED;
            break;
        }
        if (n < 0) { trace->error = n; break; }
        used += (size_t)n;
    }
    body[used] = 0;
    trace->received = (int)used;
    if (!trace->error) trace->stage = WJ_HTTP_DONE;
done:
    wj_close(fd);
    trace->elapsed_ms = wj_milliseconds() - started;
    return trace->error ? trace->error : status;
}

int wj_lookup(struct wj_server *server, const char *endpoint) {
    char ip[16], extra;
    int port;
    if (sscanf(endpoint, "%15[0-9.]:%d%c", ip, &port, &extra) != 2) return -1;
    struct sockaddr_in addr;
    if (address(&addr, ip, port)) return -1;
    struct wj_server found = {0};
    snprintf(found.ip, sizeof(found.ip), "%s", ip);
    found.port = port;
    char body[2048];
    if (wj_request(&found, "GET", "/api/wii/info", body, sizeof(body)) != 200) return -1;
    struct wj_document doc;
    if (wj_document(body, &doc) || doc.count != 1) return -1;
    struct wj_row *row = &doc.rows[0];
    if (row->count != 4 || strcmp(row->field[0], "server") ||
        strlen(row->field[1]) != 36 || strspn(row->field[1], "0123456789abcdef-") != 36 ||
        row->field[3][0] != '/' || strlen(row->field[3]) >= sizeof(found.mount) ||
        strpbrk(row->field[3], "\r\n ")) return -1;
    snprintf(found.id, sizeof(found.id), "%s", row->field[1]);
    snprintf(found.name, sizeof(found.name), "%.127s", row->field[2]);
    snprintf(found.mount, sizeof(found.mount), "%s", row->field[3]);
    *server = found;
    return 0;
}

int wj_discover(struct wj_server *servers, int capacity, const char *target, int port) {
    struct sockaddr_in addr;
    if (address(&addr, target, port)) return -1;
    int fd = net_socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in local;
    memset(&local, 0, sizeof(local));
    local.sin_family = AF_INET;
    int result = net_bind(fd, (struct sockaddr *)&local, ADDRESS_SIZE);
    if (result < 0) { wj_close(fd); return result; }
    int yes = 1;
    result = net_setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    if (result < 0) { wj_close(fd); return result; }
    char nonce[17], query[80];
    snprintf(nonce, sizeof(nonce), "%016llx", (unsigned long long)wj_milliseconds());
    int size = snprintf(query, sizeof(query), "WIIJUKEBOX_DISCOVER\t1\t%s\n", nonce);
    int count = 0;
    long long deadline = wj_milliseconds() + 1800;
    long long next_send = 0;
    while (wj_milliseconds() < deadline) {
        if (wj_milliseconds() >= next_send) {
            result = net_sendto(fd, query, size, 0, (struct sockaddr *)&addr, ADDRESS_SIZE);
            if (result < 0) { wj_close(fd); return result; }
            next_send = wj_milliseconds() + 500;
        }
        result = ready(fd, 0, 100);
        if (result == WJ_TIMEOUT) continue;
        if (result < 0) { wj_close(fd); return result; }
        char response[2048];
        struct sockaddr_in remote;
        socklen_t remote_size = sizeof(remote);
        int n = net_recvfrom(fd, response, sizeof(response) - 1, 0,
                             (struct sockaddr *)&remote, &remote_size);
        if (n <= 0 || response[n - 1] != '\n') continue;
        response[n - 1] = 0;
        struct wj_row row;
        if (wj_fields(response, &row) || row.count != 7) continue;
        if (strcmp(row.field[0], "WIIJUKEBOX") || strcmp(row.field[1], "1") ||
            strcmp(row.field[2], nonce) || strlen(row.field[3]) != 36 ||
            strspn(row.field[3], "0123456789abcdef-") != 36) continue;
        int http_port;
        if (wj_number(row.field[4], 1, 65535, &http_port)) continue;
        if (strlen(row.field[6]) >= sizeof(servers[0].mount) || row.field[6][0] != '/' ||
            strpbrk(row.field[6], "\r\n ")) continue;
        int duplicate = 0;
        for (int i = 0; i < count; i++) if (!strcmp(servers[i].id, row.field[3])) duplicate = 1;
        if (duplicate || count >= capacity) continue;
        struct wj_server *server = &servers[count++];
        snprintf(server->ip, sizeof(server->ip), "%s", inet_ntoa(remote.sin_addr));
        snprintf(server->id, sizeof(server->id), "%s", row.field[3]);
        snprintf(server->name, sizeof(server->name), "%.127s", row.field[5]);
        snprintf(server->mount, sizeof(server->mount), "%s", row.field[6]);
        server->port = http_port;
    }
    wj_close(fd);
    return count;
}
