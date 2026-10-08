// SPDX-License-Identifier: GPL-3.0-only
#include "audio_buffer.h"
#include "net.h"
#include <assert.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

/* Every byte's value is a function of its absolute stream offset, so splices
   and gaps are visible in the data itself. */
static unsigned char pattern(long long offset) { return (unsigned char)(offset * 7 + offset / 251); }

struct plan { long long start, length; int epoch, pause_at, fail, hold_ms; };
struct writer { int fd; struct plan plan; };
static struct plan plans[8];
static struct writer writer_args[8];
static pthread_t writers[8];
static char queries[8][64];
static long long opened_at[8];
static int plan_count, opened;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void *write_stream(void *arg) {
    struct writer *writer = arg;
    unsigned char chunk[997];
    for (long long sent = 0; sent < writer->plan.length;) {
        long long left = writer->plan.length - sent;
        int n = left < (long long)sizeof(chunk) ? (int)left : (int)sizeof(chunk);
        for (int i = 0; i < n; i++) chunk[i] = pattern(writer->plan.start + sent + i);
        int wrote = (int)write(writer->fd, chunk, n);
        if (wrote <= 0) break;
        sent += wrote;
        if (writer->plan.pause_at && sent >= writer->plan.pause_at && sent - wrote < writer->plan.pause_at)
            usleep(300000);
    }
    if (writer->plan.hold_ms) usleep(writer->plan.hold_ms * 1000);
    close(writer->fd);
    return NULL;
}

static int open_fixture(const char *query, struct wj_stream_clock *clock) {
    pthread_mutex_lock(&lock);
    int index = opened < plan_count ? opened : -1;
    if (index >= 0) {
        snprintf(queries[index], sizeof(queries[index]), "%s", query);
        opened_at[index] = wj_milliseconds();
        opened++;
    }
    pthread_mutex_unlock(&lock);
    if (index < 0) return -1;
    struct plan plan = plans[index];
    if (plan.fail) return -1;
    int sockets[2];
    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, sockets));
    *clock = (struct wj_stream_clock){ .byte_start = plan.start, .epoch = plan.epoch, .bitrate = 256 };
    writer_args[index] = (struct writer){ sockets[1], plan };
    assert(!pthread_create(&writers[index], NULL, write_stream, &writer_args[index]));
    return sockets[0];
}

static void reset(const struct plan *list, int count) {
    pthread_mutex_lock(&lock);
    memset(queries, 0, sizeof(queries));
    memcpy(plans, list, sizeof(*list) * count);
    plan_count = count;
    opened = 0;
    pthread_mutex_unlock(&lock);
}

static void wait_opened(int count) {
    long long deadline = wj_milliseconds() + 8000;
    for (;;) {
        pthread_mutex_lock(&lock);
        int done = opened >= count;
        pthread_mutex_unlock(&lock);
        if (done) return;
        assert(wj_milliseconds() < deadline);
        usleep(1000);
    }
}

static void wait_buffered(int bytes) {
    long long deadline = wj_milliseconds() + 8000;
    while (wj_audio_state().buffered < bytes) { assert(wj_milliseconds() < deadline); usleep(1000); }
}

/* Read `total` bytes, checking each against its absolute stream offset. */
static void read_checked(long long *offset, long long total) {
    long long deadline = wj_milliseconds() + 8000;
    for (long long received = 0; received < total;) {
        assert(wj_milliseconds() < deadline);
        unsigned char bytes[3071];
        int want = total - received < (long long)sizeof(bytes) ? (int)(total - received) : (int)sizeof(bytes);
        int n = wj_audio_read(bytes, want);
        for (int i = 0; i < n; i++) assert(bytes[i] == pattern(*offset + i));
        *offset += n;
        received += n;
        if (!n) usleep(1000);
    }
}

static void finish(void) {
    long long start = wj_milliseconds();
    wj_audio_stop();
    assert(wj_milliseconds() - start < 500);
    for (int i = 0; i < opened; i++) if (!plans[i].fail) pthread_join(writers[i], NULL);
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    assert(wj_audio_bytes(1000, 256) == 32000);
    assert(wj_audio_bytes(WJ_AUDIO_RESYNC_MS, 320) < WJ_AUDIO_CAPACITY);

    /* Jitter and wraparound, then a reconnect the server can continue exactly:
       it repeats 1,000 already-buffered bytes, which must be skipped. */
    long long first = WJ_AUDIO_CAPACITY * 2LL + 123;
    struct plan resume[] = {
        { 1000000, first, 9, 9970, 0, 0 },
        { 1000000 + first - 1000, 50000, 9, 0, 0, 300 },
    };
    reset(resume, 2);
    assert(!wj_audio_start(open_fixture));
    wait_buffered(1);
    assert(wj_audio_state().stale);
    char probe;
    assert(wj_audio_read(&probe, 1) == 0);
    long long offset = wj_audio_begin_decode(0);
    assert(offset == 1000000);
    read_checked(&offset, first + 49000);
    char expected[64];
    snprintf(expected, sizeof(expected), "?v=2&epoch=9&from=%lld", 1000000 + first);
    assert(!strcmp(queries[0], "?v=2") && !strcmp(queries[1], expected));
    struct wj_audio_state state = wj_audio_state();
    assert(!state.stale && state.read_byte == 1000000 + first + 49000 && state.bitrate == 256);
    finish();

    /* After failed attempts with backoff, a gap or a new epoch cannot be
       spliced: the decoder sees end-of-stream until it begins a new run. */
    struct plan gap[] = {
        { 0, 40000, 3, 0, 0, 0 },
        { 0, 0, 0, 0, 1, 0 },
        { 0, 0, 0, 0, 1, 0 },
        { 90000, 30000, 3, 0, 0, 1500 },
        { 5000, 20000, 4, 0, 0, 1500 },
    };
    reset(gap, 5);
    assert(!wj_audio_start(open_fixture));
    wait_buffered(1);
    offset = wj_audio_begin_decode(0);
    assert(offset == 0);
    read_checked(&offset, 40000);
    wait_opened(4);
    assert(!strcmp(queries[1], "?v=2&epoch=3&from=40000") && !strcmp(queries[3], queries[1]));
    assert(opened_at[3] - opened_at[1] >= 700);
    wait_buffered(30000);
    assert(wj_audio_state().stale && wj_audio_state().failures == 0);
    assert(wj_audio_read_wait(&probe, 1, 1000) == 0);
    offset = wj_audio_begin_decode(0);
    assert(offset == 90000);
    read_checked(&offset, 30000);
    wait_opened(5);
    while (!wj_audio_state().stale) usleep(1000);
    wait_buffered(20000);
    offset = wj_audio_begin_decode(8000);
    assert(offset == 5000 + 12000);
    read_checked(&offset, 8000);
    assert(wj_audio_state().reconnects >= 2 && wj_audio_state().epoch == 4);
    finish();

    /* Resync abandons the backlog and reconnects without a resume query. */
    struct plan live[] = {
        { 0, 200000, 6, 1000, 0, 0 },
        { 700000, 10000, 6, 0, 0, 1000 },
    };
    reset(live, 2);
    assert(!wj_audio_start(open_fixture));
    wait_buffered(1000);
    wj_audio_begin_decode(0);
    wj_audio_resync();
    assert(wj_audio_state().stale && !wj_audio_state().buffered);
    wait_opened(2);
    while (wj_audio_state().read_byte != 700000) usleep(1000);
    assert(!strcmp(queries[1], "?v=2") && wj_audio_state().stale);
    offset = wj_audio_begin_decode(0);
    read_checked(&offset, 10000);
    finish();

    /* Jumps skip stale audio: within the buffer without reconnecting, beyond it
       by reconnecting at the exact byte. Stale bytes and other epochs are ignored. */
    struct plan jumps[] = {
        { 0, 300000, 5, 0, 0, 0 },
        { 500000, 30000, 5, 0, 0, 1000 },
    };
    reset(jumps, 2);
    assert(!wj_audio_start(open_fixture));
    wait_buffered(100000);
    offset = wj_audio_begin_decode(0);
    read_checked(&offset, 1000);
    assert(!wj_audio_jump(6, 50000) && !wj_audio_jump(5, 500) && !wj_audio_state().stale);
    assert(wj_audio_jump(5, 60000));
    assert(wj_audio_state().stale && wj_audio_read(&probe, 1) == 0);
    offset = wj_audio_begin_decode(0);
    assert(offset == 60000);
    read_checked(&offset, 20000);
    assert(wj_audio_jump(5, 500000));
    assert(!wj_audio_state().buffered);
    wait_opened(2);
    assert(!strcmp(queries[1], "?v=2&epoch=5&from=500000"));
    wait_buffered(30000);
    offset = wj_audio_begin_decode(0);
    assert(offset == 500000);
    read_checked(&offset, 30000);
    finish();
    puts("audio buffer passed: jitter, wraparound, exact resume, backoff, gaps, epochs, trimming, resync, jumps and bounded stop");
    return 0;
}
