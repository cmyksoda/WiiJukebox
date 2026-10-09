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
#include "tour.h"

#define SEEK_STEP_MS 10000
#define SEEK_SETTLE_MS 900
#define DELETE_DELAY_MS 450
#define DELETE_REPEAT_MS 70

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
        wj_ui_show_art(0);
    } else {
        wj_visualizer_leave();
        wj_session_set_message(wj_visualizer_error());
    }
}

struct overlay { const struct wj_session *session; const struct wj_pointer *pointer; };

static void draw_overlay(void *context) {
    const struct overlay *overlay = context;
    wj_ui_draw_overlay(overlay->session, overlay->pointer);
}

/* HOME menu input. Returns 1 when Exit was chosen. */
static int home_input(u32 down, struct wj_hit hit, int pointing, int moved) {
    if (down & WPAD_BUTTON_UP) wj_session_home_move(-1);
    if (down & WPAD_BUTTON_DOWN) wj_session_home_move(1);
    if (moved && hit.target == WJ_TARGET_HOME_ITEM) wj_session_home_select(hit.index);
    if (down & WPAD_BUTTON_A) {
        if (hit.target == WJ_TARGET_HOME_DISMISS) wj_session_home(0);
        else if (hit.target == WJ_TARGET_HOME_ITEM || !pointing) {
            if (hit.target == WJ_TARGET_HOME_ITEM) wj_session_home_select(hit.index);
            enum wj_home_item item = wj_session_home_activate();
            if (item == WJ_HOME_EXIT) return 1;
            // The numpad is a UI screen, so the visualizer gives way to it.
            if (item == WJ_HOME_ADDRESS && visualizer) toggle_visualizer();
        }
    }
    if (down & WPAD_BUTTON_B) wj_session_home(0);
    return 0;
}

static void entry_input(u32 down, u32 held, struct wj_hit hit, int pointing, int moved, long long now,
                        long long *delete_at) {
    int dx = (down & WPAD_BUTTON_RIGHT ? 1 : 0) - (down & WPAD_BUTTON_LEFT ? 1 : 0);
    int dy = (down & WPAD_BUTTON_DOWN ? 1 : 0) - (down & WPAD_BUTTON_UP ? 1 : 0);
    if (dx || dy) wj_session_entry_move(dx, dy);
    if (moved && hit.target == WJ_TARGET_KEY) wj_session_entry_focus(hit.index);
    if (down & WPAD_BUTTON_A) {
        if (hit.target == WJ_TARGET_KEY) wj_session_entry_press(hit.index);
        else if (hit.target == WJ_TARGET_FORGET) wj_session_entry_forget();
        else if (hit.target == WJ_TARGET_BACK) wj_session_entry_close();
        else if (!pointing || hit.target == WJ_TARGET_NONE) wj_session_entry_press(-1);
    }
    if (down & WPAD_BUTTON_B) {
        wj_session_entry_back();
        *delete_at = now + DELETE_DELAY_MS;
    } else if (!(held & WPAD_BUTTON_B)) {
        *delete_at = 0;
    } else if (*delete_at && now >= *delete_at) {
        wj_session_entry_delete();
        *delete_at = now + DELETE_REPEAT_MS;
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
    case WJ_TARGET_SHUFFLE: return WJ_ACT_SHUFFLE;
    case WJ_TARGET_REPEAT: return WJ_ACT_REPEAT;
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

    int b_combo = 0, dragging = 0, preview = -1, leave = 0;
    long long preview_until = 0, delete_at = 0;
    struct wj_pointer pointer = { 0, 0, 0 }, last = { 0, -1, -1 };
    while (SYS_MainLoop()) {
        WPAD_ScanPads();
        u32 down = WPAD_ButtonsDown(0), held = WPAD_ButtonsHeld(0), up = WPAD_ButtonsUp(0);
        struct ir_t ir;
        WPAD_IR(WPAD_CHAN_0, &ir);
        wj_session_update();
        const struct wj_session *s = wj_session();
        long long now = wj_milliseconds();
        pointer = (struct wj_pointer){ ir.valid && (!visualizer || s->home_open), ir.x, ir.y };

        if (down & WPAD_BUTTON_HOME) {
            wj_ui_show_art(0);
            wj_session_home(!s->home_open);
        }
        // Pointing selects, like the Wii Menu, but only when the pointer moves,
        // so a resting remote never fights the D-pad.
        struct wj_hit hit = pointer.valid ? wj_ui_hit(pointer.x, pointer.y) : (struct wj_hit){ WJ_TARGET_NONE, 0 };
        int moved = pointer.valid && (pointer.x != last.x || pointer.y != last.y);
        last = pointer;
        // The menu and the numpad take the whole remote; only volume reaches past them.
        if (s->home_open || s->entry.open) {
            if (down & WPAD_BUTTON_B) b_combo = 1;
            if (s->home_open) leave = home_input(down, hit, pointer.valid, moved);
            else entry_input(down, held, hit, pointer.valid, moved, now, &delete_at);
            if (up & WPAD_BUTTON_B) b_combo = 0;
            down &= WPAD_BUTTON_PLUS | WPAD_BUTTON_MINUS;
            held &= ~WPAD_BUTTON_B;
            up = 0;
            if (leave) break;
        }

        if ((down & WPAD_BUTTON_2) && !(held & WPAD_BUTTON_B)) {
            down &= ~WPAD_BUTTON_2;
            toggle_visualizer();
        }
        if (visualizer && (up & WPAD_BUTTON_B) && !b_combo) {
            up &= ~WPAD_BUTTON_B;
            toggle_visualizer();
        }
#if WJ_PRESET_TOUR
        if (visualizer && !(held & WPAD_BUTTON_B)) {
            int step = (down & WPAD_BUTTON_RIGHT ? 1 : 0) - (down & WPAD_BUTTON_LEFT ? 1 : 0) +
                       (down & WPAD_BUTTON_UP ? 10 : 0) - (down & WPAD_BUTTON_DOWN ? 10 : 0);
            if (step) wj_visualizer_step(step);
            if (down & WPAD_BUTTON_1) wj_visualizer_flag();
        }
#endif
        if (visualizer && !(held & WPAD_BUTTON_B))
            down &= ~(WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT | WPAD_BUTTON_UP | WPAD_BUTTON_DOWN);
        // The large cover takes A and B for closing; only volume reaches past it.
        if (wj_ui_art_open() && !visualizer) {
            if ((down & WPAD_BUTTON_A) || ((up & WPAD_BUTTON_B) && !b_combo) ||
                ((held & WPAD_BUTTON_B) && (down & WPAD_BUTTON_PLUS))) {
                wj_ui_show_art(0);
                if (held & WPAD_BUTTON_B) b_combo = 1;
            }
            if (up & WPAD_BUTTON_B) b_combo = 0;
            down &= (held & WPAD_BUTTON_B) ? WPAD_BUTTON_MINUS : WPAD_BUTTON_MINUS | WPAD_BUTTON_PLUS;
            up = 0;
        }
        wj_session_want_large_art(wj_ui_art_open());
        if ((down & WPAD_BUTTON_PLUS) && !(held & WPAD_BUTTON_B)) { wj_session_volume(16); wj_ui_volume_changed(); }
        if ((down & WPAD_BUTTON_MINUS) && !(held & WPAD_BUTTON_B)) { wj_session_volume(-16); wj_ui_volume_changed(); }

        if (moved && hit.target == WJ_TARGET_ITEM) wj_session_select(hit.index);

        if (held & WPAD_BUTTON_B && down & (WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_2 | WPAD_BUTTON_LEFT |
                                            WPAD_BUTTON_RIGHT | WPAD_BUTTON_UP | WPAD_BUTTON_DOWN | WPAD_BUTTON_PLUS)) {
            b_combo = 1;
            if (down & WPAD_BUTTON_A) wj_session_act(WJ_ACT_PLAY_LIST, 0);
            else if (down & WPAD_BUTTON_LEFT) wj_session_act(WJ_ACT_PREVIOUS, 0);
            else if (down & WPAD_BUTTON_RIGHT) wj_session_act(WJ_ACT_NEXT, 0);
            else if (down & WPAD_BUTTON_1) wj_session_act(WJ_ACT_PAUSE, 0);
            else if (down & WPAD_BUTTON_2) wj_session_act(WJ_ACT_STOP, 0);
            else if (down & WPAD_BUTTON_PLUS) {
                if (s->has_art && s->view != WJ_VIEW_SERVERS) wj_ui_show_art(1);
                else wj_session_set_message("No cover art for this song");
            } else if (!(s->capabilities & WJ_CAN_SEEK) || !s->has_progress || s->duration_ms <= 0) {
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
                } else if (hit.target == WJ_TARGET_ART) {
                    wj_ui_show_art(1);
                } else if (hit.target == WJ_TARGET_ENTER_ADDRESS) {
                    wj_session_entry_open();
                } else if (hit.target != WJ_TARGET_NONE) {
                    if (hit.target == WJ_TARGET_ITEM) wj_session_select(hit.index);
                    wj_session_act(target_action(hit.target), 0);
                } else if (s->view == WJ_VIEW_SERVERS && !s->count) wj_session_entry_open();
                else wj_session_act(WJ_ACT_OPEN, 0);
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
            struct overlay overlay = { s, &pointer };
            if (wj_visualizer_render(s->home_open ? draw_overlay : NULL, &overlay)) {
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
