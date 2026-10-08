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
static unsigned char art[WJ_ART_SIZE * WJ_ART_SIZE * 2], large_art[WJ_ART_LARGE * WJ_ART_LARGE * 2];
const unsigned char *wj_session_art(void) { return art; }
const unsigned char *wj_session_large_art(void) { return large_art; }

/* Album-art stand-in: a dusk gradient with a sun, tiled like the server's output. */
static void paint_art(unsigned char *texels, int size) {
    for (int y = 0; y < size; y++)
        for (int x = 0; x < size; x++) {
            float u = x * 128.0f / size, v0 = y * 128.0f / size;
            float t = v0 / 128, dx = u - 84.0f, dy = v0 - 52.0f;
            float r = 0.98f - 0.5f * t, g = 0.55f - 0.35f * t, b = 0.45f + 0.3f * t;
            if (dx * dx + dy * dy < 22 * 22) { r = 1; g = 0.86f; b = 0.55f; }
            if (v0 > 92 + 6 * sinf(u / 9.0f)) { r *= 0.3f; g *= 0.3f; b *= 0.45f; }
            unsigned v = (unsigned)(r * 31) << 11 | (unsigned)(g * 63) << 5 | (unsigned)(b * 31);
            unsigned char *p = texels + ((y / 4) * (size / 4) + x / 4) * 32 + ((y % 4) * 4 + x % 4) * 2;
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

/* A point in layout units, on the 640x480 frame (16:9 layouts are squeezed into it). */
static void pixel_at(float x, float y, int wide, unsigned char out[3]) {
    pixel((int)(x * 640 / (wide ? 854 : 640)), (int)y, out);
}

/* The repeat-one 1 sits in a ringed badge below and right of the button; look for the ring beyond the button's edge. */
static int badge_present(float repeat_x, float modes_y, int wide) {
    unsigned char below[3], above[3];
    pixel_at(repeat_x + 14.1f, modes_y + 14.1f, wide, below);
    pixel_at(repeat_x + 14.1f, modes_y + 3.9f, wide, above);
    return below[0] < 215 || above[0] < 215;
}

static void playing(struct wj_session *s) {
    snprintf(s->song, sizeof(s->song), "%s", "Dusk on the Promenade");
    snprintf(s->artist, sizeof(s->artist), "%s", "The Lantern Choir");
    snprintf(s->state, sizeof(s->state), "%s", "playing");
    s->capabilities = WJ_CAN_PAUSE | WJ_CAN_STOP | WJ_CAN_NEXT | WJ_CAN_PREVIOUS | WJ_CAN_SEEK |
        WJ_CAN_SHUFFLE | WJ_CAN_REPEAT;
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
    assert(argc >= 5);
    const char *out = argc > 5 ? argv[5] : NULL;
    static unsigned char logo[32 * 48] __attribute__((aligned(32)));
    assert(load(argv[4], logo, sizeof(logo)) == sizeof(logo));
    static unsigned char latin[1024 * 1024], greek[256 * 1024], cjk[2 * 1024 * 1024];
    const struct wj_font_face faces[] = {
        { latin, load(argv[1], latin, sizeof(latin)) },
        { greek, load(argv[2], greek, sizeof(greek)) },
        { cjk, load(argv[3], cjk, sizeof(cjk)) },
    };
    paint_art(art, WJ_ART_SIZE);
    paint_art(large_art, WJ_ART_LARGE);
    for (int wide = 0; wide < 2; wide++) {
        gx_soft_set_aspect(wide);
        assert(!wj_gfx_init());
        wj_font_shutdown();
        assert(!wj_font_init(faces, 3, wj_gfx_scale_x(), wj_gfx_scale_y()));
        wj_ui_init(logo);
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
        snprintf(s.message, sizeof(s.message), "%s", "Server discovery isn't available on this network. Launch with "
                 "the server's address (see README), or press 1 to retry.");
        s.message_held = 1;
        draw(&s, &none, 20);
        if (!wide) save(out, "8-discovery-help");
        s.message[0] = 0;
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
        struct wj_pointer pointer = { 1, wide ? 700 : 520, 308 };
        draw(&s, &pointer, 40);
        clock_ms += 1600;
        draw(&s, &pointer, 20);
        save(out, wide ? "6-album-widescreen" : "4-album");
        assert(wj_ui_hit(pointer.x, pointer.y).target == WJ_TARGET_SEEK);
        int seek = wj_ui_seek_at(&s, pointer.x);
        assert(seek > 0 && seek < s.duration_ms);
        assert(wj_ui_hit(wide ? 300 : 200, 44 + 72 + 3 * 21 + 10).target == WJ_TARGET_ITEM);

        // Pointing at the cover opens it large over a dimmed screen; nothing beneath reacts.
        float art_x = wide ? 854 - 20 - floorf(854 * 0.335f) / 2 : 640 - 20 - floorf(640 * 0.335f) / 2;
        assert(wj_ui_hit(art_x, 72 + 14 + 60).target == WJ_TARGET_ART);
        s.message[0] = 0;
        s.has_large_art = 1;
        s.large_art_version = 1;
        wj_ui_show_art(1);
        assert(wj_ui_art_open());
        draw(&s, &none, 15);
        save(out, wide ? "9-cover-expanded-widescreen" : "7-cover-expanded");
        assert(wj_ui_hit(art_x, 72 + 14 + 60).target == WJ_TARGET_NONE);
        pixel(4, 470, c);
        assert(c[0] < 90 && c[1] < 90 && c[2] < 100);
        wj_ui_show_art(0);
        draw(&s, &none, 15);
        pixel(4, 70, c);
        assert(c[0] > 200);

        // Shuffle and repeat flank the state chip: plain when off, blue when on, a 1 for repeat-one,
        // and gray, without a target, for a source that cannot use them.
        float card_w = floorf((wide ? 854 : 640) * 0.335f), card_x = (wide ? 854 : 640) - 20 - card_w;
        float shuffle_x = card_x + 31, repeat_x = card_x + card_w - 31, modes_y = 72 + 14 + 120 + 59;
        struct { const char *name; int shuffle; enum wj_repeat repeat; } modes[] = {
            { "10-modes-off", 0, WJ_REPEAT_OFF }, { "11-modes-shuffle", 1, WJ_REPEAT_OFF },
            { "12-modes-repeat-all", 0, WJ_REPEAT_ALL }, { "13-modes-repeat-one", 0, WJ_REPEAT_ONE },
            { "14-modes-both", 1, WJ_REPEAT_ONE },
        };
        for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
            s.shuffle = modes[i].shuffle;
            s.repeat = modes[i].repeat;
            draw(&s, &none, 3);
            char name[64];
            snprintf(name, sizeof(name), "%s%s", modes[i].name, wide ? "-widescreen" : "");
            save(out, name);
            pixel_at(shuffle_x - 7, modes_y + 7, wide, c);
            if (s.shuffle) assert(c[0] < 120 && c[2] > 180);
            else assert(c[0] > 200 && c[1] > 200 && c[2] > 200);
            pixel_at(repeat_x - 7, modes_y + 7, wide, c);
            if (s.repeat != WJ_REPEAT_OFF) assert(c[0] < 120 && c[2] > 180);
            else assert(c[0] > 200 && c[1] > 200 && c[2] > 200);
            assert(badge_present(repeat_x, modes_y, wide) == (s.repeat == WJ_REPEAT_ONE));
        }
        assert(wj_ui_hit(shuffle_x, modes_y).target == WJ_TARGET_SHUFFLE);
        assert(wj_ui_hit(repeat_x, modes_y).target == WJ_TARGET_REPEAT);
        assert(wj_ui_hit(shuffle_x + 13, modes_y - 13).target == WJ_TARGET_SHUFFLE);
        assert(wj_ui_hit(shuffle_x, modes_y + 20).target == WJ_TARGET_NONE);
        s.capabilities &= ~(unsigned)(WJ_CAN_SHUFFLE | WJ_CAN_REPEAT);
        draw(&s, &none, 3);
        save(out, wide ? "15-modes-unavailable-widescreen" : "15-modes-unavailable");
        assert(wj_ui_hit(shuffle_x, modes_y).target == WJ_TARGET_NONE);
        assert(wj_ui_hit(repeat_x, modes_y).target == WJ_TARGET_NONE);
        pixel_at(shuffle_x - 7, modes_y + 7, wide, c);
        assert(c[0] > 200 && c[1] > 200 && c[2] > 200);
        assert(!badge_present(repeat_x, modes_y, wide));
        s.capabilities |= WJ_CAN_SHUFFLE | WJ_CAN_REPEAT;
        s.shuffle = 0;
        s.repeat = WJ_REPEAT_OFF;

        memset(&s.menu, 0, sizeof(s.menu));
        s.count = s.total = 0;
        snprintf(s.empty, sizeof(s.empty), "%s", "This folder is empty.");
        draw(&s, &none, 1);
    }
    printf("UI render: discovery and its help, servers, sources, album list, now playing, shuffle and repeat states, expanded cover and empty folder at 4:3 and 16:9 (%d frames, software GX)\n",
           gx_soft_frames());
    return 0;
}
