// SPDX-License-Identifier: GPL-3.0-only
#include "wire.h"
#include "net.h"
#include "audio_buffer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed: %s\n", #x); return 1; } } while (0)
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
    int status = 0;
    struct wj_stream_clock clock;
    int fd = wj_open_audio(server, server->mount, &status, &clock);
    CHECK(fd >= 0 && status == 200);
    CHECK(clock.epoch > 0 && clock.byte_start >= 0 && clock.bitrate == 128);
    CHECK(wj_audio_start(fd) == 0);
    FILE *file = fopen(argv[2], "wb");
    CHECK(file);
    int received = 0;
    int target_bytes = !strcmp(source, "subsonic") ? 96000 : 48000;
    long long deadline = wj_milliseconds() + 12000;
    while (received < target_bytes) {
        CHECK(wj_milliseconds() < deadline);
        unsigned char audio[4096];
        int n = wj_audio_read(audio, sizeof(audio));
        if (!n) { CHECK(!wj_audio_state().ended); usleep(1000); continue; }
        CHECK(fwrite(audio, 1, n, file) == (size_t)n);
        received += n;
        CHECK(wj_request(server, "GET", "/api/wii/status", body, sizeof(body)) == 200);
    }
    fclose(file);
    wj_audio_stop();
    CHECK(wj_request(server, "POST", "/api/control/stop", body, sizeof(body)) == 200);
    puts("C client discovery, browsing, selection, status, MP3 stream and stop passed");
    return 0;
}
