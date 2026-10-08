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
#else
#include <unistd.h>
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
    struct timeval time;
    gettimeofday(&time, NULL);
    return (long long)time.tv_sec * 1000 + time.tv_usec / 1000;
}

static int ready(int fd, int writing, int timeout_ms) {
    if (fd < 0 || fd >= FD_SETSIZE || timeout_ms < 0) return -1;
    fd_set set;
    FD_ZERO(&set);
    FD_SET(fd, &set);
    struct timeval timeout = { timeout_ms / 1000, (timeout_ms % 1000) * 1000 };
    return net_select(fd + 1, writing ? NULL : &set, writing ? &set : NULL, NULL, &timeout);
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
        if (!result) return WJ_TIMEOUT;
        if (result < 0) return -1;
        result = net_recv(fd, buffer, size, flags);
#ifdef GEKKO
        int again = result == -EAGAIN || result == -EWOULDBLOCK;
#else
        int again = result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR);
#endif
        if (!again) return result;
        if (wj_milliseconds() >= deadline) return WJ_TIMEOUT;
    }
}

int wj_receive(int fd, void *buffer, int size, int timeout_ms) {
    return receive_flags(fd, buffer, size, timeout_ms, 0);
}

static int open_http(const struct wj_server *server, const char *method, const char *path,
                     int *status, int *content_length) {
    struct sockaddr_in addr;
    if (address(&addr, server->ip, server->port)) return -1;
    if (path[0] != '/' || strpbrk(path, "\r\n ")) return -1;
    int fd = net_socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
#ifdef GEKKO
    /* net_fcntl expects IOS flags, not newlib's O_NONBLOCK value. */
    int nonblocking = 1;
    if (net_ioctl(fd, FIONBIO, &nonblocking) < 0) goto fail;
#else
    if (net_fcntl(fd, F_SETFL, O_NONBLOCK) < 0) goto fail;
#endif
    int result = net_connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    if (result < 0) {
        if (ready(fd, 1, 3000) <= 0) goto fail;
        /* libogc's net_getsockopt is unimplemented. On Wii, the first send
           verifies the connection after the bounded writable wait. */
#ifndef GEKKO
        int error = 0;
        socklen_t size = sizeof(error);
        if (net_getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) < 0 || error) goto fail;
#endif
    }
    char request[2048];
    int length = snprintf(request, sizeof(request),
        "%s %s HTTP/1.0\r\nHost: %s:%d\r\nUser-Agent: WiiJukebox/0.1\r\n"
        "Connection: close\r\nContent-Length: 0\r\n\r\n",
        method, path, server->ip, server->port);
    if (length < 0 || length >= (int)sizeof(request)) goto fail;
    long long deadline = wj_milliseconds() + 8000;
    for (int sent = 0; sent < length;) {
        int left = (int)(deadline - wj_milliseconds());
        if (ready(fd, 1, left) <= 0) goto fail;
        int n = net_send(fd, request + sent, length - sent, 0);
        if (n <= 0) goto fail;
        sent += n;
    }
    // Peek in blocks, then consume only through the header delimiter. This
    // preserves the first MP3 bytes without hundreds of one-byte IOS calls.
    char headers[8192];
    int used = 0;
    while (used < (int)sizeof(headers) - 1) {
        int left = (int)(deadline - wj_milliseconds());
        int n = receive_flags(fd, headers + used, sizeof(headers) - 1 - used, left, MSG_PEEK);
        if (n <= 0) goto fail;
        headers[used + n] = 0;
        char *end = strstr(headers, "\r\n\r\n");
        int take = end ? (int)(end + 4 - headers) - used : n;
        int consumed = wj_receive(fd, headers + used, take, left);
        if (consumed <= 0) goto fail;
        used += consumed;
        if (used >= 4 && !memcmp(headers + used - 4, "\r\n\r\n", 4)) break;
    }
    headers[used] = 0;
    if (used < 4 || memcmp(headers + used - 4, "\r\n\r\n", 4)) goto fail;
    if (sscanf(headers, "HTTP/%*d.%*d %d", status) != 1) goto fail;
    // Our server sends close-delimited MP3 and Content-Length text, never chunks.
    for (int i = 0; i < used; i++) {
        if (headers[i] >= 'A' && headers[i] <= 'Z') headers[i] += 'a' - 'A';
    }
    if (strstr(headers, "\r\ntransfer-encoding:") || strstr(headers, "\r\nicy-metaint:")) goto fail;
    if (content_length) {
        *content_length = -1;
        char *length_header = strstr(headers, "\r\ncontent-length:");
        if (length_header) {
            char *end;
            const char *value = length_header + strlen("\r\ncontent-length:");
            long length = strtol(value, &end, 10);
            if (end == value || length < 0 || length >= WJ_BODY || strncmp(end, "\r\n", 2)) goto fail;
            *content_length = (int)length;
        }
    }
    return fd;
fail:
    wj_close(fd);
    return -1;
}

int wj_open(const struct wj_server *server, const char *method, const char *path, int *status) {
    return open_http(server, method, path, status, NULL);
}

int wj_request(const struct wj_server *server, const char *method, const char *path,
               char *body, size_t capacity) {
    int status = 0;
    int length = -1;
    int fd = open_http(server, method, path, &status, &length);
    if (fd < 0 || capacity < 2) { wj_close(fd); return -1; }
    if (length >= 0 && (size_t)length >= capacity) { wj_close(fd); return -1; }
    size_t used = 0;
    long long deadline = wj_milliseconds() + 8000;
    for (;;) {
        if (length >= 0 && used == (size_t)length) break;
        if (used == capacity - 1) { status = -1; break; }
        int left = (int)(deadline - wj_milliseconds());
        int want = length >= 0 ? length - (int)used : (int)(capacity - 1 - used);
        int n = wj_receive(fd, body + used, want, left);
        if (n == 0) { if (length >= 0 && used != (size_t)length) status = -1; break; }
        if (n < 0) { status = -1; break; }
        used += (size_t)n;
    }
    body[used] = 0;
    wj_close(fd);
    return status;
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
        if (result < 0) { wj_close(fd); return result; }
        if (!result) continue;
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
