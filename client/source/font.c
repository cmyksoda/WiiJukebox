// SPDX-License-Identifier: GPL-3.0-only
#include "font.h"
#include "utf8.h"
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include <math.h>
#include <string.h>
#ifdef GEKKO
#include <malloc.h>
#else
#include <stdlib.h>
#define memalign(alignment, size) aligned_alloc(alignment, size)
#endif

#define GLYPHS 2048
#define SLOTS 4096
#define PAD 1

struct glyph { unsigned code, index; short size, bold, face, x, y, w, h, left, top; float advance; };

static FT_Library library;
static FT_Face faces[WJ_FONT_FACES];
static int face_sizes[WJ_FONT_FACES];
static float scale_x = 1, scale_y = 1;
static unsigned char *atlas;
static struct glyph glyphs[GLYPHS];
static short slots[SLOTS];
static int glyph_count, shelf_x, shelf_y, shelf_h, atlas_changed;
static int rendered, resets;
static void (*reset_hook)(void);

static void reset_atlas(void) {
    memset(atlas, 0, WJ_ATLAS_WIDTH * WJ_ATLAS_HEIGHT);
    memset(slots, -1, sizeof(slots));
    glyph_count = shelf_x = shelf_y = shelf_h = 0;
    atlas_changed = 1;
}

int wj_font_init(const struct wj_font_face *list, int count, float sx, float sy) {
    scale_x = sx;
    scale_y = sy;
    memset(face_sizes, 0, sizeof(face_sizes));
    if (!atlas) atlas = memalign(32, WJ_ATLAS_WIDTH * WJ_ATLAS_HEIGHT);
    if (!atlas || count < 1 || FT_Init_FreeType(&library)) return -1;
    for (int i = 0; i < count && i < WJ_FONT_FACES; i++) {
        if (FT_New_Memory_Face(library, list[i].data, list[i].size, 0, &faces[i])) {
            faces[i] = NULL;
            if (!i) return -1;
        }
    }
    reset_atlas();
    rendered = resets = 0;
    return 0;
}

void wj_font_shutdown(void) {
    for (int i = 0; i < WJ_FONT_FACES; i++) {
        if (faces[i]) FT_Done_Face(faces[i]);
        faces[i] = NULL;
    }
    if (library) FT_Done_FreeType(library);
    library = NULL;
}

void wj_font_set_reset_hook(void (*hook)(void)) { reset_hook = hook; }

static FT_Face set_size(int which, int size) {
    if (size != face_sizes[which]) {
        FT_Set_Char_Size(faces[which], (FT_F26Dot6)(size * 64 * scale_x), (FT_F26Dot6)(size * 64 * scale_y), 72, 72);
        face_sizes[which] = size;
    }
    return faces[which];
}

static void put_pixel(int x, int y, unsigned char value) {
    int tile = (y / 4) * (WJ_ATLAS_WIDTH / 8) + x / 8;
    atlas[tile * 32 + (y % 4) * 8 + x % 8] = value;
}

static struct glyph *rasterize(unsigned code, int size, int bold) {
    int which = 0;
    unsigned index = 0;
    for (int i = 0; i < WJ_FONT_FACES && !index; i++)
        if (faces[i] && (index = FT_Get_Char_Index(faces[i], code))) which = i;
    FT_Face face = set_size(which, size);
    // Light hinting snaps only vertically, keeping each letter at its designed width.
    if (FT_Load_Glyph(face, index, FT_LOAD_NO_BITMAP | FT_LOAD_TARGET_LIGHT)) return NULL;
    FT_GlyphSlot slot = face->glyph;
    FT_Pos strength = bold ? FT_MulFix(face->units_per_EM, face->size->metrics.y_scale) / 28 : 0;
    if (bold && slot->format == FT_GLYPH_FORMAT_OUTLINE) FT_Outline_Embolden(&slot->outline, strength);
    if (FT_Render_Glyph(slot, FT_RENDER_MODE_NORMAL)) return NULL;
    FT_Bitmap *bitmap = &slot->bitmap;
    int w = (int)bitmap->width, h = (int)bitmap->rows;
    if (shelf_x + w + PAD > WJ_ATLAS_WIDTH) { shelf_x = 0; shelf_y += shelf_h + PAD; shelf_h = 0; }
    if (shelf_y + h + PAD > WJ_ATLAS_HEIGHT || glyph_count == GLYPHS) {
        if (reset_hook) reset_hook();
        reset_atlas();
        resets++;
    }
    struct glyph *g = &glyphs[glyph_count++];
    *g = (struct glyph){ code, index, (short)size, (short)bold, (short)which, (short)shelf_x, (short)shelf_y,
                         (short)w, (short)h, (short)slot->bitmap_left, (short)slot->bitmap_top,
                         (slot->linearHoriAdvance / 65536.0f + strength / 64.0f) / scale_x };
    for (int y = 0; y < h; y++) {
        const unsigned char *row = bitmap->buffer + y * bitmap->pitch;
        for (int x = 0; x < w; x++) put_pixel(shelf_x + x, shelf_y + y, row[x]);
    }
    shelf_x += w + PAD;
    if (h > shelf_h) shelf_h = h;
    atlas_changed = 1;
    rendered++;
    return g;
}

static struct glyph *lookup(unsigned code, int size, int bold) {
    unsigned hash = (code * 2654435761u) ^ (unsigned)(size * 31 + bold);
    for (int probe = 0; probe < SLOTS; probe++) {
        int slot = (int)((hash + (unsigned)probe) % SLOTS);
        if (slots[slot] < 0) break;
        struct glyph *g = &glyphs[slots[slot]];
        if (g->code == code && g->size == size && g->bold == bold) return g;
    }
    // Rasterizing can reset the atlas and table, so probe again to insert.
    struct glyph *g = rasterize(code, size, bold);
    for (int probe = 0; g && probe < SLOTS; probe++) {
        int slot = (int)((hash + (unsigned)probe) % SLOTS);
        if (slots[slot] < 0) { slots[slot] = (short)(g - glyphs); break; }
    }
    return g;
}

static unsigned visible(unsigned code) {
    if (code == '\t') return ' ';
    return code < 0x20 || (code >= 0x7F && code < 0xA0) ? 0 : code;
}

float wj_font_run(const char *text, int bytes, int size, int bold, float x, float baseline,
                  wj_glyph_sink sink, void *context) {
    if (!faces[0]) return x;
    struct glyph *previous = NULL;
    for (const char *end = text + bytes; text < end;) {
        unsigned code = visible(wj_utf8_next(&text));
        if (!code) continue;
        struct glyph *g = lookup(code, size, bold);
        if (!g) continue;
        if (previous && previous->face == g->face && FT_HAS_KERNING(faces[g->face])) {
            FT_Vector kern;
            FT_Face face = set_size(g->face, size);
            if (!FT_Get_Kerning(face, previous->index, g->index, FT_KERNING_UNFITTED, &kern))
                x += kern.x / 64.0f / scale_x;
        }
        previous = g;
        if (sink && g->w && g->h) {
            // The pen keeps fractional advances; each bitmap lands on a whole pixel to stay sharp.
            float x0 = (roundf(x * scale_x) + g->left) / scale_x, y0 = baseline - g->top / scale_y;
            sink(context, x0, y0, x0 + g->w / scale_x, y0 + g->h / scale_y,
                 (float)g->x / WJ_ATLAS_WIDTH, (float)g->y / WJ_ATLAS_HEIGHT,
                 (float)(g->x + g->w) / WJ_ATLAS_WIDTH, (float)(g->y + g->h) / WJ_ATLAS_HEIGHT);
        }
        x += g->advance;
    }
    return x;
}

float wj_font_measure(const char *text, int bytes, int size, int bold) {
    return wj_font_run(text, bytes, size, bold, 0, 0, NULL, NULL);
}

void wj_font_prepare(const char *text, int bytes, int size, int bold) {
    int before = resets;
    wj_font_measure(text, bytes, size, bold);
    // A reset partway through dropped the glyphs cached before it.
    if (resets != before) wj_font_measure(text, bytes, size, bold);
}

const unsigned char *wj_font_atlas(int *changed) {
    if (changed) *changed = atlas_changed;
    atlas_changed = 0;
    return atlas;
}

void wj_font_stats(int *glyphs_rendered, int *atlas_resets) {
    *glyphs_rendered = rendered;
    *atlas_resets = resets;
}
