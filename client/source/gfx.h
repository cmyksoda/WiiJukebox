// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_GFX_H
#define WJ_GFX_H
#include <gccore.h>

/* Layout units: 480 tall, 640 wide on 4:3 TVs and 854 wide on 16:9 ones. */
#define WJ_GFX_HEIGHT 480.0f
#define WJ_RGBA(r, g, b, a) ((u32)(r) << 24 | (u32)(g) << 16 | (u32)(b) << 8 | (u32)(a))

struct wj_image { GXTexObj object; int ready; };

int wj_gfx_init(void);
GXRModeObj *wj_gfx_mode(void);
float wj_gfx_width(void);
float wj_gfx_scale_x(void);
float wj_gfx_scale_y(void);
/* Reapplies all UI GX state, so it is safe after projectM has drawn. */
void wj_gfx_begin(void);
/* Copies the EFB to the hidden framebuffer and shows it at the next retrace. */
void wj_gfx_present(void);
u32 wj_gfx_fade(u32 color, float alpha);
u32 wj_gfx_mix(u32 a, u32 b, float t);
void wj_gfx_rect(float x, float y, float w, float h, u32 top, u32 bottom);
void wj_gfx_round(float x, float y, float w, float h, float r, u32 top, u32 bottom);
void wj_gfx_round_line(float x, float y, float w, float h, float r, float width, u32 color);
void wj_gfx_circle(float cx, float cy, float r, u32 color);
void wj_gfx_ring(float cx, float cy, float r, float width, u32 color);
void wj_gfx_triangle(float x0, float y0, float x1, float y1, float x2, float y2, u32 color);
void wj_gfx_text(const char *text, int bytes, float x, float baseline, int size, int bold, u32 color);
/* `texels` must be 32-byte aligned GX-tiled RGB565 and stay valid while drawn. */
void wj_gfx_image_rgb565(struct wj_image *image, void *texels, int size);
void wj_gfx_round_image(const struct wj_image *image, float x, float y, float w, float h, float r, u32 tint);
void wj_gfx_clip(float x, float y, float w, float h);
void wj_gfx_unclip(void);
/* Restores the GX defaults projectM's renderer expects before it draws. */
void wj_gfx_prepare_visualizer(void);
#endif
