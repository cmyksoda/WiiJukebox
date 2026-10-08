// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_UI_H
#define WJ_UI_H
#include "session.h"

/* What a pointer press over the last drawn frame would activate. */
enum wj_target {
    WJ_TARGET_NONE, WJ_TARGET_ITEM, WJ_TARGET_PAGE_PREVIOUS, WJ_TARGET_PAGE_NEXT, WJ_TARGET_BACK,
    WJ_TARGET_VISUALIZER, WJ_TARGET_PREVIOUS, WJ_TARGET_PAUSE, WJ_TARGET_NEXT, WJ_TARGET_STOP,
    WJ_TARGET_SEEK
};

struct wj_pointer { int valid; float x, y; };
struct wj_hit { enum wj_target target; int index; };

/* `logo` is the jukebox mark: 32x48 GX-tiled I8, 32-byte aligned. */
int wj_ui_init(void *logo);
void wj_ui_draw(const struct wj_session *session, const struct wj_pointer *pointer);
struct wj_hit wj_ui_hit(float x, float y);
/* Seek position for a pointer at x, or -1 when the bar cannot seek. */
int wj_ui_seek_at(const struct wj_session *session, float x);
/* A previewed seek position shown on the bar, or -1 for none. */
void wj_ui_seek_preview(int position_ms);
void wj_ui_volume_changed(void);
int wj_ui_grid_columns(enum wj_view view);
#endif
