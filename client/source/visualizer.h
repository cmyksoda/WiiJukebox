// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_VISUALIZER_H
#define WJ_VISUALIZER_H
#ifdef __cplusplus
extern "C" {
#endif
/* The visualizer shares the UI's GX FIFO and framebuffers; each entry
   restores projectM's GX state, and the UI restores its own every frame. */
int wj_visualizer_enter(void);
int wj_visualizer_render(void);
void wj_visualizer_leave(void);
void wj_visualizer_shutdown(void);
const char *wj_visualizer_error(void);
#ifdef __cplusplus
}
#endif
#endif
