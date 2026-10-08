// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_TEST_NETWORK_H
#define WJ_TEST_NETWORK_H
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
/* Linux padding stands in for sin_len; wrappers translate the eight-byte ABI.
   This tests Wii code paths, not the IOS implementation or PowerPC ABI. */
#define sin_len sin_zero[0]
int net_socket(int, int, int);
int net_ioctl(int, unsigned long, void *);
int net_connect(int, const struct sockaddr *, socklen_t);
int net_bind(int, const struct sockaddr *, socklen_t);
int net_select(int, fd_set *, fd_set *, fd_set *, struct timeval *);
int net_setsockopt(int, int, int, const void *, socklen_t);
int net_send(int, const void *, int, int);
int net_recv(int, void *, int, int);
int net_sendto(int, const void *, int, int, const struct sockaddr *, socklen_t);
int net_recvfrom(int, void *, int, int, struct sockaddr *, socklen_t *);
int net_close(int);
#endif
