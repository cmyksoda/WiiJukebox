// SPDX-License-Identifier: GPL-3.0-only
// A small software stand-in for the GX calls gfx.c makes, so the real UI code
// can be rendered on the host. It approximates GX; it is not an emulator.
#include "gccore.h"
#include "gx_soft.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define W 640
#define H 480
enum mode { SOLID, IMAGE, TEXT };

static GXRModeObj mode = { 0, W, H, H, H, 0, 0, {{0}}, {0} };
static float efb[H][W][3], frame[H][W][3];
static GXColor clear = { 0, 0, 0, 255 };
static float top, bottom, left, right, view_w = W, view_h = H;
static int sx0, sy0, sx1 = W, sy1 = H;
static enum mode tev = SOLID;
static const GXTexObj *texture;
static int aspect = CONF_ASPECT_4_3;
static struct vertex { float x, y, c[4], u, v; } vertices[512];
static int count, primitive, frames;

void gx_soft_set_aspect(int widescreen) { aspect = widescreen ? CONF_ASPECT_16_9 : CONF_ASPECT_4_3; }
int gx_soft_frames(void) { return frames; }

void gx_soft_frame(unsigned char *rgb) {
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++)
            for (int k = 0; k < 3; k++) rgb[(y * W + x) * 3 + k] = (unsigned char)(frame[y][x][k] * 255 + 0.5f);
}

GXRModeObj *VIDEO_GetPreferredMode(void *unused) { (void)unused; return &mode; }
void VIDEO_Configure(GXRModeObj *m) { (void)m; }
void *SYS_AllocateFramebuffer(GXRModeObj *m) { (void)m; return malloc(W * H * 2); }
void VIDEO_ClearFrameBuffer(GXRModeObj *m, void *fb, u32 color) { (void)m; (void)fb; (void)color; }
void VIDEO_SetNextFramebuffer(void *fb) { (void)fb; }
void VIDEO_SetBlack(bool black) { (void)black; }
void VIDEO_Flush(void) {}
void VIDEO_WaitVSync(void) {}
s32 CONF_GetAspectRatio(void) { return aspect; }
void DCFlushRange(void *start, u32 size) { (void)start; (void)size; }

void guOrtho(Mtx44 mt, f32 t, f32 b, f32 l, f32 r, f32 n, f32 f) {
    (void)n; (void)f;
    memset(mt, 0, sizeof(Mtx44));
    mt[0][0] = t; mt[0][1] = b; mt[0][2] = l; mt[0][3] = r;
}
void guMtxIdentity(Mtx mt) { memset(mt, 0, sizeof(Mtx)); }
void GX_LoadProjectionMtx(Mtx44 mt, u8 type) { (void)type; top = mt[0][0]; bottom = mt[0][1]; left = mt[0][2]; right = mt[0][3]; }
void GX_SetViewport(f32 x, f32 y, f32 w, f32 h, f32 n, f32 f) { (void)x; (void)y; (void)n; (void)f; view_w = w; view_h = h; }
void GX_SetScissor(u32 x, u32 y, u32 w, u32 h) { sx0 = (int)x; sy0 = (int)y; sx1 = (int)(x + w); sy1 = (int)(y + h); }
void GX_SetCopyClear(GXColor color, u32 z) { (void)z; clear = color; }
void GX_SetTevOp(u8 stage, u8 m) { (void)stage; tev = m == GX_PASSCLR ? SOLID : IMAGE; }
void GX_SetTevColorIn(u8 s, u8 a, u8 b, u8 c, u8 d) { (void)s; (void)a; (void)b; (void)c; if (d == GX_CC_RASC) tev = TEXT; }
void GX_InitTexObj(GXTexObj *obj, void *data, u16 w, u16 h, u8 fmt, u8 ws, u8 wt, u8 mip) {
    (void)ws; (void)wt; (void)mip;
    obj->data = data; obj->width = w; obj->height = h; obj->format = fmt;
}
void GX_LoadTexObj(GXTexObj *obj, u8 map) { (void)map; texture = obj; }

void GX_CopyDisp(void *dest, u8 do_clear) {
    (void)dest;
    memcpy(frame, efb, sizeof(efb));
    frames++;
    if (!do_clear) return;
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            efb[y][x][0] = clear.r / 255.0f; efb[y][x][1] = clear.g / 255.0f; efb[y][x][2] = clear.b / 255.0f;
        }
}

static void texel(int x, int y, float out[4]) {
    const GXTexObj *t = texture;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= t->width) x = t->width - 1;
    if (y >= t->height) y = t->height - 1;
    const unsigned char *data = t->data;
    if (t->format == GX_TF_I8) {
        float i = data[((y / 4) * (t->width / 8) + x / 8) * 32 + (y % 4) * 8 + x % 8] / 255.0f;
        out[0] = out[1] = out[2] = out[3] = i;
    } else {
        const unsigned char *p = data + ((y / 4) * (t->width / 4) + x / 4) * 32 + ((y % 4) * 4 + x % 4) * 2;
        unsigned v = (unsigned)p[0] << 8 | p[1];
        out[0] = ((v >> 11) & 31) / 31.0f; out[1] = ((v >> 5) & 63) / 63.0f; out[2] = (v & 31) / 31.0f; out[3] = 1;
    }
}

static void sample(float u, float v, float out[4]) {
    float x = u * texture->width - 0.5f, y = v * texture->height - 0.5f;
    int x0 = (int)floorf(x), y0 = (int)floorf(y);
    float fx = x - x0, fy = y - y0, a[4], b[4], c[4], d[4];
    texel(x0, y0, a); texel(x0 + 1, y0, b); texel(x0, y0 + 1, c); texel(x0 + 1, y0 + 1, d);
    for (int k = 0; k < 4; k++) out[k] = (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy;
}

static float edge(const struct vertex *a, const struct vertex *b, float x, float y) {
    return (b->x - a->x) * (y - a->y) - (b->y - a->y) * (x - a->x);
}

static void triangle(struct vertex a, struct vertex b, struct vertex c) {
    float area = edge(&a, &b, c.x, c.y);
    if (fabsf(area) < 1e-6f) return;
    int x0 = (int)floorf(fminf(a.x, fminf(b.x, c.x))), x1 = (int)ceilf(fmaxf(a.x, fmaxf(b.x, c.x)));
    int y0 = (int)floorf(fminf(a.y, fminf(b.y, c.y))), y1 = (int)ceilf(fmaxf(a.y, fmaxf(b.y, c.y)));
    if (x0 < sx0) x0 = sx0;
    if (y0 < sy0) y0 = sy0;
    if (x1 > sx1) x1 = sx1;
    if (y1 > sy1) y1 = sy1;
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            float px = x + 0.5f, py = y + 0.5f;
            float wa = edge(&b, &c, px, py) / area, wb = edge(&c, &a, px, py) / area, wc = edge(&a, &b, px, py) / area;
            if (wa < 0 || wb < 0 || wc < 0) continue;
            float color[4], t[4] = { 1, 1, 1, 1 };
            for (int k = 0; k < 4; k++) color[k] = (a.c[k] * wa + b.c[k] * wb + c.c[k] * wc) / 255.0f;
            if (tev != SOLID && texture) sample(a.u * wa + b.u * wb + c.u * wc, a.v * wa + b.v * wb + c.v * wc, t);
            if (tev == IMAGE) for (int k = 0; k < 4; k++) color[k] *= t[k];
            else if (tev == TEXT) color[3] *= t[3];
            for (int k = 0; k < 3; k++) efb[y][x][k] = color[k] * color[3] + efb[y][x][k] * (1 - color[3]);
        }
    }
}

void GX_Begin(u8 p, u8 fmt, u16 n) { (void)fmt; (void)n; primitive = p; count = 0; }
void GX_Position2f32(f32 x, f32 y) {
    struct vertex *v = &vertices[count < 511 ? count++ : count];
    v->x = (x - left) / (right - left) * view_w;
    v->y = (y - top) / (bottom - top) * view_h;
}
void GX_Color1u32(u32 c) {
    struct vertex *v = &vertices[count - 1];
    v->c[0] = (float)(c >> 24); v->c[1] = (float)(c >> 16 & 255); v->c[2] = (float)(c >> 8 & 255); v->c[3] = (float)(c & 255);
}
void GX_TexCoord2f32(f32 s, f32 t) { vertices[count - 1].u = s; vertices[count - 1].v = t; }
void GX_End(void) {
    if (primitive == GX_QUADS)
        for (int i = 0; i + 3 < count; i += 4) { triangle(vertices[i], vertices[i + 1], vertices[i + 2]); triangle(vertices[i], vertices[i + 2], vertices[i + 3]); }
    else if (primitive == GX_TRIANGLES)
        for (int i = 0; i + 2 < count; i += 3) triangle(vertices[i], vertices[i + 1], vertices[i + 2]);
    else if (primitive == GX_TRIANGLESTRIP)
        for (int i = 0; i + 2 < count; i++) triangle(vertices[i], vertices[i + 1], vertices[i + 2]);
    else if (primitive == GX_TRIANGLEFAN)
        for (int i = 1; i + 1 < count; i++) triangle(vertices[0], vertices[i], vertices[i + 1]);
}

/* State the software path does not need to model. */
void GX_Init(void *fifo, u32 size) { (void)fifo; (void)size; }
f32 GX_GetYScaleFactor(u16 efb_h, u16 xfb) { (void)efb_h; (void)xfb; return 1; }
u32 GX_SetDispCopyYScale(f32 scale) { (void)scale; return H; }
void GX_SetDispCopySrc(u16 l, u16 t, u16 w, u16 h) { (void)l; (void)t; (void)w; (void)h; }
void GX_SetDispCopyDst(u16 w, u16 h) { (void)w; (void)h; }
void GX_SetCopyFilter(u8 aa, u8 pattern[12][2], u8 vf, u8 filter[7]) { (void)aa; (void)pattern; (void)vf; (void)filter; }
void GX_SetFieldMode(u8 field, u8 half) { (void)field; (void)half; }
void GX_SetDispCopyGamma(u8 gamma) { (void)gamma; }
void GX_SetPixelFmt(u8 pix, u8 z) { (void)pix; (void)z; }
void GX_LoadPosMtxImm(Mtx mt, u32 index) { (void)mt; (void)index; }
void GX_SetCurrentMtx(u32 index) { (void)index; }
void GX_ClearVtxDesc(void) {}
void GX_SetVtxDesc(u8 attr, u8 type) { (void)attr; (void)type; }
void GX_SetVtxAttrFmt(u8 fmt, u32 attr, u32 comp, u32 type, u32 frac) { (void)fmt; (void)attr; (void)comp; (void)type; (void)frac; }
void GX_InvVtxCache(void) {}
void GX_InvalidateTexAll(void) {}
void GX_SetNumChans(u8 n) { (void)n; }
void GX_SetChanCtrl(s32 c, u8 e, u8 a, u8 m, u8 l, u8 d, u8 at) { (void)c; (void)e; (void)a; (void)m; (void)l; (void)d; (void)at; }
void GX_SetNumTexGens(u32 n) { (void)n; }
void GX_SetTexCoordGen(u16 c, u32 t, u32 s, u32 m) { (void)c; (void)t; (void)s; (void)m; }
void GX_SetNumTevStages(u8 n) { (void)n; }
void GX_SetNumIndStages(u8 n) { (void)n; }
void GX_SetTevDirect(u8 stage) { (void)stage; }
void GX_SetTevSwapMode(u8 stage, u8 r, u8 t) { (void)stage; (void)r; (void)t; }
void GX_SetTevOrder(u8 stage, u8 c, u32 m, u8 col) { (void)stage; (void)c; (void)m; (void)col; }
void GX_SetBlendMode(u8 type, u8 src, u8 dst, u8 op) { (void)type; (void)src; (void)dst; (void)op; }
void GX_SetAlphaCompare(u8 c0, u8 r0, u8 op, u8 c1, u8 r1) { (void)c0; (void)r0; (void)op; (void)c1; (void)r1; }
void GX_SetZCompLoc(u8 before) { (void)before; }
void GX_SetZMode(u8 e, u8 f, u8 u) { (void)e; (void)f; (void)u; }
void GX_SetCullMode(u8 m) { (void)m; }
void GX_SetColorUpdate(u8 e) { (void)e; }
void GX_SetAlphaUpdate(u8 e) { (void)e; }
void GX_SetDither(u8 e) { (void)e; }
void GX_DrawDone(void) {}
void GX_SetTevColorOp(u8 s, u8 op, u8 bias, u8 scale, u8 clamp, u8 reg) { (void)s; (void)op; (void)bias; (void)scale; (void)clamp; (void)reg; }
void GX_SetTevAlphaIn(u8 s, u8 a, u8 b, u8 c, u8 d) { (void)s; (void)a; (void)b; (void)c; (void)d; }
void GX_SetTevAlphaOp(u8 s, u8 op, u8 bias, u8 scale, u8 clamp, u8 reg) { (void)s; (void)op; (void)bias; (void)scale; (void)clamp; (void)reg; }
void GX_InitTexObjFilterMode(GXTexObj *obj, u8 min, u8 mag) { (void)obj; (void)min; (void)mag; }
