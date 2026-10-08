// SPDX-License-Identifier: GPL-3.0-only
#include <gccore.h>
#include <wiiuse/wpad.h>
#include <asndlib.h>
#include <mp3player.h>
#include <string.h>
#include "net.h"
#include "gfx.h"
#include "font.h"
#include "layout.h"
#include "session.h"
#include "ui.h"
#include "pcm_snapshot.h"
#include "visualizer.h"

#define SEEK_STEP_MS 10000
#define SEEK_SETTLE_MS 900

extern const unsigned char wj_font_latin[], wj_font_latin_end[], wj_font_greek[], wj_font_greek_end[],
    wj_font_cjk[], wj_font_cjk_end[], wj_logo_mark[];

static int visualizer, pcm_available;

static void toggle_visualizer(void) {
    if (visualizer) {
        wj_visualizer_leave();
        visualizer = 0;
    } else if (!pcm_available) {
        wj_session_set_message("Could not initialize visualizer audio tap");
    } else if (!wj_visualizer_enter()) {
        visualizer = 1;
    } else {
        wj_visualizer_leave();
        wj_session_set_message(wj_visualizer_error());
    }
}

static enum wj_action target_action(enum wj_target target) {
    switch (target) {
    case WJ_TARGET_ITEM: return WJ_ACT_OPEN;
    case WJ_TARGET_PAGE_PREVIOUS: return WJ_ACT_PAGE_PREVIOUS;
    case WJ_TARGET_PAGE_NEXT: return WJ_ACT_PAGE_NEXT;
    case WJ_TARGET_BACK: return WJ_ACT_BACK;
    case WJ_TARGET_PREVIOUS: return WJ_ACT_PREVIOUS;
    case WJ_TARGET_PAUSE: return WJ_ACT_PAUSE;
    case WJ_TARGET_NEXT: return WJ_ACT_NEXT;
    case WJ_TARGET_STOP: return WJ_ACT_STOP;
    default: return WJ_ACT_NONE;
    }
}

/* D-pad movement: lists wrap and page; channel grids move in two dimensions. */
static void move(const struct wj_session *s, u32 down) {
    int grid = s->view != WJ_VIEW_BROWSE;
    int columns = wj_ui_grid_columns(s->view);
    int dy = (down & WPAD_BUTTON_DOWN ? 1 : 0) - (down & WPAD_BUTTON_UP ? 1 : 0);
    int dx = (down & WPAD_BUTTON_RIGHT ? 1 : 0) - (down & WPAD_BUTTON_LEFT ? 1 : 0);
    if (grid) {
        if (dx || dy) wj_session_select(wj_grid_move(s->selected, s->count, columns, dx, dy));
        return;
    }
    if (dy) wj_session_move(dy);
    if (dx) wj_session_act(dx > 0 ? WJ_ACT_PAGE_NEXT : WJ_ACT_PAGE_PREVIOUS, 0);
}

int main(int argc, char **argv) {
    VIDEO_Init();
    WPAD_Init();
    PAD_Init();
    if (wj_gfx_init()) return 1;
    WPAD_SetDataFormat(WPAD_CHAN_0, WPAD_FMT_BTNS_ACC_IR);
    WPAD_SetVRes(WPAD_CHAN_0, (u32)wj_gfx_width(), (u32)WJ_GFX_HEIGHT);
    const struct wj_font_face faces[] = {
        { wj_font_latin, (long)(wj_font_latin_end - wj_font_latin) },
        { wj_font_greek, (long)(wj_font_greek_end - wj_font_greek) },
        { wj_font_cjk, (long)(wj_font_cjk_end - wj_font_cjk) },
    };
    int font = wj_font_init(faces, 3, wj_gfx_scale_x(), wj_gfx_scale_y());
    wj_ui_init((void *)wj_logo_mark);
    ASND_Init();
    MP3Player_Init();
    pcm_available = wj_pcm_init() == 0;
    wj_session_init(argc, argv);
    if (font) wj_session_set_message("The interface font could not be loaded");

    int b_combo = 0, dragging = 0, preview = -1;
    long long preview_until = 0;
    struct wj_pointer pointer = { 0, 0, 0 }, last = { 0, -1, -1 };
    while (SYS_MainLoop()) {
        WPAD_ScanPads();
        u32 down = WPAD_ButtonsDown(0), held = WPAD_ButtonsHeld(0), up = WPAD_ButtonsUp(0);
        if (down & WPAD_BUTTON_HOME) break;
        struct ir_t ir;
        WPAD_IR(WPAD_CHAN_0, &ir);
        pointer = (struct wj_pointer){ ir.valid && !visualizer, ir.x, ir.y };
        wj_session_update();
        const struct wj_session *s = wj_session();
        long long now = wj_milliseconds();

        if ((down & WPAD_BUTTON_2) && !(held & WPAD_BUTTON_B)) {
            down &= ~WPAD_BUTTON_2;
            toggle_visualizer();
        }
        if (visualizer && (up & WPAD_BUTTON_B) && !b_combo) {
            up &= ~WPAD_BUTTON_B;
            toggle_visualizer();
        }
        if (visualizer && !(held & WPAD_BUTTON_B))
            down &= ~(WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT | WPAD_BUTTON_UP | WPAD_BUTTON_DOWN);
        if (down & WPAD_BUTTON_PLUS) { wj_session_volume(16); wj_ui_volume_changed(); }
        if (down & WPAD_BUTTON_MINUS) { wj_session_volume(-16); wj_ui_volume_changed(); }

        // Pointing selects, like the Wii Menu, but only when the pointer moves,
        // so a resting remote never fights the D-pad.
        struct wj_hit hit = pointer.valid ? wj_ui_hit(pointer.x, pointer.y) : (struct wj_hit){ WJ_TARGET_NONE, 0 };
        int moved = pointer.valid && (pointer.x != last.x || pointer.y != last.y);
        if (moved && hit.target == WJ_TARGET_ITEM) wj_session_select(hit.index);
        last = pointer;

        if (held & WPAD_BUTTON_B && down & (WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_2 | WPAD_BUTTON_LEFT |
                                            WPAD_BUTTON_RIGHT | WPAD_BUTTON_UP | WPAD_BUTTON_DOWN)) {
            b_combo = 1;
            if (down & WPAD_BUTTON_A) wj_session_act(WJ_ACT_PLAY_LIST, 0);
            else if (down & WPAD_BUTTON_LEFT) wj_session_act(WJ_ACT_PREVIOUS, 0);
            else if (down & WPAD_BUTTON_RIGHT) wj_session_act(WJ_ACT_NEXT, 0);
            else if (down & WPAD_BUTTON_1) wj_session_act(WJ_ACT_PAUSE, 0);
            else if (down & WPAD_BUTTON_2) wj_session_act(WJ_ACT_STOP, 0);
            else if (!(s->capabilities & WJ_CAN_SEEK) || !s->has_progress || s->duration_ms <= 0) {
                wj_session_set_message("This track cannot seek");
            } else {
                // Each press moves the preview; the seek is sent once presses stop.
                int base = preview >= 0 ? preview : s->seek_until ? s->seek_target_ms : s->position_ms;
                preview = base + (down & WPAD_BUTTON_UP ? SEEK_STEP_MS : -SEEK_STEP_MS);
                if (preview < 0) preview = 0;
                if (preview > s->duration_ms - 1000) preview = s->duration_ms > 1000 ? s->duration_ms - 1000 : 0;
                preview_until = now + SEEK_SETTLE_MS;
            }
        } else if (!(held & WPAD_BUTTON_B)) {
            if (down & WPAD_BUTTON_A) {
                if (hit.target == WJ_TARGET_SEEK) {
                    dragging = 1;
                } else if (hit.target == WJ_TARGET_VISUALIZER) {
                    toggle_visualizer();
                } else if (hit.target != WJ_TARGET_NONE) {
                    if (hit.target == WJ_TARGET_ITEM) wj_session_select(hit.index);
                    wj_session_act(target_action(hit.target), 0);
                } else wj_session_act(WJ_ACT_OPEN, 0);
            }
            if (down & WPAD_BUTTON_1 && !wj_session_restart_network()) wj_session_act(WJ_ACT_REFRESH, 0);
            move(s, down);
        }
        if ((up & WPAD_BUTTON_B) && !b_combo) wj_session_act(WJ_ACT_BACK, 0);
        if (up & WPAD_BUTTON_B) b_combo = 0;

        if (dragging) {
            int at = pointer.valid ? wj_ui_seek_at(s, pointer.x) : -1;
            if (at >= 0) preview = at;
            if (!(held & WPAD_BUTTON_A)) {
                dragging = 0;
                if (preview >= 0) wj_session_act(WJ_ACT_SEEK, preview);
                preview = -1;
            }
        } else if (preview >= 0 && now >= preview_until) {
            wj_session_act(WJ_ACT_SEEK, preview);
            preview = -1;
        }
        wj_ui_seek_preview(preview);

        if (visualizer) {
            if (wj_visualizer_render()) {
                wj_visualizer_leave();
                visualizer = 0;
                wj_session_set_message(wj_visualizer_error());
            }
        } else wj_ui_draw(s, &pointer);
        VIDEO_WaitVSync();
    }
    wj_session_shutdown();
    wj_visualizer_leave();
    wj_visualizer_shutdown();
    wj_font_shutdown();
    ASND_End();
    return 0;
}
