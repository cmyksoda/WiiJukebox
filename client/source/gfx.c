// SPDX-License-Identifier: GPL-3.0-only
#include "gfx.h"
#include "font.h"
#include <malloc.h>
#include <math.h>
#include <string.h>

#define FIFO_SIZE (256 * 1024)
#define MAX_POINTS 160
#define FEATHER 1.0f

enum mode { MODE_NONE, MODE_SOLID, MODE_IMAGE, MODE_TEXT };

static GXRModeObj *mode;
static void *framebuffers[2];
static void *fifo;
static int current;
static float width = 640, scale_x = 1, scale_y = 1;
static enum mode active;
static const void *bound;
static GXTexObj atlas;
static int atlas_ready;
static float px[MAX_POINTS], py[MAX_POINTS], nx[MAX_POINTS], ny[MAX_POINTS];
static int points;

GXRModeObj *wj_gfx_mode(void) { return mode; }
float wj_gfx_width(void) { return width; }
float wj_gfx_scale_x(void) { return scale_x; }
float wj_gfx_scale_y(void) { return scale_y; }

static void copy_settings(void) {
    f32 yscale = GX_GetYScaleFactor(mode->efbHeight, mode->xfbHeight);
    u32 lines = GX_SetDispCopyYScale(yscale);
    GX_SetDispCopySrc(0, 0, mode->fbWidth, mode->efbHeight);
    GX_SetDispCopyDst(mode->fbWidth, lines);
    GX_SetCopyFilter(mode->aa, mode->sample_pattern, GX_TRUE, mode->vfilter);
    GX_SetFieldMode(mode->field_rendering, mode->viHeight == 2 * mode->xfbHeight ? GX_ENABLE : GX_DISABLE);
    GX_SetDispCopyGamma(GX_GM_1_0);
    GX_SetViewport(0, 0, mode->fbWidth, mode->efbHeight, 0, 1);
    GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
}

int wj_gfx_init(void) {
    mode = VIDEO_GetPreferredMode(NULL);
    // 16:9 sets stretch 640 pixels wider, so lay out on a wider canvas.
    if (CONF_GetAspectRatio() == CONF_ASPECT_16_9) width = 854;
    VIDEO_Configure(mode);
    for (int i = 0; i < 2; i++) {
        void *allocated = SYS_AllocateFramebuffer(mode);
        if (!allocated) return -1;
        framebuffers[i] = MEM_K0_TO_K1(allocated);
        VIDEO_ClearFrameBuffer(mode, framebuffers[i], COLOR_BLACK);
    }
    VIDEO_SetNextFramebuffer(framebuffers[0]);
    VIDEO_SetBlack(false);
    VIDEO_Flush();
    VIDEO_WaitVSync();
    if (mode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();
    fifo = memalign(32, FIFO_SIZE);
    if (!fifo) return -1;
    memset(fifo, 0, FIFO_SIZE);
    GX_Init(fifo, FIFO_SIZE);
    GX_SetCopyClear((GXColor){ 0xee, 0xf0, 0xf3, 0xff }, 0x00ffffff);
    copy_settings();
    scale_x = mode->fbWidth / width;
    scale_y = mode->efbHeight / WJ_GFX_HEIGHT;
    return 0;
}

void wj_gfx_begin(void) {
    Mtx44 projection;
    Mtx identity;
    copy_settings();
    GX_SetPixelFmt(GX_PF_RGB8_Z24, GX_ZC_LINEAR);
    guOrtho(projection, 0, WJ_GFX_HEIGHT, 0, width, 0, 1);
    GX_LoadProjectionMtx(projection, GX_ORTHOGRAPHIC);
    guMtxIdentity(identity);
    GX_LoadPosMtxImm(identity, GX_PNMTX0);
    GX_SetCurrentMtx(GX_PNMTX0);
    GX_ClearVtxDesc();
    GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
    GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
    GX_SetVtxDesc(GX_VA_TEX0, GX_DIRECT);
    GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XY, GX_F32, 0);
    GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
    GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_TEX0, GX_TEX_ST, GX_F32, 0);
    GX_InvVtxCache();
    GX_InvalidateTexAll();
    GX_SetNumChans(1);
    GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_REG, GX_SRC_VTX, GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
    GX_SetNumTexGens(1);
    GX_SetTexCoordGen(GX_TEXCOORD0, GX_TG_MTX2x4, GX_TG_TEX0, GX_IDENTITY);
    GX_SetNumTevStages(1);
    GX_SetNumIndStages(0);
    GX_SetTevDirect(GX_TEVSTAGE0);
    GX_SetTevSwapMode(GX_TEVSTAGE0, GX_TEV_SWAP0, GX_TEV_SWAP0);
    GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORD0, GX_TEXMAP0, GX_COLOR0A0);
    GX_SetBlendMode(GX_BM_BLEND, GX_BL_SRCALPHA, GX_BL_INVSRCALPHA, GX_LO_CLEAR);
    GX_SetAlphaCompare(GX_ALWAYS, 0, GX_AOP_AND, GX_ALWAYS, 0);
    GX_SetZCompLoc(GX_TRUE);
    GX_SetZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
    GX_SetCullMode(GX_CULL_NONE);
    GX_SetColorUpdate(GX_TRUE);
    GX_SetAlphaUpdate(GX_FALSE);
    GX_SetDither(GX_FALSE);
    GX_SetCopyClear((GXColor){ 0xee, 0xf0, 0xf3, 0xff }, 0x00ffffff);
    active = MODE_NONE;
    bound = NULL;
}

void wj_gfx_present(void) {
    current ^= 1;
    GX_CopyDisp(framebuffers[current], GX_TRUE);
    GX_DrawDone();
    VIDEO_SetNextFramebuffer(framebuffers[current]);
    VIDEO_Flush();
}

void wj_gfx_prepare_visualizer(void) {
    GX_DrawDone();
    copy_settings();
    GX_SetPixelFmt(GX_PF_RGBA6_Z24, GX_ZC_LINEAR);
    GX_SetCopyClear((GXColor){ 0, 0, 0, 0xff }, 0x00ffffff);
    GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_REG, GX_SRC_VTX, GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
    GX_SetAlphaCompare(GX_ALWAYS, 0, GX_AOP_AND, GX_ALWAYS, 0);
    GX_SetZCompLoc(GX_TRUE);
    GX_SetTevSwapMode(GX_TEVSTAGE0, GX_TEV_SWAP0, GX_TEV_SWAP0);
    GX_SetTevDirect(GX_TEVSTAGE0);
    GX_SetNumTevStages(1);
    GX_SetNumIndStages(0);
    GX_SetNumChans(1);
    GX_SetDither(GX_TRUE);
    GX_InvVtxCache();
    GX_InvalidateTexAll();
    active = MODE_NONE;
    bound = NULL;
}

static void use(enum mode next, GXTexObj *texture) {
    if (next != active) {
        if (next == MODE_SOLID) GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
        else if (next == MODE_IMAGE) GX_SetTevOp(GX_TEVSTAGE0, GX_MODULATE);
        else {
            // Intensity glyphs give coverage only: color from the vertex, alpha multiplied.
            GX_SetTevColorIn(GX_TEVSTAGE0, GX_CC_ZERO, GX_CC_ZERO, GX_CC_ZERO, GX_CC_RASC);
            GX_SetTevColorOp(GX_TEVSTAGE0, GX_TEV_ADD, GX_TB_ZERO, GX_CS_SCALE_1, GX_TRUE, GX_TEVPREV);
            GX_SetTevAlphaIn(GX_TEVSTAGE0, GX_CA_ZERO, GX_CA_TEXA, GX_CA_RASA, GX_CA_ZERO);
            GX_SetTevAlphaOp(GX_TEVSTAGE0, GX_TEV_ADD, GX_TB_ZERO, GX_CS_SCALE_1, GX_TRUE, GX_TEVPREV);
        }
        active = next;
    }
    if (texture && texture != bound) {
        GX_LoadTexObj(texture, GX_TEXMAP0);
        bound = texture;
    }
}

static inline void vertex(float x, float y, u32 color, float u, float v) {
    GX_Position2f32(x, y);
    GX_Color1u32(color);
    GX_TexCoord2f32(u, v);
}

u32 wj_gfx_fade(u32 color, float alpha) {
    if (alpha <= 0) return color & 0xffffff00;
    if (alpha >= 1) return color;
    return (color & 0xffffff00) | (u32)((color & 0xff) * alpha);
}

u32 wj_gfx_mix(u32 a, u32 b, float t) {
    u32 out = 0;
    for (int shift = 0; shift < 32; shift += 8) {
        float from = (a >> shift) & 0xff, to = (b >> shift) & 0xff;
        out |= (u32)(from + (to - from) * t + 0.5f) << shift;
    }
    return out;
}

void wj_gfx_rect(float x, float y, float w, float h, u32 top, u32 bottom) {
    use(MODE_SOLID, NULL);
    GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
    vertex(x, y, top, 0, 0);
    vertex(x + w, y, top, 0, 0);
    vertex(x + w, y + h, bottom, 0, 0);
    vertex(x, y + h, bottom, 0, 0);
    GX_End();
}

static void add_arc(float cx, float cy, float r, float from, int steps) {
    for (int i = 0; i <= steps && points < MAX_POINTS; i++) {
        float angle = from + (float)M_PI / 2 * i / steps;
        nx[points] = cosf(angle);
        ny[points] = sinf(angle);
        px[points] = cx + nx[points] * r;
        py[points] = cy + ny[points] * r;
        points++;
    }
}

/* Perimeter of a rounded rectangle, clockwise from the top-left arc. */
static void round_path(float x, float y, float w, float h, float r) {
    float limit = (w < h ? w : h) / 2;
    if (r > limit) r = limit;
    if (r < 1) r = 1;
    int steps = r < 4 ? 2 : r < 12 ? 5 : 9;
    points = 0;
    add_arc(x + r, y + r, r, (float)M_PI, steps);
    add_arc(x + w - r, y + r, r, (float)M_PI * 1.5f, steps);
    add_arc(x + w - r, y + h - r, r, 0, steps);
    add_arc(x + r, y + h - r, r, (float)M_PI / 2, steps);
}

static void circle_path(float cx, float cy, float r) {
    int steps = r < 6 ? 4 : r < 20 ? 8 : 14;
    points = 0;
    for (int quarter = 0; quarter < 4; quarter++) add_arc(cx, cy, r, (float)M_PI / 2 * quarter, steps);
}

static u32 shade(float y, float top_y, float height, u32 top, u32 bottom) {
    float t = height > 0 ? (y - top_y) / height : 0;
    return wj_gfx_mix(top, bottom, t < 0 ? 0 : t > 1 ? 1 : t);
}

/* A band between offsets d0 and d1 along the outward normals. */
static void band(float d0, float d1, float top_y, float height, u32 top, u32 bottom, float a0, float a1) {
    use(MODE_SOLID, NULL);
    GX_Begin(GX_TRIANGLESTRIP, GX_VTXFMT0, (points + 1) * 2);
    for (int i = 0; i <= points; i++) {
        int k = i % points;
        float x0 = px[k] + nx[k] * d0, y0 = py[k] + ny[k] * d0;
        float x1 = px[k] + nx[k] * d1, y1 = py[k] + ny[k] * d1;
        u32 c0 = wj_gfx_fade(shade(y0, top_y, height, top, bottom), a0);
        u32 c1 = wj_gfx_fade(shade(y1, top_y, height, top, bottom), a1);
        vertex(x0, y0, c0, 0, 0);
        vertex(x1, y1, c1, 0, 0);
    }
    GX_End();
}

static void fill(float cx, float cy, float top_y, float height, u32 top, u32 bottom) {
    use(MODE_SOLID, NULL);
    GX_Begin(GX_TRIANGLEFAN, GX_VTXFMT0, points + 2);
    vertex(cx, cy, shade(cy, top_y, height, top, bottom), 0, 0);
    for (int i = 0; i <= points; i++) {
        int k = i % points;
        vertex(px[k], py[k], shade(py[k], top_y, height, top, bottom), 0, 0);
    }
    GX_End();
    band(0, FEATHER, top_y, height, top, bottom, 1, 0);
}

void wj_gfx_round(float x, float y, float w, float h, float r, u32 top, u32 bottom) {
    if (w <= 0 || h <= 0) return;
    round_path(x, y, w, h, r);
    fill(x + w / 2, y + h / 2, y, h, top, bottom);
}

void wj_gfx_round_line(float x, float y, float w, float h, float r, float line, u32 color) {
    if (w <= 0 || h <= 0) return;
    round_path(x, y, w, h, r);
    band(-line - FEATHER, -line, y, h, color, color, 0, 1);
    band(-line, 0, y, h, color, color, 1, 1);
    band(0, FEATHER, y, h, color, color, 1, 0);
}

void wj_gfx_circle(float cx, float cy, float r, u32 color) {
    circle_path(cx, cy, r);
    fill(cx, cy, cy - r, 2 * r, color, color);
}

void wj_gfx_ring(float cx, float cy, float r, float line, u32 color) {
    circle_path(cx, cy, r);
    band(-line - FEATHER, -line, cy - r, 2 * r, color, color, 0, 1);
    band(-line, 0, cy - r, 2 * r, color, color, 1, 1);
    band(0, FEATHER, cy - r, 2 * r, color, color, 1, 0);
}

void wj_gfx_triangle(float x0, float y0, float x1, float y1, float x2, float y2, u32 color) {
    use(MODE_SOLID, NULL);
    GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 3);
    vertex(x0, y0, color, 0, 0);
    vertex(x1, y1, color, 0, 0);
    vertex(x2, y2, color, 0, 0);
    GX_End();
}

static void glyph(void *context, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1) {
    u32 color = *(u32 *)context;
    // Snap to framebuffer pixels so 1:1 glyph bitmaps stay crisp.
    float sx = floorf(x0 * scale_x + 0.5f) / scale_x - x0, sy = floorf(y0 * scale_y + 0.5f) / scale_y - y0;
    vertex(x0 + sx, y0 + sy, color, u0, v0);
    vertex(x1 + sx, y0 + sy, color, u1, v0);
    vertex(x1 + sx, y1 + sy, color, u1, v1);
    vertex(x0 + sx, y1 + sy, color, u0, v1);
}

static void emit(void *context, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1) {
    GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
    glyph(context, x0, y0, x1, y1, u0, v0, u1, v1);
    GX_End();
}

void wj_gfx_text(const char *text, int bytes, float x, float baseline, int size, int bold, u32 color) {
    if (!bytes || !(color & 0xff)) return;
    // Rasterize first, so the GPU never reads atlas texels still in the CPU cache.
    wj_font_measure(text, bytes, size, bold);
    int changed;
    unsigned char *texels = (unsigned char *)wj_font_atlas(&changed);
    if (!atlas_ready) {
        GX_InitTexObj(&atlas, texels, WJ_ATLAS_WIDTH, WJ_ATLAS_HEIGHT, GX_TF_I8, GX_CLAMP, GX_CLAMP, GX_FALSE);
        GX_InitTexObjFilterMode(&atlas, GX_LINEAR, GX_LINEAR);
        atlas_ready = 1;
    }
    if (changed) {
        DCFlushRange(texels, WJ_ATLAS_WIDTH * WJ_ATLAS_HEIGHT);
        GX_InvalidateTexAll();
        bound = NULL;
    }
    use(MODE_TEXT, &atlas);
    wj_font_run(text, bytes, size, bold, x, baseline, emit, &color);
}

void wj_gfx_image_rgb565(struct wj_image *image, void *texels, int size) {
    DCFlushRange(texels, size * size * 2);
    GX_InitTexObj(&image->object, texels, size, size, GX_TF_RGB565, GX_CLAMP, GX_CLAMP, GX_FALSE);
    GX_InitTexObjFilterMode(&image->object, GX_LINEAR, GX_LINEAR);
    GX_InvalidateTexAll();
    image->ready = 1;
    bound = NULL;
}

void wj_gfx_image_i8(struct wj_image *image, void *texels, int width, int height) {
    DCFlushRange(texels, width * height);
    GX_InitTexObj(&image->object, texels, width, height, GX_TF_I8, GX_CLAMP, GX_CLAMP, GX_FALSE);
    GX_InitTexObjFilterMode(&image->object, GX_LINEAR, GX_LINEAR);
    GX_InvalidateTexAll();
    image->ready = 1;
    bound = NULL;
}

void wj_gfx_mask(const struct wj_image *image, float x, float y, float w, float h, u32 color) {
    if (!image->ready) return;
    use(MODE_TEXT, (GXTexObj *)&image->object);
    GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
    vertex(x, y, color, 0, 0);
    vertex(x + w, y, color, 1, 0);
    vertex(x + w, y + h, color, 1, 1);
    vertex(x, y + h, color, 0, 1);
    GX_End();
}

void wj_gfx_round_image(const struct wj_image *image, float x, float y, float w, float h, float r, u32 tint) {
    if (!image->ready) return;
    round_path(x, y, w, h, r);
    use(MODE_IMAGE, (GXTexObj *)&image->object);
    GX_Begin(GX_TRIANGLEFAN, GX_VTXFMT0, points + 2);
    vertex(x + w / 2, y + h / 2, tint, 0.5f, 0.5f);
    for (int i = 0; i <= points; i++) {
        int k = i % points;
        vertex(px[k], py[k], tint, (px[k] - x) / w, (py[k] - y) / h);
    }
    GX_End();
    GX_Begin(GX_TRIANGLESTRIP, GX_VTXFMT0, (points + 1) * 2);
    for (int i = 0; i <= points; i++) {
        int k = i % points;
        float u = (px[k] - x) / w, v = (py[k] - y) / h;
        vertex(px[k], py[k], tint, u, v);
        vertex(px[k] + nx[k] * FEATHER, py[k] + ny[k] * FEATHER, tint & 0xffffff00, u, v);
    }
    GX_End();
}

void wj_gfx_clip(float x, float y, float w, float h) {
    int left = (int)(x * scale_x), top = (int)(y * scale_y);
    int right = (int)ceilf((x + w) * scale_x), bottom = (int)ceilf((y + h) * scale_y);
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (right > mode->fbWidth) right = mode->fbWidth;
    if (bottom > mode->efbHeight) bottom = mode->efbHeight;
    GX_SetScissor(left, top, right > left ? right - left : 0, bottom > top ? bottom - top : 0);
}

void wj_gfx_unclip(void) {
    GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
}
