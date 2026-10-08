// SPDX-License-Identifier: GPL-3.0-only
// Records what the decoder would read, through reconnects, as "<first byte>\n" + bytes.
#include "audio_buffer.h"
#include "net.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed: %s\n", #x); return 1; } } while (0)

static struct wj_server server;

static int open_proxy(const char *query, struct wj_stream_clock *clock) {
    char path[320];
    snprintf(path, sizeof(path), "%s%s", server.mount, query);
    int status = 0;
    int fd = wj_open_audio(&server, path, &status, clock);
    if (fd >= 0 && status != 200) { wj_close(fd); return -1; }
    return fd;
}

int main(int argc, char **argv) {
    CHECK(argc == 4);
    snprintf(server.ip, sizeof(server.ip), "127.0.0.1");
    snprintf(server.mount, sizeof(server.mount), "/stream");
    server.port = atoi(argv[1]);
    int total = atoi(argv[3]);
    FILE *file = fopen(argv[2], "wb");
    CHECK(file && total > 0);
    CHECK(wj_audio_start(open_proxy) == 0);
    long long deadline = wj_milliseconds() + 20000;
    while (!wj_audio_state().buffered) { CHECK(wj_milliseconds() < deadline); usleep(1000); }
    long long first = wj_audio_begin_decode(0);
    fprintf(file, "%lld\n", first);
    for (int received = 0; received < total;) {
        CHECK(wj_milliseconds() < deadline);
        CHECK(!wj_audio_state().stale);
        unsigned char audio[4096];
        int n = wj_audio_read(audio, total - received < 4096 ? total - received : 4096);
        if (!n) { usleep(2000); continue; }
        CHECK(fwrite(audio, 1, n, file) == (size_t)n);
        received += n;
    }
    struct wj_audio_state state = wj_audio_state();
    fclose(file);
    wj_audio_stop();
    printf("reconnects=%d\n", state.reconnects);
    return 0;
}
