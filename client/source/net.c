// SPDX-License-Identifier: GPL-3.0-only
#include "net.h"
#include "wire.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
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
    out->sin_port = htons((uint16_t)port);
    return inet_aton(ip, &out->sin_addr) && port > 0 && port <= 65535 ? 0 : -1;
}

void wj_close(int fd) { if (fd >= 0) net_close(fd); }

int wj_receive(int fd, void *buffer, int size, int timeout_ms) {
    if (ready(fd, 0, timeout_ms) <= 0) return -1;
    return net_recv(fd, buffer, size, 0);
}

int wj_open(const struct wj_server *server, const char *method, const char *path, int *status) {
    struct sockaddr_in addr;
    if (address(&addr, server->ip, server->port)) return -1;
    if (path[0] != '/' || strpbrk(path, "\r\n ")) return -1;
    int fd = net_socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (net_fcntl(fd, F_SETFL, O_NONBLOCK) < 0) goto fail;
    int result = net_connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    if (result < 0) {
        if (ready(fd, 1, 3000) <= 0) goto fail;
        int error = 0;
        socklen_t size = sizeof(error);
        if (net_getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) < 0 || error) goto fail;
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
    // Read exactly through the header delimiter so no MP3 bytes are lost.
    char headers[8192];
    int used = 0;
    while (used < (int)sizeof(headers) - 1) {
        int left = (int)(deadline - wj_milliseconds());
        if (wj_receive(fd, headers + used, 1, left) != 1) goto fail;
        used++;
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
    return fd;
fail:
    wj_close(fd);
    return -1;
}

int wj_request(const struct wj_server *server, const char *method, const char *path,
               char *body, size_t capacity) {
    int status = 0;
    int fd = wj_open(server, method, path, &status);
    if (fd < 0 || capacity < 2) { wj_close(fd); return -1; }
    size_t used = 0;
    long long deadline = wj_milliseconds() + 8000;
    for (;;) {
        if (used == capacity - 1) { status = -1; break; }
        int left = (int)(deadline - wj_milliseconds());
        int n = wj_receive(fd, body + used, (int)(capacity - 1 - used), left);
        if (n == 0) break;
        if (n < 0) { status = -1; break; }
        used += (size_t)n;
    }
    body[used] = 0;
    wj_close(fd);
    return status;
}

int wj_discover(struct wj_server *servers, int capacity, const char *target, int port) {
    struct sockaddr_in addr;
    if (address(&addr, target, port)) return -1;
    int fd = net_socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    int yes = 1;
    net_setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    char nonce[17], query[80];
    snprintf(nonce, sizeof(nonce), "%016llx", (unsigned long long)wj_milliseconds());
    int size = snprintf(query, sizeof(query), "WIIJUKEBOX_DISCOVER\t1\t%s\n", nonce);
    int count = 0;
    long long deadline = wj_milliseconds() + 1800;
    long long next_send = 0;
    while (wj_milliseconds() < deadline) {
        if (wj_milliseconds() >= next_send) {
            net_sendto(fd, query, size, 0, (struct sockaddr *)&addr, sizeof(addr));
            next_send = wj_milliseconds() + 500;
        }
        if (ready(fd, 0, 100) <= 0) continue;
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
