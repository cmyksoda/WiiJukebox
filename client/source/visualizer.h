// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_VISUALIZER_H
#define WJ_VISUALIZER_H
#ifdef __cplusplus
extern "C" {
#endif
/* The visualizer shares the UI's GX FIFO and framebuffers; each entry
   restores projectM's GX state, and the UI restores its own every frame. */
int wj_visualizer_enter(void);
/* `overlay`, when given, draws UI over the finished frame before it is shown. */
int wj_visualizer_render(void (*overlay)(void *), void *context);
void wj_visualizer_leave(void);
void wj_visualizer_shutdown(void);
const char *wj_visualizer_error(void);
/* Preset tour builds only: move through the presets in order, and note the
   current one in sd:/apps/wiijukebox/flagged-presets.txt. */
void wj_visualizer_step(int delta);
void wj_visualizer_flag(void);
#ifdef __cplusplus
}
#endif
#endif
