// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_UI_H
#define WJ_UI_H
#include "session.h"

/* What a pointer press over the last drawn frame would activate. */
enum wj_target {
    WJ_TARGET_NONE, WJ_TARGET_ITEM, WJ_TARGET_PAGE_PREVIOUS, WJ_TARGET_PAGE_NEXT, WJ_TARGET_BACK,
    WJ_TARGET_VISUALIZER, WJ_TARGET_PREVIOUS, WJ_TARGET_PAUSE, WJ_TARGET_NEXT, WJ_TARGET_STOP,
    WJ_TARGET_SEEK, WJ_TARGET_ART, WJ_TARGET_SHUFFLE, WJ_TARGET_REPEAT,
    WJ_TARGET_ENTER_ADDRESS, WJ_TARGET_HOME_ITEM, WJ_TARGET_HOME_DISMISS, WJ_TARGET_KEY, WJ_TARGET_FORGET
};

/* Equal gaps above and below the panels, wide enough for a toast and its shadow; the dock's date
   then ends inside a CRT's action-safe area (row 456). The header's ink ends at row 46. */
#define WJ_HEADER_INK_BOTTOM 46.0f
#define WJ_PANEL_GAP 30.0f
#define WJ_PANEL_TOP (WJ_HEADER_INK_BOTTOM + WJ_PANEL_GAP)
#define WJ_PANEL_H 290.0f
#define WJ_ROW_H 20.0f
#define WJ_DOCK_VALLEY (WJ_PANEL_TOP + WJ_PANEL_H + WJ_PANEL_GAP)
#define WJ_DOCK_SHOULDER (WJ_DOCK_VALLEY - 24.0f)

struct wj_pointer { int valid; float x, y; };
struct wj_hit { enum wj_target target; int index; };

/* `logo` is the jukebox mark: 32x48 GX-tiled I8, 32-byte aligned. */
int wj_ui_init(void *logo);
void wj_ui_draw(const struct wj_session *session, const struct wj_pointer *pointer);
/* The HOME menu and the numpad register only their own targets, so nothing beneath reacts. */
struct wj_hit wj_ui_hit(float x, float y);
/* The HOME menu over a frame something else (the visualizer) has drawn. */
void wj_ui_draw_overlay(const struct wj_session *session, const struct wj_pointer *pointer);
/* Seek position for a pointer at x, or -1 when the bar cannot seek. */
int wj_ui_seek_at(const struct wj_session *session, float x);
/* A previewed seek position shown on the bar, or -1 for none. */
void wj_ui_seek_preview(int position_ms);
void wj_ui_volume_changed(void);
/* Opens or closes the large cover view over the dimmed screen. */
void wj_ui_show_art(int open);
int wj_ui_art_open(void);
int wj_ui_grid_columns(enum wj_view view);
#endif
