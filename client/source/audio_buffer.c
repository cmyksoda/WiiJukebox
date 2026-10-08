// SPDX-License-Identifier: GPL-3.0-only
#include "audio_buffer.h"
#include <stdio.h>
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
static int read_pos, used, stopping, resync, connected, failures, reconnects;
static int bitrate = 128, epoch, active;
static unsigned generation, reader_generation;
/* Absolute stream position of read_pos; -1 until a server supplies one. */
static long long read_byte = -1;
static wj_audio_opener opener;

int wj_audio_bytes(int milliseconds, int kbps) {
    return (int)((long long)milliseconds * (kbps > 0 ? kbps : 128) / 8);
}

static int stopped(void) {
    LOCK();
    int stop = stopping;
    UNLOCK();
    return stop;
}

static int pause_unless_stopped(int milliseconds) {
    long long until = wj_milliseconds() + milliseconds;
    while (wj_milliseconds() < until) {
        if (stopped()) return 1;
        usleep(10000);
    }
    return stopped();
}

static int backoff(int count) {
    static const int delays[] = { 250, 500, 1000, 2000, 2000, 3000 };
    int last = (int)(sizeof(delays) / sizeof(delays[0])) - 1;
    return delays[count <= 0 ? 0 : count > last ? last : count - 1];
}

/* Returns how many leading bytes of the new connection repeat buffered audio. */
static long long attach(const struct wj_stream_clock *clock) {
    long long end = read_byte + used;
    long long skip = 0;
    if (read_byte >= 0 && clock->epoch == epoch && clock->byte_start >= 0 &&
        clock->byte_start <= end && end - clock->byte_start < WJ_AUDIO_CAPACITY * 4LL) {
        skip = end - clock->byte_start;
    } else {
        read_pos = used = 0;
        read_byte = clock->byte_start;
        generation++;
    }
    epoch = clock->byte_start >= 0 ? clock->epoch : 0;
    bitrate = clock->bitrate > 0 ? clock->bitrate : 128;
    connected = 1;
    return skip;
}

static void append(const unsigned char *data, int n) {
    int write_pos = (read_pos + used) % WJ_AUDIO_CAPACITY;
    int first = WJ_AUDIO_CAPACITY - write_pos;
    if (first > n) first = n;
    memcpy(bytes + write_pos, data, first);
    memcpy(bytes, data + first, n - first);
    used += n;
}

/* Reads until the connection ends, stalls or is replaced. Returns 1 if any
   audio arrived. */
static int receive(int fd, long long skip) {
    unsigned char chunk[4096];
    long long last_data = wj_milliseconds();
    int received = 0;
    for (;;) {
        LOCK();
        int stop = stopping || resync;
        int space = WJ_AUDIO_CAPACITY - used;
        UNLOCK();
        if (stop) break;
        if (!space && !skip) { usleep(5000); last_data = wj_milliseconds(); continue; }
        int want = skip ? (skip < (long long)sizeof(chunk) ? (int)skip : (int)sizeof(chunk))
                        : (space < (int)sizeof(chunk) ? space : (int)sizeof(chunk));
        int n = wj_receive(fd, chunk, want, 100);
        if (n == WJ_TIMEOUT && wj_milliseconds() - last_data < WJ_AUDIO_STALL_MS) continue;
        if (n <= 0) break;
        last_data = wj_milliseconds();
        if (!received) {
            received = 1;
            LOCK();
            failures = 0;
            UNLOCK();
        }
        if (skip) { skip -= n; continue; }
        LOCK();
        if (!resync) append(chunk, n);
        UNLOCK();
    }
    return received;
}

static void *run(void *unused) {
    (void)unused;
    int delay = 0;
    while (!pause_unless_stopped(delay)) {
        char query[64] = "";
        LOCK();
        if (resync) { resync = 0; epoch = 0; }
        if (epoch > 0 && read_byte >= 0)
            snprintf(query, sizeof(query), "?epoch=%d&from=%lld", epoch, read_byte + used);
        UNLOCK();
        struct wj_stream_clock clock = { .byte_start = -1, .bitrate = 128 };
        int fd = opener(query, &clock);
        if (fd < 0) {
            LOCK();
            delay = backoff(++failures);
            UNLOCK();
            continue;
        }
        LOCK();
        long long skip = attach(&clock);
        UNLOCK();
        int received = receive(fd, skip);
        wj_close(fd);
        LOCK();
        connected = 0;
        if (!stopping) reconnects++;
        delay = received ? 100 : backoff(++failures);
        UNLOCK();
    }
    return NULL;
}

int wj_audio_start(wj_audio_opener open) {
    if (active || !open) return -1;
#ifdef GEKKO
    static int initialized;
    if (!initialized) {
        if (LWP_MutexInit(&mutex, false) < 0) return -1;
        initialized = 1;
    }
#endif
    LOCK();
    read_pos = used = stopping = resync = connected = failures = reconnects = epoch = 0;
    read_byte = -1;
    bitrate = 128;
    reader_generation = ++generation;
    opener = open;
    UNLOCK();
#ifdef GEKKO
    int result = LWP_CreateThread(&thread, run, NULL, NULL, 32768, 70);
#else
    int result = pthread_create(&thread, NULL, run, NULL);
#endif
    if (result != 0) return -1;
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
    LOCK();
    read_pos = used = 0;
    UNLOCK();
    active = 0;
}

void wj_audio_resync(void) {
    LOCK();
    resync = 1;
    read_pos = used = 0;
    generation++;
    UNLOCK();
}

int wj_audio_read(void *buffer, int size) {
    if (size <= 0) return 0;
    LOCK();
    int n = stopping || reader_generation != generation ? 0 : (used < size ? used : size);
    int first = WJ_AUDIO_CAPACITY - read_pos;
    if (first > n) first = n;
    memcpy(buffer, bytes + read_pos, first);
    memcpy((unsigned char *)buffer + first, bytes, n - first);
    read_pos = (read_pos + n) % WJ_AUDIO_CAPACITY;
    used -= n;
    if (read_byte >= 0) read_byte += n;
    UNLOCK();
    return n;
}

int wj_audio_read_wait(void *buffer, int size, int wait_ms) {
    long long deadline = wj_milliseconds() + wait_ms;
    for (;;) {
        int n = wj_audio_read(buffer, size);
        if (n || size <= 0) return n;
        LOCK();
        int done = stopping || reader_generation != generation;
        UNLOCK();
        if (done || wj_milliseconds() >= deadline) return 0;
        usleep(2000);
    }
}

long long wj_audio_begin_decode(int keep_bytes) {
    LOCK();
    reader_generation = generation;
    if (keep_bytes > 0 && used > keep_bytes) {
        int drop = used - keep_bytes;
        read_pos = (read_pos + drop) % WJ_AUDIO_CAPACITY;
        used -= drop;
        if (read_byte >= 0) read_byte += drop;
    }
    long long byte = read_byte;
    UNLOCK();
    return byte;
}

struct wj_audio_state wj_audio_state(void) {
    LOCK();
    struct wj_audio_state state = { used, connected, failures, reconnects, bitrate, epoch,
                                    reader_generation != generation, read_byte };
    UNLOCK();
    return state;
}
