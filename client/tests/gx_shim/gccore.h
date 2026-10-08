// SPDX-License-Identifier: GPL-3.0-only
// Host stand-in for the libogc API used by gfx.c and ui.c; see gx_soft.c.
#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int32_t s32; typedef float f32;
typedef float Mtx[3][4];
typedef float Mtx44[4][4];
typedef struct { u8 r, g, b, a; } GXColor;
typedef struct { const void *data; int width, height, format; } GXTexObj;
typedef struct {
    u32 viTVMode; u16 fbWidth, efbHeight, xfbHeight, viHeight;
    u8 field_rendering, aa, sample_pattern[12][2], vfilter[7];
} GXRModeObj;
enum {
    GX_FALSE, GX_TRUE, GX_DISABLE = 0, GX_ENABLE = 1, GX_ALWAYS = 7, GX_AOP_AND = 0, GX_CLAMP = 0, GX_LINEAR = 1,
    GX_QUADS = 0x80, GX_TRIANGLES = 0x90, GX_TRIANGLESTRIP = 0x98, GX_TRIANGLEFAN = 0xA0,
    GX_PASSCLR = 4, GX_MODULATE = 0, GX_TF_I8 = 1, GX_TF_RGB565 = 4, GX_PF_RGB8_Z24 = 0, GX_PF_RGBA6_Z24 = 1,
    GX_ZC_LINEAR = 0, GX_CC_ZERO = 15, GX_CC_RASC = 10, GX_CA_ZERO = 7, GX_CA_TEXA = 4, GX_CA_RASA = 5,
    GX_TEV_ADD = 0, GX_TB_ZERO = 0, GX_CS_SCALE_1 = 0, GX_TEVPREV = 0, GX_TEVSTAGE0 = 0, GX_TEV_SWAP0 = 0,
    GX_TEXCOORD0 = 0, GX_TEXMAP0 = 0, GX_COLOR0A0 = 4, GX_BM_BLEND = 1, GX_BL_SRCALPHA = 4, GX_BL_INVSRCALPHA = 5,
    GX_LO_CLEAR = 0, GX_CULL_NONE = 0, GX_SRC_REG = 0, GX_SRC_VTX = 1, GX_LIGHTNULL = 0, GX_DF_NONE = 0,
    GX_AF_NONE = 2, GX_TG_MTX2x4 = 1, GX_TG_TEX0 = 4, GX_IDENTITY = 60, GX_GM_1_0 = 0, GX_ORTHOGRAPHIC = 1,
    GX_PNMTX0 = 0, GX_VA_POS = 9, GX_VA_CLR0 = 11, GX_VA_TEX0 = 13, GX_DIRECT = 1, GX_VTXFMT0 = 0,
    GX_POS_XY = 0, GX_F32 = 4, GX_CLR_RGBA = 1, GX_RGBA8 = 5, GX_TEX_ST = 1,
    CONF_ASPECT_4_3 = 0, CONF_ASPECT_16_9 = 1, VI_NON_INTERLACE = 0, COLOR_BLACK = 0x00800080
};
#define MEM_K0_TO_K1(x) (x)
#define ATTRIBUTE_ALIGN(n) __attribute__((aligned(n)))
GXRModeObj *VIDEO_GetPreferredMode(void *unused);
void VIDEO_Configure(GXRModeObj *mode);
void *SYS_AllocateFramebuffer(GXRModeObj *mode);
void VIDEO_ClearFrameBuffer(GXRModeObj *mode, void *fb, u32 color);
void VIDEO_SetNextFramebuffer(void *fb);
void VIDEO_SetBlack(bool black);
void VIDEO_Flush(void);
void VIDEO_WaitVSync(void);
s32 CONF_GetAspectRatio(void);
void DCFlushRange(void *start, u32 size);
void guOrtho(Mtx44 mt, f32 t, f32 b, f32 l, f32 r, f32 n, f32 f);
void guMtxIdentity(Mtx mt);
void GX_Init(void *fifo, u32 size);
f32 GX_GetYScaleFactor(u16 efb, u16 xfb);
u32 GX_SetDispCopyYScale(f32 scale);
void GX_SetDispCopySrc(u16 l, u16 t, u16 w, u16 h);
void GX_SetDispCopyDst(u16 w, u16 h);
void GX_SetCopyFilter(u8 aa, u8 pattern[12][2], u8 vf, u8 filter[7]);
void GX_SetFieldMode(u8 field, u8 half);
void GX_SetDispCopyGamma(u8 gamma);
void GX_SetViewport(f32 x, f32 y, f32 w, f32 h, f32 n, f32 f);
void GX_SetScissor(u32 x, u32 y, u32 w, u32 h);
void GX_SetCopyClear(GXColor color, u32 z);
void GX_SetPixelFmt(u8 pix, u8 z);
void GX_LoadProjectionMtx(Mtx44 mt, u8 type);
void GX_LoadPosMtxImm(Mtx mt, u32 index);
void GX_SetCurrentMtx(u32 index);
void GX_ClearVtxDesc(void);
void GX_SetVtxDesc(u8 attr, u8 type);
void GX_SetVtxAttrFmt(u8 fmt, u32 attr, u32 comp, u32 type, u32 frac);
void GX_InvVtxCache(void);
void GX_InvalidateTexAll(void);
void GX_SetNumChans(u8 n);
void GX_SetChanCtrl(s32 c, u8 e, u8 a, u8 m, u8 l, u8 d, u8 at);
void GX_SetNumTexGens(u32 n);
void GX_SetTexCoordGen(u16 c, u32 t, u32 s, u32 m);
void GX_SetNumTevStages(u8 n);
void GX_SetNumIndStages(u8 n);
void GX_SetTevDirect(u8 stage);
void GX_SetTevSwapMode(u8 stage, u8 r, u8 t);
void GX_SetTevOrder(u8 stage, u8 c, u32 m, u8 col);
void GX_SetBlendMode(u8 type, u8 src, u8 dst, u8 op);
void GX_SetAlphaCompare(u8 c0, u8 r0, u8 op, u8 c1, u8 r1);
void GX_SetZCompLoc(u8 before);
void GX_SetZMode(u8 e, u8 f, u8 u);
void GX_SetCullMode(u8 mode);
void GX_SetColorUpdate(u8 e);
void GX_SetAlphaUpdate(u8 e);
void GX_SetDither(u8 e);
void GX_DrawDone(void);
void GX_CopyDisp(void *dest, u8 clear);
void GX_SetTevOp(u8 stage, u8 mode);
void GX_SetTevColorIn(u8 s, u8 a, u8 b, u8 c, u8 d);
void GX_SetTevColorOp(u8 s, u8 op, u8 bias, u8 scale, u8 clamp, u8 reg);
void GX_SetTevAlphaIn(u8 s, u8 a, u8 b, u8 c, u8 d);
void GX_SetTevAlphaOp(u8 s, u8 op, u8 bias, u8 scale, u8 clamp, u8 reg);
void GX_InitTexObj(GXTexObj *obj, void *data, u16 w, u16 h, u8 fmt, u8 ws, u8 wt, u8 mip);
void GX_InitTexObjFilterMode(GXTexObj *obj, u8 min, u8 mag);
void GX_LoadTexObj(GXTexObj *obj, u8 map);
void GX_Begin(u8 primitive, u8 fmt, u16 count);
void GX_Position2f32(f32 x, f32 y);
void GX_Color1u32(u32 color);
void GX_TexCoord2f32(f32 s, f32 t);
void GX_End(void);
