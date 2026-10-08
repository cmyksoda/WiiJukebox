// SPDX-License-Identifier: GPL-3.0-only
#include "audio_buffer.h"
#include "net.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

#define TOTAL (WJ_AUDIO_CAPACITY * 4 + 123)

static void *send_audio(void *arg) {
    int fd = *(int *)arg;
    unsigned char chunk[997];
    for (int sent = 0; sent < TOTAL;) {
        int n = TOTAL - sent;
        if (n > (int)sizeof(chunk)) n = sizeof(chunk);
        for (int i = 0; i < n; i++) chunk[i] = (unsigned char)(sent + i);
        int wrote = (int)write(fd, chunk, n);
        assert(wrote > 0);
        sent += wrote;
        if (sent == 9970) usleep(1200000);
    }
    close(fd);
    return NULL;
}

int main(void) {
    int sockets[2];
    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, sockets));
    assert(!wj_audio_start(sockets[0]));
    pthread_t writer;
    assert(!pthread_create(&writer, NULL, send_audio, &sockets[1]));
    usleep(150000);
    int received = 0, gaps = 0;
    long long deadline = wj_milliseconds() + 5000;
    while (received < TOTAL) {
        assert(wj_milliseconds() < deadline);
        unsigned char bytes[3071];
        int n = wj_audio_read(bytes, sizeof(bytes));
        for (int i = 0; i < n; i++) assert(bytes[i] == (unsigned char)(received + i));
        received += n;
        if (!n) gaps++;
        usleep(2000);
    }
    assert(gaps > 0);
    assert(wj_audio_state().consumed == TOTAL);
    pthread_join(writer, NULL);
    wj_audio_stop();

    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, sockets));
    assert(!wj_audio_start(sockets[0]));
    usleep(10000);
    unsigned char sample;
    long long wait_start = wj_milliseconds();
    assert(wj_audio_read_wait(&sample, 1, 50) == 0);
    assert(wj_milliseconds() - wait_start >= 50 && wj_milliseconds() - wait_start < 200);
    assert(write(sockets[1], "x", 1) == 1);
    assert(wj_audio_read_wait(&sample, 1, 100) == 1 && sample == 'x');
    long long start = wj_milliseconds();
    wj_audio_stop();
    assert(wj_milliseconds() - start < 500);
    close(sockets[1]);
    puts("audio buffer passed: jitter, byte order, wraparound, restart and bounded stop");
    return 0;
}
