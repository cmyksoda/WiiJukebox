// SPDX-License-Identifier: GPL-3.0-only
#include "network.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

static int result(int value) { return value < 0 ? -errno : value; }
static int inject(void) { return getenv("WJ_IOS_FAULTS") != NULL; }
int net_socket(int domain, int type, int protocol) { return result(socket(domain, type, protocol)); }
int net_ioctl(int fd, unsigned long request, void *arg) {
    assert(request == FIONBIO && *(int *)arg == 1);
    return result(ioctl(fd, request, arg));
}
int net_connect(int fd, const struct sockaddr *address, socklen_t size) {
    assert(size == 8 && (fcntl(fd, F_GETFL) & O_NONBLOCK));
    return result(connect(fd, address, sizeof(struct sockaddr_in)));
}
int net_bind(int fd, const struct sockaddr *address, socklen_t size) {
    assert(size == 8);
    return result(bind(fd, address, sizeof(struct sockaddr_in)));
}
int net_select(int nfds, fd_set *read, fd_set *write, fd_set *except, struct timeval *timeout) {
    static int calls;
    if (inject() && ++calls % 5 == 1) return -EINTR;
    return result(select(nfds, read, write, except, timeout));
}
int net_setsockopt(int fd, int level, int option, const void *value, socklen_t size) {
    return result(setsockopt(fd, level, option, value, size));
}
int net_send(int fd, const void *buffer, int size, int flags) {
    static int calls;
    if (inject()) {
        if (++calls % 4 == 1) return -EAGAIN;
        if (calls % 4 == 2) return -EINTR;
        if (size > 7) size = 7;
    }
    return result(send(fd, buffer, size, flags));
}
int net_recv(int fd, void *buffer, int size, int flags) {
    static int calls;
    assert(size <= 4096);
    if (inject()) {
        if (++calls % 3 == 1) return -EAGAIN;
        if (size > 17) size = 17;
    }
    return result(recv(fd, buffer, size, flags));
}
int net_sendto(int fd, const void *buffer, int size, int flags, const struct sockaddr *address, socklen_t length) {
    assert(length == 8);
    return result(sendto(fd, buffer, size, flags, address, sizeof(struct sockaddr_in)));
}
int net_recvfrom(int fd, void *buffer, int size, int flags, struct sockaddr *address, socklen_t *length) {
    return result(recvfrom(fd, buffer, size, flags, address, length));
}
int net_close(int fd) { return result(close(fd)); }
