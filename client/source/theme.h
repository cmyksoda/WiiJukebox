// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_THEME_H
#define WJ_THEME_H
#include "gfx.h"

/* The colors that change between the light and dark looks. The visualizer, the
   dimmed cover view and the status-dot colors are the same in both. */
struct wj_theme {
    u32 bg_top, bg_bottom, stripe;
    u32 panel_top, panel_bottom, border, shadow;
    u32 ink, muted, faint;
    /* `accent` is blue as text or a glyph; `on_blue` is what sits on a blue fill. */
    u32 blue, deep_blue, accent, on_blue;
    u32 select_top, select_bottom;
    u32 tile_top, tile_bottom;
    u32 key_top, key_bottom, disabled;
    u32 track, knob;
    u32 dock_top, dock_bottom, dock_edge;
    u32 art_top, art_bottom, art_note;
    u32 clock, icon_gray, warn_fill, danger;
    u32 toast_top, toast_bottom, toast_text, meter_off;
};

const struct wj_theme *wj_theme(int dark);
#endif
