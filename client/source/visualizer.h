// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_VISUALIZER_H
#define WJ_VISUALIZER_H
#include <gccore.h>
#ifdef __cplusplus
extern "C" {
#endif
int wj_visualizer_enter(GXRModeObj *mode);
int wj_visualizer_render(void);
void wj_visualizer_leave(void *console_framebuffer);
void wj_visualizer_shutdown(void);
const char *wj_visualizer_error(void);
#ifdef __cplusplus
}
#endif
#endif
