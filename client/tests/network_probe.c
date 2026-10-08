// SPDX-License-Identifier: GPL-3.0-only
#include "wire.h"
#include "net.h"
#include "audio_buffer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed: %s\n", #x); return 1; } } while (0)

static const struct wj_server *probe_server;
static struct wj_stream_clock first_clock;
static int opens;

static int open_probe(const char *query, struct wj_stream_clock *clock) {
    char path[320];
    snprintf(path, sizeof(path), "%s%s", probe_server->mount, query);
    int status = 0;
    int fd = wj_open_audio(probe_server, path, &status, clock);
    if (fd >= 0 && status != 200) { wj_close(fd); return -1; }
    if (fd >= 0 && !opens++) first_clock = *clock;
    return fd;
}
int main(int argc, char **argv) {
    CHECK(argc == 3 || argc == 4);
    const char *source = argc == 4 ? argv[3] : "radio";
    struct wj_server servers[WJ_SERVERS];
    int count = wj_discover(servers, WJ_SERVERS, "127.0.0.1", atoi(argv[1]));
    CHECK(count == 1);
    struct wj_server *server = &servers[0];
    char endpoint[40];
    snprintf(endpoint, sizeof(endpoint), "%s:%d", server->ip, server->port);
    struct wj_server direct;
    CHECK(wj_lookup(&direct, "127.0.0.1:0") < 0);
    CHECK(wj_lookup(&direct, "127.0.0.1:4280/path") < 0);
    CHECK(wj_lookup(&direct, endpoint) == 0);
    CHECK(!strcmp(direct.id, server->id) && !strcmp(direct.mount, server->mount));
    char body[WJ_BODY];
    struct wj_document doc;
    CHECK(wj_request(server, "GET", "/api/wii/info", body, sizeof(body)) == 200);
    CHECK(!wj_document(body, &doc));
    CHECK(!strcmp(doc.rows[0].field[1], server->id));
    CHECK(wj_request(server, "GET", "/api/wii/sources", body, sizeof(body)) == 200);
    CHECK(!wj_document(body, &doc));
    CHECK(doc.count >= 2);
    char path[256];
    snprintf(path, sizeof(path), "/api/wii/browse?source=%s", source);
    CHECK(wj_request(server, "GET", path, body, sizeof(body)) == 200);
    CHECK(!wj_document(body, &doc));
    if (!strcmp(source, "subsonic")) {
        const char *albums = NULL;
        for (int i = 1; i < doc.count; i++) {
            if (doc.rows[i].count >= 4 && !strcmp(doc.rows[i].field[3], "Albums")) albums = doc.rows[i].field[1];
        }
        CHECK(albums);
        snprintf(path, sizeof(path), "/api/wii/browse?source=subsonic&ref=%s", albums);
        CHECK(wj_request(server, "GET", path, body, sizeof(body)) == 200);
        CHECK(!wj_document(body, &doc));
        CHECK(doc.count >= 2 && !strcmp(doc.rows[1].field[2], "album"));
        snprintf(path, sizeof(path), "/api/wii/browse?source=subsonic&ref=%s", doc.rows[1].field[1]);
        CHECK(wj_request(server, "GET", path, body, sizeof(body)) == 200);
        CHECK(!wj_document(body, &doc));
        CHECK(doc.count == 13 && !strcmp(doc.rows[1].field[2], "track"));
    }
    CHECK(doc.count >= 2);
    snprintf(path, sizeof(path), "/api/wii/play?source=%s&ref=%s", source, doc.rows[1].field[1]);
    CHECK(wj_request(server, "POST", path, body, sizeof(body)) == 200);
    int playing = 0;
    for (int attempt = 0; attempt < 30; attempt++) {
        CHECK(wj_request(server, "GET", "/api/wii/status", body, sizeof(body)) == 200);
        CHECK(!wj_document(body, &doc));
        if (!strcmp(doc.rows[0].field[3], "playing") && doc.rows[0].field[1][0]) { playing = 1; break; }
        usleep(100000);
    }
    CHECK(playing);
    CHECK(!strcmp(doc.rows[0].field[1], !strcmp(source, "subsonic") ? "Tone 01" : "Fixture station"));
    probe_server = server;
    CHECK(wj_audio_start(open_probe) == 0);
    FILE *file = fopen(argv[2], "wb");
    CHECK(file);
    int received = 0;
    // The 4-second burst at 256 kbps precedes the selection; read past it.
    int target_bytes = !strcmp(source, "subsonic") ? 256000 : 192000;
    static unsigned char saved[256000];
    long long first = -1;
    long long deadline = wj_milliseconds() + 12000;
    while (received < target_bytes) {
        CHECK(wj_milliseconds() < deadline);
        if (first < 0) {
            if (!wj_audio_state().buffered) { usleep(1000); continue; }
            first = wj_audio_begin_decode(0);
        }
        unsigned char audio[4096];
        int n = wj_audio_read(audio, target_bytes - received < 4096 ? target_bytes - received : 4096);
        if (!n) { usleep(1000); continue; }
        CHECK(fwrite(audio, 1, n, file) == (size_t)n);
        memcpy(saved + received, audio, n);
        received += n;
        CHECK(wj_request(server, "GET", "/api/wii/status", body, sizeof(body)) == 200);
    }
    fclose(file);
    CHECK(opens == 1 && first_clock.epoch > 0 && first_clock.byte_start == first && first_clock.bitrate == 256);
    // A reconnect within the same epoch continues at the exact byte requested.
    int status = 0;
    struct wj_stream_clock resumed;
    char resume[320];
    snprintf(resume, sizeof(resume), "%s?epoch=%d&from=%lld", server->mount, first_clock.epoch, first + 1000);
    int fd = wj_open_audio(server, resume, &status, &resumed);
    CHECK(fd >= 0 && status == 200 && resumed.byte_start == first + 1000 && resumed.epoch == first_clock.epoch);
    for (int checked = 0; checked < 4000;) {
        unsigned char audio[4000];
        int n = wj_receive(fd, audio, 4000 - checked, 3000);
        CHECK(n > 0 && !memcmp(audio, saved + 1000 + checked, n));
        checked += n;
    }
    wj_close(fd);
    wj_audio_stop();
    CHECK(wj_request(server, "POST", "/api/control/stop", body, sizeof(body)) == 200);
    puts("C client discovery, browsing, selection, status, MP3 stream, exact resume and stop passed");
    return 0;
}
