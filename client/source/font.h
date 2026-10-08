// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_FONT_H
#define WJ_FONT_H

#define WJ_ATLAS_WIDTH 1024
#define WJ_ATLAS_HEIGHT 512

/* Receives one glyph quad in layout units plus its atlas texture coordinates. */
typedef void (*wj_glyph_sink)(void *context, float x0, float y0, float x1, float y1,
                              float u0, float v0, float u1, float v1);

/* scale_x/scale_y are framebuffer pixels per layout unit, so glyphs are
   rasterized at the size they appear on screen (widescreen squeezes x).
   Code points missing from the primary face come from the fallback face. */
int wj_font_init(const void *data, long size, const void *fallback, long fallback_size,
                 float scale_x, float scale_y);
void wj_font_shutdown(void);
float wj_font_measure(const char *text, int bytes, int size, int bold);
/* Emits quads for `bytes` of `text` from x along `baseline`; returns the pen x. */
float wj_font_run(const char *text, int bytes, int size, int bold, float x, float baseline,
                  wj_glyph_sink sink, void *context);
/* I8 texels in GX 8x4 tiles; *changed reports (and clears) pending updates. */
const unsigned char *wj_font_atlas(int *changed);
/* Counters for tests: glyphs rasterized and atlas resets since init. */
void wj_font_stats(int *rendered, int *resets);
#endif
