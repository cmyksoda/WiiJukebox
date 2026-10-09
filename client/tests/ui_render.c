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

/* The look being rendered, and where frames go (NULL to only check them). */
static int dark, wide;
static const char *out;

static float layout_width(void) { return wide ? 854 : 640; }

static void save(const char *name) {
    static unsigned char rgb[640 * 480 * 3];
    gx_soft_frame(rgb);
    if (!out) return;
    char path[512];
    snprintf(path, sizeof(path), "%s/%s-%s%s.ppm", out, dark ? "dark" : "light", name, wide ? "-widescreen" : "");
    FILE *file = fopen(path, "wb");
    assert(file);
    fprintf(file, "P6\n640 480\n255\n");
    fwrite(rgb, 1, sizeof(rgb), file);
    fclose(file);
}

static void pixel(int x, int y, unsigned char out_rgb[3]) {
    static unsigned char rgb[640 * 480 * 3];
    gx_soft_frame(rgb);
    memcpy(out_rgb, rgb + (y * 640 + x) * 3, 3);
}

/* A point in layout units, on the 640x480 frame (16:9 layouts are squeezed into it). */
static void pixel_at(float x, float y, unsigned char out_rgb[3]) {
    pixel((int)(x * 640 / layout_width()), (int)y, out_rgb);
}

static int differs(const unsigned char a[3], const unsigned char b[3], int by) {
    for (int k = 0; k < 3; k++)
        if (abs(a[k] - b[k]) > by) return 1;
    return 0;
}

/* Surfaces are bright in the light look, and dark gray in the dark one, never black. */
static void assert_surface(float x, float y) {
    unsigned char c[3];
    pixel_at(x, y, c);
    int sum = c[0] + c[1] + c[2];
    if (dark) assert(sum > 3 * 0x1c && sum < 3 * 0x80);
    else assert(sum > 3 * 0xc8);
}

/* The repeat-one 1 sits in a ringed badge below and right of the button; its ring differs from the card there. */
static int badge_present(float repeat_x, float modes_y) {
    unsigned char below[3], above[3], card[3];
    pixel_at(repeat_x + 14.1f, modes_y + 14.1f, below);
    pixel_at(repeat_x + 14.1f, modes_y + 3.9f, above);
    pixel_at(repeat_x + 22, modes_y + 9, card);
    return differs(below, card, 40) || differs(above, card, 40);
}

static void item(struct wj_session *s, const char *ref, const char *type, const char *title, const char *subtitle) {
    struct wj_item *it = &s->menu.items[s->count++];
    snprintf(it->ref, sizeof(it->ref), "%s", ref);
    snprintf(it->type, sizeof(it->type), "%s", type);
    snprintf(it->title, sizeof(it->title), "%s", title);
    snprintf(it->subtitle, sizeof(it->subtitle), "%s", subtitle);
    s->menu.count = s->count;
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
    s->dark = dark;
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

/* The pixel bounds of every hit target of one kind, found by probing the whole frame. */
struct box { int found; float x0, y0, x1, y1; };

static void scan(enum wj_target target, struct box *boxes, int count) {
    memset(boxes, 0, sizeof(*boxes) * (size_t)count);
    for (int y = 0; y < 480; y++)
        for (int x = 0; x < (int)layout_width(); x++) {
            struct wj_hit hit = wj_ui_hit(x + 0.5f, y + 0.5f);
            if (hit.target != target || hit.index < 0 || hit.index >= count) continue;
            struct box *b = &boxes[hit.index];
            if (!b->found) *b = (struct box){ 1, (float)x, (float)y, (float)x + 1, (float)y + 1 };
            if (x < b->x0) b->x0 = (float)x;
            if (y < b->y0) b->y0 = (float)y;
            if (x + 1 > b->x1) b->x1 = (float)x + 1;
            if (y + 1 > b->y1) b->y1 = (float)y + 1;
        }
}

/* Every edge of a target sits on a whole layout unit, so shapes and glyphs center on whole pixels. */
static int whole_edges(enum wj_target target, int index, const struct box *b) {
    float cx = (b->x0 + b->x1) / 2, cy = (b->y0 + b->y1) / 2;
    struct wj_hit inside_left = wj_ui_hit(b->x0 + 0.01f, cy), outside_left = wj_ui_hit(b->x0 - 0.01f, cy);
    struct wj_hit inside_right = wj_ui_hit(b->x1 - 0.01f, cy), outside_right = wj_ui_hit(b->x1 + 0.01f, cy);
    struct wj_hit inside_top = wj_ui_hit(cx, b->y0 + 0.01f), outside_top = wj_ui_hit(cx, b->y0 - 0.01f);
    struct wj_hit inside_bottom = wj_ui_hit(cx, b->y1 - 0.01f), outside_bottom = wj_ui_hit(cx, b->y1 + 0.01f);
#define IN(h) ((h).target == target && (h).index == index)
    return IN(inside_left) && !IN(outside_left) && IN(inside_right) && !IN(outside_right) &&
           IN(inside_top) && !IN(outside_top) && IN(inside_bottom) && !IN(outside_bottom);
#undef IN
}

static int has_target(enum wj_target target) {
    struct box box[WJ_KEY_COUNT];
    scan(target, box, WJ_KEY_COUNT);
    for (int i = 0; i < WJ_KEY_COUNT; i++)
        if (box[i].found) return 1;
    return 0;
}

static void servers_and_discovery(struct wj_session *s, struct wj_pointer *none) {
    float cx = layout_width() / 2;
    memset(s, 0, sizeof(*s));
    s->view = WJ_VIEW_SERVERS;
    s->discovering = 1;
    s->attempt = 2;
    s->discovery_started = clock_ms - 7000;
    s->phase = "Searching";
    snprintf(s->network, sizeof(s->network), "Wii 192.168.0.8");
    snprintf(s->state, sizeof(s->state), "idle");
    draw(s, none, 1);
    save("01-finding-server");
    assert_surface(4, 70);
    assert(wj_ui_hit(cx, 72 + 252 + 17).target == WJ_TARGET_ENTER_ADDRESS);

    s->discovering = 0;
    snprintf(s->message, sizeof(s->message), "%s", "Server discovery isn't available on this network. Enter the "
             "server's address, or press 1 to retry.");
    s->message_held = 1;
    draw(s, none, 20);
    save("02-no-server");
    assert(wj_ui_hit(cx, 72 + 252 + 17).target == WJ_TARGET_ENTER_ADDRESS);
    assert(wj_ui_hit(cx - 86, 72 + 252 + 17).target == WJ_TARGET_NONE);

    s->message[0] = 0;
    item(s, "server", "server", "Living room PC", "ID 3f2a9c1e");
    item(s, "server", "server", "Studio laptop", "ID 77b01d42");
    draw(s, none, 1);
    save("03-choose-server");
    assert(wj_ui_hit(layout_width() - 20 - 18 - 66, 72 + 9 + 13).target == WJ_TARGET_ENTER_ADDRESS);
    assert(wj_ui_hit(60, 72 + 44 + 30).target == WJ_TARGET_ITEM);
    assert_surface(30, 100);
}

static void sources_and_list(struct wj_session *s, struct wj_pointer *none) {
    memset(&s->menu, 0, sizeof(s->menu));
    s->count = 0;
    s->view = WJ_VIEW_SOURCES;
    snprintf(s->title, sizeof(s->title), "Music sources");
    item(s, "radio", "source", "Internet Radio", "");
    item(s, "podcasts", "source", "Podcasts", "");
    item(s, "subsonic", "source", "Navidrome / Subsonic", "");
    item(s, "jellyfin", "source", "Jellyfin", "");
    item(s, "plex", "source", "Plex", "");
    item(s, "ytdlp", "source", "YouTube / SoundCloud", "");
    item(s, "spotify", "source", "Spotify Connect", "");
    item(s, "airplay", "source", "AirPlay (Apple Music)", "");
    item(s, "ytmusic", "source", "YouTube Music", "");
    item(s, "desktop", "source", "Desktop audio (Linux)", "");
    s->selected = 2;
    playing(s);
    draw(s, none, 30);
    save("04-sources");
    assert_surface(layout_width() - 60, 100);
}

/* The playing card's pixels, to show it keeps its shapes under every overlay test. */
static void album(struct wj_session *s, struct wj_pointer *none) {
    memset(&s->menu, 0, sizeof(s->menu));
    s->count = 0;
    s->view = WJ_VIEW_BROWSE;
    s->depth = 2;
    snprintf(s->title, sizeof(s->title), "%s", "Harbor Lights (Deluxe Edition)");
    const char *titles[] = {
        "Dusk on the Promenade", "Paper Boats", "\xe5\xa4\x9c\xe6\x98\x8e\xe3\x81\x91\xe3\x81\xae\xe3\x83\xa1\xe3\x83\xad\xe3\x83\x87\xe3\x82\xa3",
        "Tide Pools (Live at the Boathouse, Remastered Extended Version)", "Caf\xc3\xa9 Lumi\xc3\xa8re", "Lighthouse Keeper",
        "Salt & Static", "\xce\x9d\xcf\x8d\xcf\x87\xcf\x84\xce\xb1", "Small Hours", "Northern Line", "Harbor Lights", "Goodnight, Gulls",
    };
    for (int i = 0; i < 12; i++) item(s, "track", "track", titles[i], "The Lantern Choir");
    s->total = 30;
    s->offset = 0;
    s->selected = 3;
    snprintf(s->message, sizeof(s->message), "%s", "Audio ready");
    struct wj_pointer pointer = { 1, wide ? 700 : 520, 308 };
    draw(s, &pointer, 40);
    clock_ms += 1600;
    draw(s, &pointer, 20);
    save("05-album");
    assert(wj_ui_hit(pointer.x, pointer.y).target == WJ_TARGET_SEEK);
    int seek = wj_ui_seek_at(s, pointer.x);
    assert(seek > 0 && seek < s->duration_ms);
    assert(wj_ui_hit(wide ? 300 : 200, 44 + 72 + 3 * 21 + 10).target == WJ_TARGET_ITEM);
    assert_surface(30, 100);
    unsigned char c[3];
    pixel(4, 470, c);
    assert(dark ? c[0] + c[1] + c[2] < 3 * 0x80 && c[0] + c[1] + c[2] > 3 * 0x1c : c[0] > 150);

    // Pointing at the cover opens it large over a dimmed screen; nothing beneath reacts.
    float art_x = layout_width() - 20 - floorf(layout_width() * 0.335f) / 2;
    assert(wj_ui_hit(art_x, 72 + 14 + 60).target == WJ_TARGET_ART);
    s->message[0] = 0;
    s->has_large_art = 1;
    s->large_art_version = 1;
    wj_ui_show_art(1);
    assert(wj_ui_art_open());
    draw(s, none, 15);
    save("06-cover-expanded");
    assert(wj_ui_hit(art_x, 72 + 14 + 60).target == WJ_TARGET_NONE);
    pixel(4, 470, c);
    assert(c[0] < 90 && c[1] < 90 && c[2] < 100);
    wj_ui_show_art(0);
    draw(s, none, 15);
    pixel(4, 70, c);
    assert(dark ? c[0] < 0x60 : c[0] > 200);

    // Shuffle and repeat flank the state chip: plain when off, blue when on, a 1 for repeat-one,
    // and gray, without a target, for a source that cannot use them.
    float card_w = floorf(layout_width() * 0.335f), card_x = layout_width() - 20 - card_w;
    float shuffle_x = card_x + 31, repeat_x = card_x + card_w - 31, modes_y = 72 + 14 + 120 + 59;
    struct { const char *name; int shuffle; enum wj_repeat repeat; } modes[] = {
        { "07-modes-off", 0, WJ_REPEAT_OFF }, { "08-modes-shuffle", 1, WJ_REPEAT_OFF },
        { "09-modes-repeat-all", 0, WJ_REPEAT_ALL }, { "10-modes-repeat-one", 0, WJ_REPEAT_ONE },
        { "11-modes-both", 1, WJ_REPEAT_ONE },
    };
    for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
        s->shuffle = modes[i].shuffle;
        s->repeat = modes[i].repeat;
        draw(s, none, 3);
        if (!dark) save(modes[i].name);
        pixel_at(shuffle_x - 7, modes_y + 7, c);
        if (s->shuffle) assert(c[0] < 120 && c[2] > 180);
        else assert(dark ? c[2] < 130 : c[0] > 200 && c[1] > 200 && c[2] > 200);
        pixel_at(repeat_x - 7, modes_y + 7, c);
        if (s->repeat != WJ_REPEAT_OFF) assert(c[0] < 120 && c[2] > 180);
        else assert(dark ? c[2] < 130 : c[0] > 200 && c[1] > 200 && c[2] > 200);
        assert(badge_present(repeat_x, modes_y) == (s->repeat == WJ_REPEAT_ONE));
    }
    assert(wj_ui_hit(shuffle_x, modes_y).target == WJ_TARGET_SHUFFLE);
    assert(wj_ui_hit(repeat_x, modes_y).target == WJ_TARGET_REPEAT);
    assert(wj_ui_hit(shuffle_x + 13, modes_y - 13).target == WJ_TARGET_SHUFFLE);
    assert(wj_ui_hit(shuffle_x, modes_y + 20).target == WJ_TARGET_NONE);
    s->capabilities &= ~(unsigned)(WJ_CAN_SHUFFLE | WJ_CAN_REPEAT);
    draw(s, none, 3);
    if (!dark) save("12-modes-unavailable");
    assert(wj_ui_hit(shuffle_x, modes_y).target == WJ_TARGET_NONE);
    assert(wj_ui_hit(repeat_x, modes_y).target == WJ_TARGET_NONE);
    pixel_at(shuffle_x - 7, modes_y + 7, c);
    assert(dark ? c[2] < 130 : c[0] > 200 && c[1] > 200 && c[2] > 200);
    assert(!badge_present(repeat_x, modes_y));
    s->capabilities |= WJ_CAN_SHUFFLE | WJ_CAN_REPEAT;
    s->shuffle = 0;
    s->repeat = WJ_REPEAT_OFF;
}

/* The three rows of the HOME menu: their pixel boxes, ordered top to bottom. */
static void home_rows(struct box rows[WJ_HOME_ITEMS]) {
    scan(WJ_TARGET_HOME_ITEM, rows, WJ_HOME_ITEMS);
    for (int i = 0; i < WJ_HOME_ITEMS; i++) {
        assert(rows[i].found && rows[i].x1 - rows[i].x0 >= 300 && rows[i].y1 - rows[i].y0 >= 40);
        assert(whole_edges(WJ_TARGET_HOME_ITEM, i, &rows[i]));
        if (i) assert(rows[i].y0 >= rows[i - 1].y1);
    }
}

static void home_menu(struct wj_session *s, struct wj_pointer *none) {
    struct wj_pointer pointer = { 1, 300, 90 };
    struct box rows[WJ_HOME_ITEMS];
    float cx = layout_width() / 2;
    unsigned char selected[3], other[3];

    // Over the list, then over the playing card; nothing under the menu can be pressed.
    for (int view = 0; view < 2; view++) {
        if (view) {
            s->view = WJ_VIEW_SOURCES;
            snprintf(s->title, sizeof(s->title), "Music sources");
        }
        s->home_open = 1;
        s->home_selected = 0;
        draw(s, none, 3);
        save(view ? "14-home-sources" : "13-home-album");
        home_rows(rows);
        assert(wj_ui_hit(4, 4).target == WJ_TARGET_HOME_DISMISS);
        assert(wj_ui_hit(58, 422).target == WJ_TARGET_HOME_DISMISS);
        assert(wj_ui_hit(cx, rows[0].y0 - 6).target == WJ_TARGET_NONE);
        assert(wj_ui_hit(cx, (rows[1].y0 + rows[1].y1) / 2).target == WJ_TARGET_HOME_ITEM);
        assert(wj_ui_hit(cx, (rows[1].y0 + rows[1].y1) / 2).index == 1);
        assert(!has_target(WJ_TARGET_ART) && !has_target(WJ_TARGET_SEEK) && !has_target(WJ_TARGET_PAUSE));
        assert(!has_target(WJ_TARGET_BACK) && !has_target(WJ_TARGET_VISUALIZER));
        // The highlighted row gets the selection fill; the others stay on the panel.
        pixel_at(rows[0].x0 + 4, (rows[0].y0 + rows[0].y1) / 2, selected);
        pixel_at(rows[2].x0 + 4, (rows[2].y0 + rows[2].y1) / 2, other);
        assert(differs(selected, other, 12));
        s->home_selected = 1;
        draw(s, &pointer, 3);
        if (view) save("15-home-theme-selected");
        pixel_at(rows[1].x0 + 4, (rows[1].y0 + rows[1].y1) / 2, selected);
        pixel_at(rows[0].x0 + 4, (rows[0].y0 + rows[0].y1) / 2, other);
        assert(differs(selected, other, 12));
        s->home_selected = 2;
        draw(s, none, 3);
        if (!view) save("16-home-exit-selected");
        pixel_at(rows[2].x0 + 4, (rows[2].y0 + rows[2].y1) / 2, selected);
        assert(differs(selected, other, 12));
    }

    // Closing it brings every target back.
    s->home_open = 0;
    draw(s, none, 3);
    assert(!has_target(WJ_TARGET_HOME_ITEM) && !has_target(WJ_TARGET_HOME_DISMISS));
    assert(has_target(WJ_TARGET_PAUSE) && has_target(WJ_TARGET_BACK));

    // Over a frame something else drew (the visualizer): the same menu, and the pointer.
    s->home_open = 1;
    s->home_selected = 0;
    s->dark = dark;
    wj_gfx_begin();
    for (int i = 0; i < 480; i += 40) {
        float t = i / 480.0f;
        wj_gfx_rect(0, (float)i, layout_width(), 40, WJ_RGBA(0x80, (int)(0x30 + t * 0x80), 0xe0, 0xff),
                    WJ_RGBA(0xe0, (int)(0x20 + t * 0x80), 0x60, 0xff));
    }
    wj_ui_draw_overlay(s, &pointer);
    wj_gfx_present();
    save("17-home-visualizer");
    home_rows(rows);
    assert(wj_ui_hit(4, 4).target == WJ_TARGET_HOME_DISMISS);
    pixel_at(4, 4, selected);
    assert(selected[0] < 100 || selected[2] < 150);
    s->home_open = 0;
}

static void entry_keys(struct box keys[WJ_KEY_COUNT]) {
    scan(WJ_TARGET_KEY, keys, WJ_KEY_COUNT);
    for (int i = 0; i < WJ_KEY_COUNT; i++) {
        const struct wj_key *key = &wj_keypad[i];
        assert(keys[i].found);
        float w = keys[i].x1 - keys[i].x0, h = keys[i].y1 - keys[i].y0;
        // Big enough to hit with a Wii Remote, and sitting on whole units.
        assert(w >= 64 && h >= 46 * key->rows);
        assert(whole_edges(WJ_TARGET_KEY, i, &keys[i]));
        assert(keys[i].y0 >= 72 && keys[i].y1 <= 72 + 304);
        for (int j = 0; j < i; j++) {
            const struct box *a = &keys[i], *b = &keys[j];
            assert(a->x1 <= b->x0 || b->x1 <= a->x0 || a->y1 <= b->y0 || b->y1 <= a->y0);
        }
        float cx = (keys[i].x0 + keys[i].x1) / 2, cy = (keys[i].y0 + keys[i].y1) / 2;
        assert(cx == floorf(cx) || key->column == WJ_KEYPAD_COLUMNS - 1 || (int)(keys[i].x1 - keys[i].x0) % 2 == 1);
        assert(wj_ui_hit(cx, cy).index == i);
    }
    // The pad reads like a phone: columns line up, rows step down, and Connect spans two rows.
    for (int i = 0; i < WJ_KEY_COUNT; i++)
        for (int j = 0; j < WJ_KEY_COUNT; j++) {
            if (wj_keypad[i].column == wj_keypad[j].column) assert(keys[i].x0 == keys[j].x0);
            if (wj_keypad[i].row == wj_keypad[j].row && wj_keypad[i].rows == 1 && wj_keypad[j].rows == 1)
                assert(keys[i].y0 == keys[j].y0);
            if (wj_keypad[i].column < wj_keypad[j].column) assert(keys[i].x1 < keys[j].x0);
        }
    int connect = wj_keypad_at(3, 2);
    assert(keys[connect].y1 - keys[connect].y0 > 2 * (keys[wj_keypad_at(0, 0)].y1 - keys[wj_keypad_at(0, 0)].y0));
    assert(keys[connect].y1 == keys[wj_keypad_at(1, 3)].y1);
}

/* Any strongly red pixel along a row: the field's outline turns red for a failure. */
static int red_on_row(int y) {
    for (int x = 0; x < 640; x++) {
        unsigned char c[3];
        pixel(x, y, c);
        if (c[0] > c[1] + 50 && c[0] > c[2] + 50) return 1;
    }
    return 0;
}

static void entry_screen(struct wj_session *s, struct wj_pointer *none) {
    struct box keys[WJ_KEY_COUNT];
    memset(&s->menu, 0, sizeof(s->menu));
    memset(s->message, 0, sizeof(s->message));
    s->count = s->total = 0;
    s->view = WJ_VIEW_SERVERS;
    s->home_open = 0;
    snprintf(s->network, sizeof(s->network), "Wii 192.168.0.8");
    struct wj_entry *e = &s->entry;
    memset(e, 0, sizeof(*e));
    e->open = 1;
    e->column = e->row = 1;
    e->pressed = -1;
    snprintf(e->prefix, sizeof(e->prefix), "192.168.0.");
    snprintf(e->text, sizeof(e->text), "%s", e->prefix);
    clock_ms = (clock_ms / 1000) * 1000;
    draw(s, none, 3);
    save("18-entry-prefix");
    entry_keys(keys);
    assert(!has_target(WJ_TARGET_ENTER_ADDRESS) && !has_target(WJ_TARGET_FORGET) && !has_target(WJ_TARGET_ITEM));
    // The dock's back pod closes it; the visualizer pod rests.
    assert(wj_ui_hit(58, 422).target == WJ_TARGET_BACK);
    assert(wj_ui_hit(layout_width() - 58, 422).target != WJ_TARGET_VISUALIZER);
    assert(!red_on_row(72 + 12 + 23));
    assert_surface(30, 100);

    // Mid-typing: one key flashes from the press while the pointer rests on another.
    snprintf(e->text, sizeof(e->text), "192.168.0.12");
    e->pressed = wj_keypad_at(1, 0);
    e->pressed_at = clock_ms - 30;
    e->column = 1;
    e->row = 2;
    int eight = wj_keypad_at(1, 2);
    // Resting low and right on the key keeps its digit visible in the picture.
    struct wj_pointer on_eight = { 1, keys[eight].x1 - 14, keys[eight].y1 - 10 };
    draw(s, &on_eight, 2);
    save("19-entry-typing");
    assert(wj_ui_hit(on_eight.x, on_eight.y).target == WJ_TARGET_KEY && wj_ui_hit(on_eight.x, on_eight.y).index == eight);

    // A rejected address says why, in red, under the field.
    snprintf(e->text, sizeof(e->text), "192.168.0.300");
    snprintf(e->message, sizeof(e->message), "%s", wj_address_error_text(WJ_ADDRESS_OCTET));
    e->failed = 1;
    e->pressed = -1;
    draw(s, none, 3);
    save("20-entry-error");
    assert(red_on_row(72 + 12 + 23));

    // D-pad focus: the ring follows the cell, and a two-row key keeps its row.
    e->message[0] = 0;
    e->failed = 0;
    snprintf(e->text, sizeof(e->text), "192.168.0.3");
    e->column = 3;
    e->row = 3;
    draw(s, none, 3);
    save("21-entry-focus-connect");
    assert(wj_keypad[wj_keypad_at(e->column, e->row)].kind == WJ_KEY_CONNECT);

    // Waiting on the server: the keys rest, only the dock's back pod answers.
    snprintf(e->text, sizeof(e->text), "192.168.0.3:4005");
    snprintf(e->message, sizeof(e->message), "Connecting to %s...", e->text);
    e->connecting = 1;
    draw(s, none, 3);
    save("22-entry-connecting");
    assert(!has_target(WJ_TARGET_KEY) && wj_ui_hit(58, 422).target == WJ_TARGET_BACK);
    e->connecting = 0;
    e->message[0] = 0;

    // A remembered address can be forgotten from here.
    snprintf(e->saved, sizeof(e->saved), "192.168.0.3:4005");
    e->column = e->row = 1;
    draw(s, none, 3);
    save("23-entry-saved");
    struct box forget[WJ_KEY_COUNT];
    scan(WJ_TARGET_FORGET, forget, 1);
    assert(forget[0].found && forget[0].x1 - forget[0].x0 >= 100 && forget[0].y1 - forget[0].y0 >= 26);
    entry_keys(keys);

    e->open = 0;
    draw(s, none, 1);
    assert(!has_target(WJ_TARGET_KEY));
}

int main(int argc, char **argv) {
    assert(argc >= 5);
    out = argc > 5 ? argv[5] : NULL;
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
    /* Wide runs last: the GX layer keeps the widest layout it has seen. */
    for (wide = 0; wide < 2; wide++) {
        gx_soft_set_aspect(wide);
        assert(!wj_gfx_init());
        wj_font_shutdown();
        assert(!wj_font_init(faces, 3, wj_gfx_scale_x(), wj_gfx_scale_y()));
        wj_ui_init(logo);
        struct wj_pointer none = { 0, 0, 0 };
        for (dark = 0; dark < 2; dark++) {
            struct wj_session s;
            servers_and_discovery(&s, &none);
            sources_and_list(&s, &none);
            album(&s, &none);
            home_menu(&s, &none);
            entry_screen(&s, &none);

            memset(&s.menu, 0, sizeof(s.menu));
            s.count = s.total = 0;
            s.view = WJ_VIEW_BROWSE;
            s.entry.open = 0;
            snprintf(s.empty, sizeof(s.empty), "%s", "This folder is empty.");
            draw(&s, &none, 1);
            save("24-empty-folder");
        }
    }
    printf("UI render: discovery and its help, servers, sources, album list, now playing, shuffle and repeat states, expanded cover, "
           "HOME menu, address numpad and empty folder in light and dark at 4:3 and 16:9 (%d frames, software GX)\n",
           gx_soft_frames());
    return 0;
}
