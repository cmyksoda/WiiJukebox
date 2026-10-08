// SPDX-License-Identifier: GPL-3.0-only
// Plays the stream out at real time the way the Wii does (prebuffer, restart on
// stale audio, underruns) and logs "<wall ms> <stream byte>" as it plays.
// In "fast" mode it announces v=2 and follows jump markers from status.
#include "audio_buffer.h"
#include "net.h"
#include "wire.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed: %s\n", #x); return 1; } } while (0)

static struct wj_server server;
static int fast, done;

static long long wall_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int open_stream(const char *query, struct wj_stream_clock *clock) {
    char path[320];
    // Without v=2 the server treats this like an older client and never bursts.
    const char *resume = strstr(query, "epoch=");
    if (fast) snprintf(path, sizeof(path), "%s%s", server.mount, query);
    else snprintf(path, sizeof(path), "%s%s%s", server.mount, resume ? "?" : "", resume ? resume : "");
    int status = 0;
    int fd = wj_open_audio(&server, path, &status, clock);
    if (fd >= 0 && status != 200) { wj_close(fd); return -1; }
    return fd;
}

static void *poll_status(void *unused) {
    (void)unused;
    static char body[WJ_BODY];
    int seen = -1;
    while (!done) {
        if (wj_request(&server, "GET", "/api/wii/status", body, sizeof(body)) == 200) {
            struct wj_document doc;
            int found = 0;
            if (!wj_document(body, &doc)) {
                for (int i = 0; i < doc.count; i++) {
                    struct wj_row *row = &doc.rows[i];
                    if (row->count != 4 || strcmp(row->field[0], "jump")) continue;
                    int id = atoi(row->field[1]);
                    found = 1;
                    if (seen >= 0 && id != seen && fast) wj_audio_jump(atoi(row->field[2]), strtoll(row->field[3], NULL, 10));
                    seen = id;
                }
            }
            if (seen < 0 && !found) seen = 0;
        }
        usleep(250000);
    }
    return NULL;
}

int main(int argc, char **argv) {
    CHECK(argc == 5);
    snprintf(server.ip, sizeof(server.ip), "127.0.0.1");
    snprintf(server.mount, sizeof(server.mount), "/stream");
    server.port = atoi(argv[1]);
    fast = !strcmp(argv[2], "fast");
    FILE *log = fopen(argv[3], "w");
    long long until = wall_ms() + atoll(argv[4]);
    CHECK(log);
    CHECK(wj_audio_start(open_stream) == 0);
    pthread_t poller;
    CHECK(!pthread_create(&poller, NULL, poll_status, NULL));
    int playing = 0, restarts = 0;
    long long cursor = 0, started = 0, consumed = 0, last_log = 0;
    while (wall_ms() < until) {
        struct wj_audio_state state = wj_audio_state();
        int rate = state.bitrate * 125;
        if (playing && state.stale) playing = 0;
        if (!playing) {
            if (state.buffered >= wj_audio_bytes(WJ_AUDIO_PREBUFFER_MS, state.bitrate)) {
                int target = wj_audio_bytes(WJ_AUDIO_TARGET_MS, state.bitrate);
                cursor = wj_audio_begin_decode(state.buffered > target * 3 / 2 ? target : 0);
                started = wall_ms();
                consumed = 0;
                playing = 1;
                restarts++;
            }
        } else {
            long long due = (wall_ms() - started) * rate / 1000 - consumed;
            static unsigned char sink[65536];
            while (due > 0) {
                int n = wj_audio_read(sink, due < (long long)sizeof(sink) ? (int)due : (int)sizeof(sink));
                if (n <= 0) { playing = 0; break; }
                due -= n;
                consumed += n;
                cursor += n;
            }
        }
        if (playing && wall_ms() - last_log >= 10) {
            last_log = wall_ms();
            fprintf(log, "%lld %lld\n", last_log, cursor);
        }
        usleep(2000);
    }
    done = 1;
    pthread_join(poller, NULL);
    wj_audio_stop();
    fclose(log);
    printf("seek probe finished: decoder starts %d\n", restarts);
    return 0;
}
