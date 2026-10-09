// SPDX-License-Identifier: GPL-3.0-only
#include "ui.h"
#include "gfx.h"
#include "font.h"
#include "layout.h"
#include "net.h"
#include "theme.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define TOP 72.0f
#define PANEL_H 304.0f
#define ROW_H 21.0f
#define GRID_ROWS 3
#define MAX_HITS 48

/* Never themed: image tints, the cursor and the dimmed cover view. */
#define WHITE WJ_RGBA(0xff, 0xff, 0xff, 0xff)

enum icon { ICON_NOTE, ICON_FOLDER, ICON_ALBUM, ICON_RADIO, ICON_ARTIST, ICON_PLAYLIST, ICON_SERVER,
            ICON_VIDEO, ICON_DESKTOP, ICON_JELLYFIN, ICON_PLEX, ICON_SPOTIFY, ICON_AIRPLAY, ICON_YTMUSIC,
            ICON_PODCAST };

static const struct wj_theme *T;
static struct { float w, content_x, content_w, card_x, card_w; } L;
static struct { float x, y, w, h; enum wj_target target; int index; } hits[MAX_HITS];
static int hit_count, columns = 3, seek_preview = -1, seek_pointer;
static float bar_x, bar_w, highlight_y = -1;
static long long volume_shown, selection_changed;
static int last_selected = -1, last_view = -1;
static float toast_alpha;
static char toast[257];
static unsigned art_version, large_art_version;
static struct wj_image art, large_art, logo;
static unsigned char art_texels[WJ_ART_SIZE * WJ_ART_SIZE * 2] __attribute__((aligned(32)));
static unsigned char large_texels[WJ_ART_LARGE * WJ_ART_LARGE * 2] __attribute__((aligned(32)));
static int art_open;
static long long art_changed;
static float art_x, art_y, art_size;

int wj_ui_grid_columns(enum wj_view view) { return view == WJ_VIEW_SERVERS ? columns + 1 : columns; }
void wj_ui_seek_preview(int position_ms) { seek_preview = position_ms; }
void wj_ui_volume_changed(void) { volume_shown = wj_milliseconds(); }

int wj_ui_art_open(void) { return art_open; }

void wj_ui_show_art(int open) {
    if (open == art_open) return;
    art_open = open;
    art_changed = wj_milliseconds();
}

int wj_ui_init(void *logo_texels) {
    wj_gfx_image_i8(&logo, logo_texels, 32, 48);
    L.w = wj_gfx_width();
    L.card_w = floorf(L.w * 0.335f);
    L.content_x = 20;
    L.card_x = L.w - 20 - L.card_w;
    L.content_w = L.card_x - 12 - L.content_x;
    columns = L.w > 700 ? 4 : 3;
    return 0;
}

static void hit(float x, float y, float w, float h, enum wj_target target, int index) {
    if (hit_count == MAX_HITS) return;
    hits[hit_count].x = x; hits[hit_count].y = y; hits[hit_count].w = w; hits[hit_count].h = h;
    hits[hit_count].target = target;
    hits[hit_count].index = index;
    hit_count++;
}

struct wj_hit wj_ui_hit(float x, float y) {
    for (int i = hit_count - 1; i >= 0; i--) {
        if (x >= hits[i].x && x < hits[i].x + hits[i].w && y >= hits[i].y && y < hits[i].y + hits[i].h)
            return (struct wj_hit){ hits[i].target, hits[i].index };
    }
    return (struct wj_hit){ WJ_TARGET_NONE, 0 };
}

static float measure(void *context, const char *text, int bytes) {
    const int *style = context;
    return wj_font_measure(text, bytes, style[0], style[1]);
}

/* Draws `text` ellipsized to max_width; align 0 left, 1 center, 2 right. Returns its width. */
static float label(const char *text, float x, float baseline, int size, int bold, u32 color, float max_width, int align) {
    int style[2] = { size, bold };
    int truncated;
    float ellipsis = wj_font_measure("\xe2\x80\xa6", 3, size, bold);
    int bytes = wj_fit_text(text, max_width, ellipsis, measure, style, &truncated);
    float width = wj_font_measure(text, bytes, size, bold) + (truncated ? ellipsis : 0);
    if (align == 1) x -= width / 2;
    else if (align == 2) x -= width;
    wj_gfx_text(text, bytes, x, baseline, size, bold, color);
    if (truncated) wj_gfx_text("\xe2\x80\xa6", 3, x + width - ellipsis, baseline, size, bold, color);
    return width;
}

/* Breaks at the last space that fits, so a tile name uses its second line before an ellipsis. */
static void label_two_lines(const char *text, float cx, float baseline, int size, int bold, u32 color, float max_width) {
    int style[2] = { size, bold };
    int truncated;
    int cut = wj_fit_text(text, max_width, 0, measure, style, &truncated);
    if (truncated)
        while (cut > 0 && text[cut] != ' ') cut--;
    if (!truncated || cut == 0) {
        label(text, cx, baseline, size, bold, color, max_width, 1);
        return;
    }
    char first[WJ_FIELD];
    snprintf(first, sizeof(first), "%.*s", cut, text);
    label(first, cx, baseline, size, bold, color, max_width, 1);
    label(text + cut + 1, cx, baseline + size + 1, size, bold, color, max_width, 1);
}

/* Centered lines broken at spaces; returns the baseline after the last line. */
static float paragraph(const char *text, float cx, float baseline, int size, int bold, u32 color, float max_width, int lines) {
    int style[2] = { size, bold };
    while (*text && lines--) {
        int truncated;
        int cut = wj_fit_text(text, max_width, 0, measure, style, &truncated);
        if (truncated && lines) {
            int space = cut;
            while (space > 0 && text[space] != ' ') space--;
            if (space > 0) cut = space;
        } else cut = (int)strlen(text);
        char line[WJ_FIELD];
        snprintf(line, sizeof(line), "%.*s", cut, text);
        label(line, cx, baseline, size, bold, color, max_width, 1);
        baseline += size + 6;
        text += cut;
        while (*text == ' ') text++;
    }
    return baseline;
}

/* Baseline that visually centers Latin capitals and kana around cy. */
static float centered(float cy, int size) { return floorf(cy + size * 0.37f + 0.5f); }

static void panel(float x, float y, float w, float h, float r) {
    wj_gfx_round(x, y + 3, w, h, r, T->shadow, T->shadow);
    wj_gfx_round(x, y, w, h, r, T->panel_top, T->panel_bottom);
    wj_gfx_round_line(x, y, w, h, r, 1.5f, T->border);
}

/* `hole` is the surface behind the icon, for the parts cut out of it. */
static void icon(enum icon kind, float cx, float cy, float s, u32 color, u32 hole) {
    switch (kind) {
    case ICON_NOTE:
        wj_gfx_circle(cx - s * 0.16f, cy + s * 0.26f, s * 0.19f, color);
        wj_gfx_rect(cx - s * 0.02f, cy - s * 0.38f, s * 0.1f, s * 0.64f, color, color);
        wj_gfx_triangle(cx + s * 0.08f, cy - s * 0.38f, cx + s * 0.36f, cy - s * 0.18f, cx + s * 0.08f, cy - s * 0.1f, color);
        break;
    case ICON_FOLDER:
        wj_gfx_round(cx - s * 0.45f, cy - s * 0.32f, s * 0.42f, s * 0.24f, s * 0.06f, color, color);
        wj_gfx_round(cx - s * 0.45f, cy - s * 0.2f, s * 0.9f, s * 0.58f, s * 0.08f, color, color);
        break;
    case ICON_ALBUM:
        wj_gfx_circle(cx, cy, s * 0.45f, color);
        wj_gfx_circle(cx, cy, s * 0.14f, hole);
        wj_gfx_ring(cx, cy, s * 0.32f, s * 0.04f, wj_gfx_fade(hole, 0.45f));
        break;
    case ICON_RADIO:
        wj_gfx_rect(cx - s * 0.04f, cy - s * 0.46f, s * 0.08f, s * 0.3f, color, color);
        wj_gfx_round(cx - s * 0.45f, cy - s * 0.2f, s * 0.9f, s * 0.6f, s * 0.1f, color, color);
        wj_gfx_circle(cx - s * 0.18f, cy + s * 0.1f, s * 0.16f, hole);
        wj_gfx_rect(cx + s * 0.08f, cy - s * 0.04f, s * 0.24f, s * 0.06f, hole, hole);
        wj_gfx_rect(cx + s * 0.08f, cy + s * 0.12f, s * 0.24f, s * 0.06f, hole, hole);
        break;
    case ICON_ARTIST:
        wj_gfx_circle(cx, cy - s * 0.18f, s * 0.2f, color);
        wj_gfx_round(cx - s * 0.36f, cy + s * 0.08f, s * 0.72f, s * 0.42f, s * 0.2f, color, color);
        break;
    case ICON_PLAYLIST:
        for (int i = 0; i < 3; i++)
            wj_gfx_round(cx - s * 0.45f, cy - s * 0.32f + i * s * 0.24f, s * (i == 2 ? 0.45f : 0.75f), s * 0.11f, s * 0.05f, color, color);
        icon(ICON_NOTE, cx + s * 0.22f, cy + s * 0.18f, s * 0.55f, color, hole);
        break;
    case ICON_SERVER:
        for (int i = 0; i < 2; i++) {
            float y = cy - s * 0.38f + i * s * 0.42f;
            wj_gfx_round(cx - s * 0.4f, y, s * 0.8f, s * 0.34f, s * 0.08f, color, color);
            wj_gfx_circle(cx + s * 0.24f, y + s * 0.17f, s * 0.06f, WJ_RGBA(0x7c, 0xe0, 0x8a, 0xff));
            wj_gfx_rect(cx - s * 0.28f, y + s * 0.14f, s * 0.3f, s * 0.06f, hole, hole);
        }
        break;
    case ICON_VIDEO:
        wj_gfx_round(cx - s * 0.46f, cy - s * 0.32f, s * 0.92f, s * 0.64f, s * 0.16f, color, color);
        wj_gfx_triangle(cx - s * 0.12f, cy - s * 0.17f, cx + s * 0.2f, cy, cx - s * 0.12f, cy + s * 0.17f, hole);
        break;
    case ICON_DESKTOP:
        wj_gfx_round(cx - s * 0.46f, cy - s * 0.38f, s * 0.92f, s * 0.58f, s * 0.07f, color, color);
        wj_gfx_rect(cx - s * 0.38f, cy - s * 0.3f, s * 0.76f, s * 0.42f, hole, hole);
        wj_gfx_rect(cx - s * 0.06f, cy + s * 0.2f, s * 0.12f, s * 0.14f, color, color);
        wj_gfx_round(cx - s * 0.26f, cy + s * 0.32f, s * 0.52f, s * 0.08f, s * 0.04f, color, color);
        break;
    case ICON_JELLYFIN:
        wj_gfx_triangle(cx, cy - s * 0.42f, cx + s * 0.44f, cy + s * 0.36f, cx - s * 0.44f, cy + s * 0.36f, color);
        wj_gfx_triangle(cx, cy - s * 0.08f, cx + s * 0.18f, cy + s * 0.24f, cx - s * 0.18f, cy + s * 0.24f, hole);
        break;
    case ICON_PLEX:
        wj_gfx_triangle(cx - s * 0.3f, cy - s * 0.4f, cx + s * 0.34f, cy, cx - s * 0.3f, cy + s * 0.4f, color);
        wj_gfx_triangle(cx - s * 0.3f, cy - s * 0.16f, cx + s * 0.02f, cy, cx - s * 0.3f, cy + s * 0.16f, hole);
        break;
    case ICON_SPOTIFY:
        wj_gfx_circle(cx, cy, s * 0.46f, color);
        for (int i = 0; i < 3; i++) {
            float w = s * (0.56f - i * 0.1f);
            wj_gfx_round(cx - w / 2, cy - s * 0.18f + i * s * 0.15f, w, s * 0.07f, s * 0.035f, hole, hole);
        }
        break;
    case ICON_AIRPLAY:
        wj_gfx_round(cx - s * 0.44f, cy - s * 0.38f, s * 0.88f, s * 0.58f, s * 0.08f, color, color);
        wj_gfx_rect(cx - s * 0.36f, cy - s * 0.3f, s * 0.72f, s * 0.42f, hole, hole);
        wj_gfx_rect(cx - s * 0.2f, cy + s * 0.1f, s * 0.4f, s * 0.12f, hole, hole);
        wj_gfx_triangle(cx, cy + s * 0.02f, cx + s * 0.24f, cy + s * 0.42f, cx - s * 0.24f, cy + s * 0.42f, color);
        break;
    case ICON_YTMUSIC:
        wj_gfx_circle(cx, cy, s * 0.46f, color);
        wj_gfx_ring(cx, cy, s * 0.28f, s * 0.05f, hole);
        // Centroid on the center, so the triangle reads as centered in the ring.
        wj_gfx_triangle(cx - s * 0.08f, cy - s * 0.14f, cx + s * 0.16f, cy, cx - s * 0.08f, cy + s * 0.14f, hole);
        break;
    case ICON_PODCAST:
        wj_gfx_ring(cx, cy - s * 0.08f, s * 0.38f, s * 0.07f, color);
        wj_gfx_ring(cx, cy - s * 0.08f, s * 0.22f, s * 0.07f, color);
        wj_gfx_circle(cx, cy - s * 0.08f, s * 0.1f, color);
        wj_gfx_round(cx - s * 0.06f, cy - s * 0.02f, s * 0.12f, s * 0.48f, s * 0.06f, color, color);
        break;
    }
}

static enum icon icon_for(const char *type, const char *ref) {
    static const struct { const char *name; enum icon kind; } kinds[] = {
        { "folder", ICON_FOLDER }, { "album", ICON_ALBUM }, { "station", ICON_RADIO },
        { "artist", ICON_ARTIST }, { "playlist", ICON_PLAYLIST }, { "server", ICON_SERVER },
        { "radio", ICON_RADIO }, { "subsonic", ICON_NOTE }, { "jellyfin", ICON_JELLYFIN },
        { "plex", ICON_PLEX }, { "ytdlp", ICON_VIDEO }, { "desktop", ICON_DESKTOP },
        { "spotify", ICON_SPOTIFY }, { "airplay", ICON_AIRPLAY }, { "ytmusic", ICON_YTMUSIC },
        { "podcasts", ICON_PODCAST }, { "show", ICON_PODCAST },
    };
    const char *key = !strcmp(type, "source") ? ref : type;
    for (size_t i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++)
        if (!strcmp(key, kinds[i].name)) return kinds[i].kind;
    return ICON_NOTE;
}

static u32 icon_color(enum icon kind) {
    switch (kind) {
    case ICON_RADIO: return WJ_RGBA(0xf0, 0x96, 0x3a, 0xff);
    case ICON_JELLYFIN: return WJ_RGBA(0x9a, 0x62, 0xe0, 0xff);
    case ICON_PLEX: return WJ_RGBA(0xe2, 0xa0, 0x18, 0xff);
    case ICON_VIDEO: return WJ_RGBA(0xe5, 0x4f, 0x4a, 0xff);
    case ICON_DESKTOP: return WJ_RGBA(0x2c, 0xb0, 0xa0, 0xff);
    case ICON_SPOTIFY: return WJ_RGBA(0x1d, 0xb9, 0x54, 0xff);
    case ICON_AIRPLAY: return T->icon_gray;
    case ICON_YTMUSIC: return WJ_RGBA(0xe0, 0x2f, 0x3b, 0xff);
    case ICON_PODCAST: return WJ_RGBA(0xd9, 0x4a, 0x8c, 0xff);
    default: return T->blue;
    }
}

static void background(void) {
    wj_gfx_rect(0, 0, L.w, WJ_GFX_HEIGHT, T->bg_top, T->bg_bottom);
    for (float y = 2; y < WJ_GFX_HEIGHT; y += 4) wj_gfx_rect(0, y, L.w, 1, T->stripe, T->stripe);
}

static void header(const struct wj_session *s, long long now) {
    // The web UI's wordmark: blue "Wii", ink "Jukebox", then the jukebox mark.
    float x = 24 + label("Wii", 24, 42, 22, 1, T->blue, 100, 0) + 1;
    x += label("Jukebox", x, 42, 22, 1, T->ink, 200, 0);
    wj_gfx_mask(&logo, x + 7, 13, 24, 35, T->blue);
    char status[200];
    u32 dot = T->muted;
    if (s->view == WJ_VIEW_SERVERS) snprintf(status, sizeof(status), "%s", s->network);
    else {
        int tenths = (int)((long long)s->audio.buffered * 80 / ((s->audio.bitrate ? s->audio.bitrate : 128) * 1000));
        const char *state = !s->audio_running ? "Disconnected" : !s->audio.connected ? "Reconnecting" :
            s->stream_started ? "Connected" : "Buffering";
        dot = !s->audio_running || !s->audio.connected ? WJ_RGBA(0xe2, 0x5c, 0x5c, 0xff) :
            s->stream_started ? WJ_RGBA(0x4c, 0xc2, 0x6c, 0xff) : WJ_RGBA(0xf0, 0xb0, 0x3a, 0xff);
        int length = snprintf(status, sizeof(status), "%s  \xc2\xb7  %d kbps  \xc2\xb7  %d.%ds buffer",
                              state, s->audio.bitrate, tenths / 10, tenths % 10);
        if (s->underruns && length > 0 && length < (int)sizeof(status))
            snprintf(status + length, sizeof(status) - length, "  \xc2\xb7  %d restarts", s->underruns);
    }
    float width = label(status, L.w - 24, 40, 13, 0, T->muted, L.w - 300, 2);
    float pulse = s->audio_running && !s->audio.connected ? 0.5f + 0.5f * sinf(now / 160.0f) : 1;
    wj_gfx_circle(L.w - 34 - width, 36, 4, wj_gfx_fade(dot, pulse));
}

static void page_arrow(float cx, float cy, int direction, int enabled, enum wj_target target) {
    u32 color = enabled ? T->blue : T->faint;
    wj_gfx_circle(cx, cy, 11, enabled ? T->select_top : T->disabled);
    float d = direction * 4.0f;
    wj_gfx_triangle(cx - d, cy - 6, cx + d, cy, cx - d, cy + 6, color);
    if (enabled) hit(cx - 13, cy - 13, 26, 26, target, 0);
}

static void spinner(float cx, float cy, float r, long long now) {
    int lead = (int)(now / 90) % 12;
    for (int i = 0; i < 12; i++) {
        float angle = (float)M_PI * 2 * i / 12;
        int age = (lead - i + 12) % 12;
        wj_gfx_circle(cx + cosf(angle) * r, cy + sinf(angle) * r, 4.5f, wj_gfx_fade(T->blue, 1.0f - age / 12.0f));
    }
}

static void discovery(const struct wj_session *s, long long now) {
    float x = L.content_x, w = L.w - 40;
    panel(x, TOP, w, PANEL_H, 18);
    int failed = !s->discovering && s->message[0];
    if (failed) {
        u32 amber = WJ_RGBA(0xf0, 0xa8, 0x30, 0xff);
        wj_gfx_circle(L.w / 2, TOP + 96, 28, T->warn_fill);
        wj_gfx_ring(L.w / 2, TOP + 96, 28, 3, amber);
        wj_gfx_round(L.w / 2 - 3, TOP + 80, 6, 22, 3, amber, amber);
        wj_gfx_circle(L.w / 2, TOP + 110, 3.5f, amber);
    } else spinner(L.w / 2, TOP + 96, 26, now);
    const char *heading = s->discovering && s->phase ? s->phase : failed ? "Couldn't find your server" :
        "Looking for WiiJukebox servers";
    label(heading, L.w / 2, TOP + 168, 19, 1, T->ink, w - 40, 1);
    char line[96];
    if (s->discovering) snprintf(line, sizeof(line), "Attempt %d  \xc2\xb7  %llds", s->attempt,
                                 (now - s->discovery_started) / 1000);
    else snprintf(line, sizeof(line), "%s", s->network);
    label(line, L.w / 2, TOP + 194, 15, 0, T->muted, w - 40, 1);
    // A failure here needs the whole sentence, so it sits in the panel, not in a toast.
    if (failed) paragraph(s->message, L.w / 2, TOP + 228, 15, 0, T->ink, w - 80, 3);
    else label("Press 1 to start again", L.w / 2, TOP + 236, 14, 0, T->faint, w - 40, 1);
}

static void tiles(const struct wj_session *s, long long now) {
    float x = L.content_x, w = s->view == WJ_VIEW_SERVERS ? L.w - 40 : L.content_w;
    int cols = wj_ui_grid_columns(s->view);
    panel(x, TOP, w, PANEL_H, 18);
    label(s->view == WJ_VIEW_SERVERS ? "Choose a server" : s->title, x + 18, TOP + 27, 19, 1, T->ink, w - 36, 0);
    float gap = 12, tile_w = (w - 32 - gap * (cols - 1)) / cols, tile_h = 74;
    int first = s->selected / cols >= GRID_ROWS ? (s->selected / cols - GRID_ROWS + 1) * cols : 0;
    for (int i = first; i < s->count && i < first + cols * GRID_ROWS; i++) {
        float tx = x + 16 + (i % cols) * (tile_w + gap), ty = TOP + 44 + ((i - first) / cols) * (tile_h + gap);
        const struct wj_item *item = &s->menu.items[i];
        int selected = i == s->selected;
        wj_gfx_round(tx, ty + 2, tile_w, tile_h, 12, T->shadow, T->shadow);
        wj_gfx_round(tx, ty, tile_w, tile_h, 12, T->tile_top, T->tile_bottom);
        if (selected) {
            float pulse = 0.55f + 0.45f * sinf(now / 260.0f);
            wj_gfx_round_line(tx - 3, ty - 3, tile_w + 6, tile_h + 6, 15, 3, wj_gfx_fade(T->blue, 0.25f * pulse));
            wj_gfx_round_line(tx, ty, tile_w, tile_h, 12, 3, T->blue);
        } else wj_gfx_round_line(tx, ty, tile_w, tile_h, 12, 1.5f, T->border);
        enum icon kind = icon_for(item->type, item->ref);
        icon(kind, tx + tile_w / 2, ty + 26, 26, icon_color(kind), T->tile_top);
        if (item->subtitle[0]) {
            label(item->title, tx + tile_w / 2, ty + 54, 13, selected, T->ink, tile_w - 8, 1);
            label(item->subtitle, tx + tile_w / 2, ty + 68, 11, 0, T->muted, tile_w - 8, 1);
        } else label_two_lines(item->title, tx + tile_w / 2, ty + 54, 13, selected, T->ink, tile_w - 8);
        hit(tx, ty, tile_w, tile_h, WJ_TARGET_ITEM, i);
    }
    if (!s->count && s->empty[0]) paragraph(s->empty, x + w / 2, TOP + PANEL_H / 2, 15, 0, T->muted, w - 60, 2);
}

static void list(const struct wj_session *s, long long now) {
    float x = L.content_x, w = L.content_w;
    panel(x, TOP, w, PANEL_H, 18);
    char pages[64] = "";
    if (s->total > 0) snprintf(pages, sizeof(pages), "%d\xe2\x80\x93%d of %d",
                               s->count ? s->offset + 1 : 0, s->offset + s->count, s->total);
    float pages_w = pages[0] ? wj_font_measure(pages, (int)strlen(pages), 13, 0) : 0;
    label(s->title, x + 18, TOP + 27, 19, 1, T->ink, w - 100 - pages_w, 0);
    int more = s->offset + s->count < s->total, less = s->offset > 0;
    if (s->total > WJ_PAGE_SIZE) {
        page_arrow(x + w - 24, TOP + 21, 1, more, WJ_TARGET_PAGE_NEXT);
        page_arrow(x + w - 52, TOP + 21, -1, less, WJ_TARGET_PAGE_PREVIOUS);
        label(pages, x + w - 70, TOP + 26, 13, 0, T->muted, 120, 2);
    } else if (pages[0]) label(pages, x + w - 18, TOP + 26, 13, 0, T->muted, 120, 2);
    wj_gfx_rect(x + 14, TOP + 38, w - 28, 1, T->border, T->border);
    float rows_y = TOP + 44;
    if (s->count) {
        float target = rows_y + s->selected * ROW_H;
        highlight_y = highlight_y < 0 || last_view != (int)s->view ? target : highlight_y + (target - highlight_y) * 0.35f;
        wj_gfx_round(x + 8, highlight_y, w - 16, ROW_H, 8, T->select_top, T->select_bottom);
        wj_gfx_round_line(x + 8, highlight_y, w - 16, ROW_H, 8, 2, T->blue);
    }
    for (int i = 0; i < s->count; i++) {
        const struct wj_item *item = &s->menu.items[i];
        float y = rows_y + i * ROW_H, cy = y + ROW_H / 2;
        int selected = i == s->selected;
        enum icon kind = icon_for(item->type, item->ref);
        icon(kind, x + 26, cy, 13, selected ? T->accent : T->faint, selected ? T->select_top : T->panel_top);
        float text_x = x + 42, room = w - 54;
        float sub_w = 0;
        if (item->subtitle[0] && room > 200) {
            sub_w = label(item->subtitle, x + w - 16, centered(cy, 12), 12, 0, T->muted, room * 0.38f, 2) + 12;
        }
        float title_room = room - sub_w;
        float full = wj_font_measure(item->title, (int)strlen(item->title), 15, selected);
        if (selected && full > title_room && now - selection_changed > 1200) {
            // Long selected titles scroll, pausing at each end, like Wii channel names.
            float travel = full - title_room + 16, t = (now - selection_changed - 1200) * 0.04f;
            float cycle = travel * 2 + 80, phase = fmodf(t, cycle);
            float offset = phase < 40 ? 0 : phase < 40 + travel ? phase - 40 : phase < 80 + travel ? travel :
                travel - (phase - 80 - travel);
            if (offset < 0) offset = 0;
            wj_gfx_clip(text_x, y, title_room, ROW_H);
            wj_gfx_text(item->title, (int)strlen(item->title), text_x - offset, centered(cy, 15), 15, 1, T->ink);
            wj_gfx_unclip();
        } else label(item->title, text_x, centered(cy, 15), 15, selected, T->ink, title_room, 0);
        hit(x + 8, y, w - 16, ROW_H, WJ_TARGET_ITEM, i);
    }
    if (!s->count && s->empty[0]) paragraph(s->empty, x + w / 2, TOP + PANEL_H / 2, 15, 0, T->muted, w - 60, 2);
}

static int over(const struct wj_pointer *pointer, float x, float y, float w, float h) {
    return pointer->valid && pointer->x >= x && pointer->x < x + w && pointer->y >= y && pointer->y < y + h;
}

/* A lit button is a mode that is on: blue face, white glyph. `reach` widens the pointer target. */
static void button(float cx, float cy, float r, float reach, int enabled, int lit, const struct wj_pointer *pointer,
                   enum wj_target target, void (*glyph)(float, float, float, u32)) {
    lit = lit && enabled;
    int hover = enabled && over(pointer, cx - r, cy - r, r * 2, r * 2);
    u32 face_top = lit ? (hover ? wj_gfx_mix(T->blue, WHITE, 0.25f) : T->blue) : hover ? T->select_top : T->key_top;
    u32 face_bottom = lit ? (hover ? T->blue : T->deep_blue) : hover ? T->select_bottom : T->key_bottom;
    wj_gfx_circle(cx, cy + 2, r, T->shadow);
    wj_gfx_round(cx - r, cy - r, r * 2, r * 2, r, face_top, face_bottom);
    wj_gfx_ring(cx, cy, r, 1.5f, lit ? T->deep_blue : hover ? T->blue : T->border);
    glyph(cx, cy, r, !enabled ? T->faint : lit ? T->on_blue : hover ? T->accent : T->ink);
    if (enabled) hit(cx - reach, cy - reach, reach * 2, reach * 2, target, 0);
}

static void round_button(float cx, float cy, float r, int enabled, const struct wj_pointer *pointer,
                         enum wj_target target, void (*glyph)(float, float, float, u32)) {
    button(cx, cy, r, r, enabled, 0, pointer, target, glyph);
}

static void glyph_previous(float cx, float cy, float r, u32 c) {
    float s = r * 0.42f;
    wj_gfx_rect(cx - s, cy - s, s * 0.28f, s * 2, c, c);
    wj_gfx_triangle(cx + s, cy - s, cx + s, cy + s, cx - s * 0.62f, cy, c);
}
static void glyph_next(float cx, float cy, float r, u32 c) {
    float s = r * 0.42f;
    wj_gfx_rect(cx + s * 0.72f, cy - s, s * 0.28f, s * 2, c, c);
    wj_gfx_triangle(cx - s, cy - s, cx + s * 0.62f, cy, cx - s, cy + s, c);
}
static void glyph_play(float cx, float cy, float r, u32 c) {
    float s = r * 0.46f;
    wj_gfx_triangle(cx - s * 0.7f, cy - s, cx + s, cy, cx - s * 0.7f, cy + s, c);
}
static void glyph_pause(float cx, float cy, float r, u32 c) {
    float s = r * 0.42f;
    wj_gfx_round(cx - s, cy - s, s * 0.7f, s * 2, 2, c, c);
    wj_gfx_round(cx + s * 0.3f, cy - s, s * 0.7f, s * 2, 2, c, c);
}
static void glyph_stop(float cx, float cy, float r, u32 c) {
    float s = r * 0.36f;
    wj_gfx_round(cx - s, cy - s, s * 2, s * 2, 3, c, c);
}
static void glyph_back(float cx, float cy, float r, u32 c) {
    float s = r * 0.42f;
    wj_gfx_triangle(cx - s * 1.1f, cy, cx - s * 0.1f, cy - s * 0.9f, cx - s * 0.1f, cy + s * 0.9f, c);
    wj_gfx_round(cx - s * 0.2f, cy - s * 0.3f, s * 1.3f, s * 0.6f, s * 0.2f, c, c);
}
static void glyph_visualizer(float cx, float cy, float r, u32 c) {
    static const float heights[] = { 0.5f, 1.0f, 0.7f, 0.85f };
    float s = r * 0.5f;
    for (int i = 0; i < 4; i++) {
        float h = s * 1.6f * heights[i];
        wj_gfx_round(cx - s + i * s * 0.55f, cy + s * 0.8f - h, s * 0.36f, h, s * 0.12f, c, c);
    }
}

/* A straight line of the given width, as two triangles. */
static void stroke(float x0, float y0, float x1, float y1, float width, u32 c) {
    float dx = x1 - x0, dy = y1 - y0, length = sqrtf(dx * dx + dy * dy);
    if (length < 0.01f) return;
    float nx = -dy / length * width / 2, ny = dx / length * width / 2;
    wj_gfx_triangle(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, c);
    wj_gfx_triangle(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, c);
}

/* Two crossing arrows: the same one drawn rising, then mirrored to fall. */
static void glyph_shuffle(float cx, float cy, float r, u32 c) {
    float s = r * 0.58f, t = r * 0.15f;
    for (int d = -1; d <= 1; d += 2) {
        float low = cy + d * s * 0.55f, high = cy - d * s * 0.55f;
        stroke(cx - s, low, cx - s * 0.35f, low, t, c);
        stroke(cx - s * 0.35f, low, cx + s * 0.3f, high, t, c);
        stroke(cx + s * 0.3f, high, cx + s * 0.55f, high, t, c);
        wj_gfx_circle(cx - s * 0.35f, low, t / 2, c);
        wj_gfx_circle(cx + s * 0.3f, high, t / 2, c);
        wj_gfx_triangle(cx + s * 0.45f, high - s * 0.4f, cx + s * 1.05f, high, cx + s * 0.45f, high + s * 0.4f, c);
    }
}

/* A loop made of two half-turns: up the left, along the top and into an arrow, then the same turned half way round. */
static void glyph_repeat(float cx, float cy, float r, u32 c) {
    float s = r * 0.58f, t = r * 0.15f;
    for (int d = -1; d <= 1; d += 2) {
        float left = cx - d * s, top = cy - d * s * 0.62f, corner = d * s * 0.3f;
        stroke(left, cy + d * s * 0.5f, left, top + corner, t, c);
        stroke(left, top + corner, left + corner, top, t, c);
        stroke(left + corner, top, cx + d * s * 0.4f, top, t, c);
        wj_gfx_triangle(cx + d * s * 0.4f, top - d * s * 0.4f, cx + d * s, top, cx + d * s * 0.4f, top + d * s * 0.4f, c);
    }
}

static void now_playing(const struct wj_session *s, const struct wj_pointer *pointer) {
    float x = L.card_x, w = L.card_w;
    panel(x, TOP, w, PANEL_H, 18);
    float size = w - 40 < 120 ? w - 40 : 120, ax = x + (w - size) / 2, ay = TOP + 14;
    wj_gfx_round(ax, ay + 3, size, size, 12, T->shadow, T->shadow);
    art_x = ax;
    art_y = ay;
    art_size = size;
    if (s->has_art && art.ready) {
        wj_gfx_round_image(&art, ax, ay, size, size, 12, WHITE);
        hit(ax, ay, size, size, WJ_TARGET_ART, 0);
    } else {
        wj_gfx_round(ax, ay, size, size, 12, T->art_top, T->art_bottom);
        icon(ICON_NOTE, ax + size / 2 + 4, ay + size / 2, size * 0.5f, T->art_note, T->art_top);
    }
    wj_gfx_round_line(ax, ay, size, size, 12, 1.5f, T->border);
    int idle = !strcmp(s->state, "idle");
    const char *song = s->song[0] ? s->song : idle ? "Nothing playing" : "";
    label(song, x + w / 2, ay + size + 24, 17, 1, T->ink, w - 24, 1);
    label(s->artist, x + w / 2, ay + size + 42, 14, 0, T->muted, w - 24, 1);

    char state[24];
    snprintf(state, sizeof(state), "%s", s->seek_until ? "Seeking" : s->state);
    if (state[0] >= 'a' && state[0] <= 'z') state[0] -= 'a' - 'A';
    u32 chip = !strcmp(s->state, "playing") ? T->blue : !strcmp(s->state, "paused") ? WJ_RGBA(0xf0, 0xa8, 0x30, 0xff) : T->faint;
    float chip_w = wj_font_measure(state, (int)strlen(state), 12, 1) + 20;
    wj_gfx_round(x + w / 2 - chip_w / 2, ay + size + 50, chip_w, 18, 9, chip, chip);
    label(state, x + w / 2, ay + size + 63, 12, 1, T->on_blue, chip_w, 1);

    // Shuffle and repeat flank the state chip. A mode that is on is lit, repeat-one adds a 1, and a source
    // that cannot use a mode leaves its button gray.
    float my = ay + size + 59, mode_x = 31;
    int can_shuffle = (s->capabilities & WJ_CAN_SHUFFLE) != 0, can_repeat = (s->capabilities & WJ_CAN_REPEAT) != 0;
    button(x + mode_x, my, 12, 14, can_shuffle, s->shuffle, pointer, WJ_TARGET_SHUFFLE, glyph_shuffle);
    button(x + w - mode_x, my, 12, 14, can_repeat, s->repeat != WJ_REPEAT_OFF, pointer, WJ_TARGET_REPEAT, glyph_repeat);
    if (can_repeat && s->repeat == WJ_REPEAT_ONE) {
        float bx = x + w - mode_x + 9, by = my + 9;
        wj_gfx_circle(bx, by, 8, T->key_top);
        wj_gfx_ring(bx, by, 8, 1.5f, T->deep_blue);
        label("1", bx, centered(by, 11), 11, 1, T->accent, 12, 1);
    }

    // Seek bar: blue fill up to the heard position, knob only where seeking works.
    bar_x = x + 20;
    bar_w = w - 40;
    float bar_y = TOP + PANEL_H - 68;
    int duration = s->has_progress ? s->duration_ms : 0;
    int position = s->seek_until ? s->seek_target_ms : s->position_ms;
    int can_seek = (s->capabilities & WJ_CAN_SEEK) && duration > 0;
    int seek_hover = can_seek && over(pointer, bar_x - 8, bar_y - 12, bar_w + 16, 24);
    float fraction = wj_seek_fraction(position, duration);
    wj_gfx_round(bar_x, bar_y - 3, bar_w, 6, 3, T->track, T->track);
    if (duration > 0 && !idle) wj_gfx_round(bar_x, bar_y - 3, bar_w * fraction, 6, 3, T->blue, T->deep_blue);
    int preview = seek_preview;
    if (seek_hover && preview < 0) preview = wj_seek_at(pointer->x, bar_x, bar_w, duration);
    if (can_seek && !idle) {
        float knob = bar_x + bar_w * fraction;
        wj_gfx_circle(knob, bar_y + 1, 8, T->shadow);
        wj_gfx_circle(knob, bar_y, 8, T->knob);
        wj_gfx_ring(knob, bar_y, 8, 2.5f, T->blue);
        if (preview >= 0) {
            char time[16];
            float px = bar_x + bar_w * wj_seek_fraction(preview, duration);
            wj_format_time(time, sizeof(time), preview);
            float tw = wj_font_measure(time, (int)strlen(time), 12, 1) + 14;
            float bx = px - tw / 2 < x + 4 ? x + 4 : px + tw / 2 > x + w - 4 ? x + w - 4 - tw : px - tw / 2;
            wj_gfx_circle(px, bar_y + 1, 8, T->shadow);
            wj_gfx_circle(px, bar_y, 8, T->select_top);
            wj_gfx_ring(px, bar_y, 8, 2.5f, T->deep_blue);
            wj_gfx_round(bx, bar_y - 30, tw, 18, 9, T->deep_blue, T->deep_blue);
            seek_pointer = seek_hover;
            label(time, bx + tw / 2, bar_y - 17, 12, 1, T->on_blue, tw, 1);
        }
        hit(bar_x - 8, bar_y - 12, bar_w + 16, 24, WJ_TARGET_SEEK, 0);
    }
    char elapsed[16], total[16];
    wj_format_time(elapsed, sizeof(elapsed), idle ? 0 : position);
    wj_format_time(total, sizeof(total), duration > 0 ? duration : -1);
    label(elapsed, bar_x, bar_y + 20, 12, 0, T->muted, 80, 0);
    label(duration > 0 || idle ? total : "Live", bar_x + bar_w, bar_y + 20, 12, 0, T->muted, 80, 2);

    float by = TOP + PANEL_H - 30, gap = (w - 32) / 4;
    unsigned c = s->capabilities;
    int paused = !strcmp(s->state, "paused");
    round_button(x + 16 + gap * 0.5f, by, 14, (c & WJ_CAN_PREVIOUS) != 0, pointer, WJ_TARGET_PREVIOUS, glyph_previous);
    round_button(x + 16 + gap * 1.5f, by, 16, (c & (paused ? WJ_CAN_PLAY : WJ_CAN_PAUSE)) != 0, pointer,
                 WJ_TARGET_PAUSE, paused || idle ? glyph_play : glyph_pause);
    round_button(x + 16 + gap * 2.5f, by, 14, (c & WJ_CAN_NEXT) != 0, pointer, WJ_TARGET_NEXT, glyph_next);
    round_button(x + 16 + gap * 3.5f, by, 14, (c & WJ_CAN_STOP) != 0, pointer, WJ_TARGET_STOP, glyph_stop);
}

static void dock(const struct wj_session *s, const struct wj_pointer *pointer) {
    float y = 404;
    // Raised pods at each end, like the Wii Menu's Wii and mail buttons.
    for (int side = 0; side < 2; side++) {
        float cx = side ? L.w - 58 : 58;
        wj_gfx_circle(cx, y + 34, 50, T->border);
        wj_gfx_circle(cx, y + 35, 49, T->dock_top);
    }
    wj_gfx_rect(0, y, L.w, WJ_GFX_HEIGHT - y, T->dock_top, T->dock_bottom);
    wj_gfx_rect(106, y - 1, L.w - 212, 1, T->border, T->border);
    wj_gfx_rect(106, y, L.w - 212, 2, T->dock_edge, T->dock_edge);
    round_button(58, y + 18, 26, s->view != WJ_VIEW_SERVERS, pointer, WJ_TARGET_BACK, glyph_back);
    round_button(L.w - 58, y + 18, 26, 1, pointer, WJ_TARGET_VISUALIZER, glyph_visualizer);
    label("B", 58, y + 64, 12, 1, T->muted, 40, 1);
    label("2", L.w - 58, y + 64, 12, 1, T->muted, 40, 1);

    time_t now = time(NULL);
    struct tm *local = localtime(&now);
    char clock[16], date[32];
    int hour = local->tm_hour % 12 ? local->tm_hour % 12 : 12;
    snprintf(clock, sizeof(clock), "%d:%02d", hour, local->tm_min);
    static const char *days[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    snprintf(date, sizeof(date), "%s %d/%d", days[local->tm_wday], local->tm_mon + 1, local->tm_mday);
    float clock_w = wj_font_measure(clock, (int)strlen(clock), 34, 1);
    label(clock, L.w / 2 - 14, y + 46, 34, 1, T->clock, 200, 1);
    label(local->tm_hour < 12 ? "AM" : "PM", L.w / 2 - 14 + clock_w / 2 + 4, y + 46, 14, 1, T->faint, 40, 0);
    label(date, L.w / 2, y + 66, 13, 0, T->muted, 200, 1);
}

/* The cover grows out of the card over a dimmed screen; A or B closes it. */
static void expanded_art(const struct wj_session *s, long long now) {
    float t = (now - art_changed) / 180.0f;
    if (t > 1) t = 1;
    float ease = 1 - (1 - t) * (1 - t) * (1 - t);
    float open = art_open ? ease : 1 - ease;
    if (open <= 0.01f) return;
    hit_count = 0;
    wj_gfx_rect(0, 0, L.w, WJ_GFX_HEIGHT, WJ_RGBA(0x10, 0x16, 0x1c, (u32)(0xb0 * open)), WJ_RGBA(0x10, 0x16, 0x1c, (u32)(0xc8 * open)));
    float size = 288, x = L.w / 2 - size / 2, y = 36;
    float ix = art_x + (x - art_x) * open, iy = art_y + (y - art_y) * open, is = art_size + (size - art_size) * open;
    const struct wj_image *image = s->has_large_art && large_art.ready ? &large_art : &art;
    wj_gfx_round(ix - 2, iy + 4, is + 4, is + 4, 18, wj_gfx_fade(WJ_RGBA(0, 0, 0, 0x60), open), wj_gfx_fade(WJ_RGBA(0, 0, 0, 0x60), open));
    wj_gfx_round_image(image, ix, iy, is, is, 16, WHITE);
    wj_gfx_round_line(ix, iy, is, is, 16, 2, wj_gfx_fade(WHITE, open * 0.8f));
    u32 text = wj_gfx_fade(WHITE, open), soft = wj_gfx_fade(WJ_RGBA(0xc4, 0xcc, 0xd4, 0xff), open);
    label(s->song, L.w / 2, y + size + 34, 20, 1, text, L.w - 80, 1);
    label(s->artist, L.w / 2, y + size + 58, 15, 0, soft, L.w - 80, 1);
    label("A or B to close", L.w / 2, y + size + 88, 13, 0, wj_gfx_fade(WJ_RGBA(0x8c, 0x96, 0xa0, 0xff), open), 200, 1);
}

static void toast_and_volume(const struct wj_session *s, long long now) {
    // The finding-server panel already shows the whole message.
    if (s->message[0] && !(s->view == WJ_VIEW_SERVERS && !s->count)) {
        snprintf(toast, sizeof(toast), "%s", s->message);
        toast_alpha += (1 - toast_alpha) * 0.25f;
    } else toast_alpha *= 0.85f;
    if (toast_alpha > 0.02f && toast[0]) {
        float w = wj_font_measure(toast, (int)strlen(toast), 14, 0) + 32;
        if (w > L.w - 260) w = L.w - 260;
        float x = L.w / 2 - w / 2, y = 378;
        wj_gfx_round(x, y + 2, w, 24, 12, wj_gfx_fade(T->shadow, toast_alpha), wj_gfx_fade(T->shadow, toast_alpha));
        wj_gfx_round(x, y, w, 24, 12, wj_gfx_fade(T->toast_top, toast_alpha), wj_gfx_fade(T->toast_bottom, toast_alpha));
        label(toast, L.w / 2, y + 17, 14, 0, wj_gfx_fade(T->toast_text, toast_alpha), w - 24, 1);
    }
    if (now - volume_shown < 1500) {
        float alpha = now - volume_shown > 1200 ? (1500 - (now - volume_shown)) / 300.0f : 1;
        float w = 220, x = L.w / 2 - w / 2, y = 14;
        wj_gfx_round(x, y, w, 40, 20, wj_gfx_fade(T->toast_top, alpha), wj_gfx_fade(T->toast_bottom, alpha));
        int level = (s->volume * 10 + 127) / 255;
        for (int i = 0; i < 10; i++)
            wj_gfx_round(x + 62 + i * 14, y + 26 - i * 1.4f, 10, 6 + i * 1.4f, 2,
                         wj_gfx_fade(i < level ? T->blue : T->meter_off, alpha),
                         wj_gfx_fade(i < level ? T->deep_blue : T->meter_off, alpha));
        label("Vol", x + 30, y + 26, 14, 1, wj_gfx_fade(T->toast_text, alpha), 40, 1);
    }
}

static void cursor(const struct wj_pointer *pointer) {
    // Over the seek bar the preview knob, sitting on the track, stands in for the cursor.
    if (!pointer->valid || seek_pointer) return;
    int active = wj_ui_hit(pointer->x, pointer->y).target != WJ_TARGET_NONE;
    wj_gfx_circle(pointer->x + 2, pointer->y + 3, 11, WJ_RGBA(0, 0, 0, 0x30));
    wj_gfx_circle(pointer->x, pointer->y, 11, active ? WJ_RGBA(0xe2, 0xf5, 0xfd, 0xff) : WHITE);
    wj_gfx_ring(pointer->x, pointer->y, 11, active ? 4 : 3, active ? T->deep_blue : T->blue);
    wj_gfx_circle(pointer->x, pointer->y, 2.5f, T->deep_blue);
}

int wj_ui_seek_at(const struct wj_session *s, float x) {
    if (!(s->capabilities & WJ_CAN_SEEK) || !s->has_progress || s->duration_ms <= 0) return -1;
    return wj_seek_at(x, bar_x, bar_w, s->duration_ms);
}

void wj_ui_draw(const struct wj_session *s, const struct wj_pointer *pointer) {
    long long now = wj_milliseconds();
    T = wj_theme(s->dark);
    seek_pointer = 0;
    if (s->selected != last_selected) { last_selected = s->selected; selection_changed = now; }
    if (s->art_version != art_version) {
        art_version = s->art_version;
        if (s->has_art) {
            memcpy(art_texels, wj_session_art(), sizeof(art_texels));
            wj_gfx_image_rgb565(&art, art_texels, WJ_ART_SIZE);
        } else art.ready = 0;
    }
    if (s->large_art_version != large_art_version) {
        large_art_version = s->large_art_version;
        memcpy(large_texels, wj_session_large_art(), sizeof(large_texels));
        wj_gfx_image_rgb565(&large_art, large_texels, WJ_ART_LARGE);
    }
    if (!art.ready) art_open = 0;
    wj_gfx_begin();
    hit_count = 0;
    background();
    header(s, now);
    if (s->view == WJ_VIEW_SERVERS && !s->count) discovery(s, now);
    else if (s->view == WJ_VIEW_BROWSE) list(s, now);
    else tiles(s, now);
    if (s->view != WJ_VIEW_SERVERS) now_playing(s, pointer);
    dock(s, pointer);
    toast_and_volume(s, now);
    if (s->view != WJ_VIEW_SERVERS) expanded_art(s, now);
    cursor(pointer);
    last_view = (int)s->view;
    wj_gfx_present();
}
