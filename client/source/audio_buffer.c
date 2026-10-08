// SPDX-License-Identifier: GPL-3.0-only
#include "audio_buffer.h"
#include "net.h"
#include <string.h>
#include <unistd.h>
#ifdef GEKKO
#include <ogc/lwp.h>
#include <ogc/mutex.h>
static mutex_t mutex;
static lwp_t thread;
#define LOCK() LWP_MutexLock(mutex)
#define UNLOCK() LWP_MutexUnlock(mutex)
#else
#include <pthread.h>
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_t thread;
#define LOCK() pthread_mutex_lock(&mutex)
#define UNLOCK() pthread_mutex_unlock(&mutex)
#endif

static unsigned char bytes[WJ_AUDIO_CAPACITY];
static int read_pos, used, stopping, ended, failed;
static int socket_fd = -1, active;
static long long consumed;

static void *receive_audio(void *unused) {
    (void)unused;
    unsigned char chunk[4096];
    long long last_data = wj_milliseconds();
    for (;;) {
        LOCK();
        int stop = stopping;
        int space = WJ_AUDIO_CAPACITY - used;
        UNLOCK();
        if (stop) break;
        if (!space) { usleep(5000); last_data = wj_milliseconds(); continue; }
        int want = space < (int)sizeof(chunk) ? space : (int)sizeof(chunk);
        int n = wj_receive(socket_fd, chunk, want, 100);
        if (n == WJ_TIMEOUT && wj_milliseconds() - last_data < 8000) continue;
        if (n <= 0) {
            LOCK();
            ended = 1;
            failed = n < 0;
            UNLOCK();
            break;
        }
        last_data = wj_milliseconds();
        LOCK();
        int write_pos = (read_pos + used) % WJ_AUDIO_CAPACITY;
        int first = WJ_AUDIO_CAPACITY - write_pos;
        if (first > n) first = n;
        memcpy(bytes + write_pos, chunk, first);
        memcpy(bytes, chunk + first, n - first);
        used += n;
        UNLOCK();
    }
    return NULL;
}

int wj_audio_start(int fd) {
    if (active || fd < 0) return -1;
#ifdef GEKKO
    static int initialized;
    if (!initialized) {
        if (LWP_MutexInit(&mutex, false) < 0) return -1;
        initialized = 1;
    }
#endif
    LOCK();
    read_pos = used = stopping = ended = failed = 0;
    consumed = 0;
    socket_fd = fd;
    UNLOCK();
#ifdef GEKKO
    int result = LWP_CreateThread(&thread, receive_audio, NULL, NULL, 16384, 70);
#else
    int result = pthread_create(&thread, NULL, receive_audio, NULL);
#endif
    if (result != 0) { socket_fd = -1; return -1; }
    active = 1;
    return 0;
}

void wj_audio_stop(void) {
    if (!active) return;
    LOCK();
    stopping = 1;
    UNLOCK();
#ifdef GEKKO
    LWP_JoinThread(thread, NULL);
#else
    pthread_join(thread, NULL);
#endif
    wj_close(socket_fd);
    socket_fd = -1;
    active = 0;
}

int wj_audio_read(void *buffer, int size) {
    if (size <= 0) return 0;
    LOCK();
    int n = stopping ? 0 : (used < size ? used : size);
    int first = WJ_AUDIO_CAPACITY - read_pos;
    if (first > n) first = n;
    memcpy(buffer, bytes + read_pos, first);
    memcpy((unsigned char *)buffer + first, bytes, n - first);
    read_pos = (read_pos + n) % WJ_AUDIO_CAPACITY;
    used -= n;
    consumed += n;
    UNLOCK();
    return n;
}

int wj_audio_read_wait(void *buffer, int size, int wait_ms) {
    long long deadline = wj_milliseconds() + wait_ms;
    for (;;) {
        int n = wj_audio_read(buffer, size);
        if (n || size <= 0) return n;
        LOCK();
        int done = stopping || ended;
        UNLOCK();
        if (done || wj_milliseconds() >= deadline) return 0;
        usleep(2000);
    }
}

struct wj_audio_state wj_audio_state(void) {
    LOCK();
    struct wj_audio_state state = { used, ended, failed, consumed };
    UNLOCK();
    return state;
}
