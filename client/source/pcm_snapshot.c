// SPDX-License-Identifier: GPL-3.0-only
#include "pcm_snapshot.h"
#include <string.h>
#ifdef GEKKO
#include <ogc/mutex.h>
static mutex_t mutex;
#define LOCK() LWP_MutexLock(mutex)
#define UNLOCK() LWP_MutexUnlock(mutex)
#else
#include <pthread.h>
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
#define LOCK() pthread_mutex_lock(&mutex)
#define UNLOCK() pthread_mutex_unlock(&mutex)
#endif
static short samples[1024];
static int enabled, initialized;

int wj_pcm_init(void) {
#ifdef GEKKO
    if (LWP_MutexInit(&mutex, false) < 0) return -1;
#endif
    initialized = 1;
    return 0;
}

void wj_pcm_enable(int active) {
    if (!initialized) return;
    LOCK();
    enabled = active;
    memset(samples, 0, sizeof(samples));
    UNLOCK();
}

static short sample16(int32_t sample) {
    if (sample >= (1 << 28)) return 32767;
    if (sample <= -(1 << 28)) return -32768;
    return (short)(sample >> (28 - 15));
}

void wj_pcm_publish(const int32_t *left, const int32_t *right, unsigned frames) {
    if (!initialized) return;
    LOCK();
    if (enabled && frames) {
        unsigned length = frames < 512 ? frames : 512;
        unsigned start = frames - length;
        if (!right) right = left;
        memset(samples, 0, sizeof(samples));
        for (unsigned i = 0; i < length; i++) {
            samples[i * 2] = sample16(left[start + i]);
            samples[i * 2 + 1] = sample16(right[start + i]);
        }
    }
    UNLOCK();
}

void wj_pcm_snapshot(short output[1024]) {
    LOCK();
    memcpy(output, samples, sizeof(samples));
    UNLOCK();
}
