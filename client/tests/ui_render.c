// SPDX-License-Identifier: GPL-3.0-only
// Renders the real UI code through the software GX stand-in, for layout checks
// and reconstructed screenshots. Not an emulator or hardware capture.
#include "gfx.h"
#include "font.h"
#include "ui.h"
#include "gx_soft.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long long clock_ms = 100000;
long long wj_milliseconds(void) { return clock_ms; }
static unsigned char art[WJ_ART_SIZE * WJ_ART_SIZE * 2];
const unsigned char *wj_session_art(void) { return art; }

/* Album-art stand-in: a dusk gradient with a sun, tiled like the server's output. */
static void paint_art(void) {
    for (int y = 0; y < WJ_ART_SIZE; y++)
        for (int x = 0; x < WJ_ART_SIZE; x++) {
            float t = y / (float)WJ_ART_SIZE, dx = x - 84.0f, dy = y - 52.0f;
            float r = 0.98f - 0.5f * t, g = 0.55f - 0.35f * t, b = 0.45f + 0.3f * t;
            if (dx * dx + dy * dy < 22 * 22) { r = 1; g = 0.86f; b = 0.55f; }
            if (y > 92 + 6 * sinf(x / 9.0f)) { r *= 0.3f; g *= 0.3f; b *= 0.45f; }
            unsigned v = (unsigned)(r * 31) << 11 | (unsigned)(g * 63) << 5 | (unsigned)(b * 31);
            unsigned char *p = art + ((y / 4) * (WJ_ART_SIZE / 4) + x / 4) * 32 + ((y % 4) * 4 + x % 4) * 2;
            p[0] = (unsigned char)(v >> 8);
            p[1] = (unsigned char)v;
        }
}

static void item(struct wj_session *s, const char *ref, const char *type, const char *title, const char *subtitle) {
    struct wj_item *it = &s->menu.items[s->count++];
    snprintf(it->ref, sizeof(it->ref), "%s", ref);
    snprintf(it->type, sizeof(it->type), "%s", type);
    snprintf(it->title, sizeof(it->title), "%s", title);
    snprintf(it->subtitle, sizeof(it->subtitle), "%s", subtitle);
    s->menu.count = s->count;
}

static void save(const char *directory, const char *name) {
    static unsigned char rgb[640 * 480 * 3];
    gx_soft_frame(rgb);
    if (!directory) return;
    char path[512];
    snprintf(path, sizeof(path), "%s/%s.ppm", directory, name);
    FILE *file = fopen(path, "wb");
    assert(file);
    fprintf(file, "P6\n640 480\n255\n");
    fwrite(rgb, 1, sizeof(rgb), file);
    fclose(file);
}

static void pixel(int x, int y, unsigned char out[3]) {
    static unsigned char rgb[640 * 480 * 3];
    gx_soft_frame(rgb);
    memcpy(out, rgb + (y * 640 + x) * 3, 3);
}

static void playing(struct wj_session *s) {
    snprintf(s->song, sizeof(s->song), "%s", "Dusk on the Promenade");
    snprintf(s->artist, sizeof(s->artist), "%s", "The Lantern Choir");
    snprintf(s->state, sizeof(s->state), "%s", "playing");
    s->capabilities = WJ_CAN_PAUSE | WJ_CAN_STOP | WJ_CAN_NEXT | WJ_CAN_PREVIOUS | WJ_CAN_SEEK;
    s->position_ms = 83000;
    s->duration_ms = 241000;
    s->has_progress = 1;
    s->has_art = 1;
    s->art_version = 1;
    s->audio_running = s->stream_started = 1;
    s->audio = (struct wj_audio_state){ .buffered = 128000, .connected = 1, .bitrate = 256, .epoch = 7 };
    snprintf(s->server_name, sizeof(s->server_name), "%s", "Living room PC");
}

static void draw(struct wj_session *s, struct wj_pointer *pointer, int frames) {
    for (int i = 0; i < frames; i++) {
        clock_ms += 16;
        wj_ui_draw(s, pointer);
    }
}

static long load(const char *path, unsigned char *data, long capacity) {
    FILE *file = fopen(path, "rb");
    assert(file);
    long size = (long)fread(data, 1, (size_t)capacity, file);
    fclose(file);
    return size;
}

int main(int argc, char **argv) {
    assert(argc >= 3);
    const char *out = argc > 3 ? argv[3] : NULL;
    static unsigned char latin[1024 * 1024], cjk[2 * 1024 * 1024];
    long latin_size = load(argv[1], latin, sizeof(latin)), cjk_size = load(argv[2], cjk, sizeof(cjk));
    paint_art();
    for (int wide = 0; wide < 2; wide++) {
        gx_soft_set_aspect(wide);
        assert(!wj_gfx_init());
        wj_font_shutdown();
        assert(!wj_font_init(latin, latin_size, cjk, cjk_size, wj_gfx_scale_x(), wj_gfx_scale_y()));
        wj_ui_init();
        struct wj_pointer none = { 0, 0, 0 };

        struct wj_session s;
        memset(&s, 0, sizeof(s));
        s.view = WJ_VIEW_SERVERS;
        s.discovering = 1;
        s.attempt = 2;
        s.discovery_started = clock_ms - 7000;
        s.phase = "Searching";
        snprintf(s.network, sizeof(s.network), "Wii 192.168.0.8");
        snprintf(s.state, sizeof(s.state), "idle");
        draw(&s, &none, 1);
        if (!wide) save(out, "1-finding-server");
        unsigned char c[3];
        pixel(4, 70, c);
        assert(c[0] > 200 && c[1] > 200 && c[2] > 200);

        s.discovering = 0;
        item(&s, "server", "server", "Living room PC", "ID 3f2a9c1e");
        item(&s, "server", "server", "Studio laptop", "ID 77b01d42");
        draw(&s, &none, 1);
        if (!wide) save(out, "2-choose-server");

        memset(&s.menu, 0, sizeof(s.menu));
        s.count = 0;
        s.view = WJ_VIEW_SOURCES;
        snprintf(s.title, sizeof(s.title), "Music sources");
        item(&s, "radio", "source", "Internet Radio", "");
        item(&s, "podcasts", "source", "Podcasts", "");
        item(&s, "subsonic", "source", "Navidrome / Subsonic", "");
        item(&s, "jellyfin", "source", "Jellyfin", "");
        item(&s, "plex", "source", "Plex", "");
        item(&s, "ytdlp", "source", "YouTube / SoundCloud", "");
        item(&s, "spotify", "source", "Spotify Connect", "");
        item(&s, "airplay", "source", "AirPlay (Apple Music)", "");
        item(&s, "ytmusic", "source", "YouTube Music", "");
        item(&s, "desktop", "source", "Desktop audio (Linux)", "");
        s.selected = 2;
        playing(&s);
        draw(&s, &none, 30);
        save(out, wide ? "5-sources-widescreen" : "3-sources");

        memset(&s.menu, 0, sizeof(s.menu));
        s.count = 0;
        s.view = WJ_VIEW_BROWSE;
        s.depth = 2;
        snprintf(s.title, sizeof(s.title), "%s", "Harbor Lights (Deluxe Edition)");
        const char *titles[] = {
            "Dusk on the Promenade", "Paper Boats", "\xe5\xa4\x9c\xe6\x98\x8e\xe3\x81\x91\xe3\x81\xae\xe3\x83\xa1\xe3\x83\xad\xe3\x83\x87\xe3\x82\xa3",
            "Tide Pools (Live at the Boathouse, Remastered Extended Version)", "Caf\xc3\xa9 Lumi\xc3\xa8re", "Lighthouse Keeper",
            "Salt & Static", "\xce\x9d\xcf\x8d\xcf\x87\xcf\x84\xce\xb1", "Small Hours", "Northern Line", "Harbor Lights", "Goodnight, Gulls",
        };
        for (int i = 0; i < 12; i++) item(&s, "track", "track", titles[i], "The Lantern Choir");
        s.total = 30;
        s.offset = 0;
        s.selected = 3;
        snprintf(s.message, sizeof(s.message), "%s", "Audio ready");
        struct wj_pointer pointer = { 1, wide ? 700 : 520, 302 };
        draw(&s, &pointer, 40);
        clock_ms += 1600;
        draw(&s, &pointer, 20);
        save(out, wide ? "6-album-widescreen" : "4-album");
        assert(wj_ui_hit(pointer.x, pointer.y).target == WJ_TARGET_SEEK);
        int seek = wj_ui_seek_at(&s, pointer.x);
        assert(seek > 0 && seek < s.duration_ms);
        assert(wj_ui_hit(wide ? 300 : 200, 44 + 72 + 3 * 21 + 10).target == WJ_TARGET_ITEM);
    }
    printf("UI render: discovery, servers, sources, album list and now playing at 4:3 and 16:9 (%d frames, software GX)\n",
           gx_soft_frames());
    return 0;
}
