// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_SESSION_H
#define WJ_SESSION_H
#include "menu.h"
#include "audio_buffer.h"

#define WJ_ART_SIZE 128
/* The expanded cover; 72 KiB still fits one response buffer. */
#define WJ_ART_LARGE 192
#define WJ_MESSAGE_MS 4000

enum wj_view { WJ_VIEW_SERVERS, WJ_VIEW_SOURCES, WJ_VIEW_BROWSE };

/* Requests that need the network worker; one waits while another runs. */
enum wj_action {
    WJ_ACT_NONE, WJ_ACT_OPEN, WJ_ACT_BACK, WJ_ACT_PAGE_PREVIOUS, WJ_ACT_PAGE_NEXT, WJ_ACT_REFRESH,
    WJ_ACT_PLAY_LIST, WJ_ACT_PREVIOUS, WJ_ACT_NEXT, WJ_ACT_PAUSE, WJ_ACT_STOP, WJ_ACT_SEEK,
    WJ_ACT_SHUFFLE, WJ_ACT_REPEAT
};

/* Read-only for the UI; changed only by the functions below, on the main thread. */
struct wj_session {
    enum wj_view view;
    char title[257], message[257], network[80], server_name[128], server_id[37];
    /* Held messages describe a condition that still applies; others expire. */
    int message_held;
    long long message_at;
    /* Why the current list is empty, shown in place of rows. */
    char empty[96];
    struct wj_menu menu;
    int count, selected, total, offset, depth;
    /* Startup and server-chooser discovery progress. */
    int discovering, attempt;
    long long discovery_started;
    const char *phase;
    char song[257], artist[257], state[24];
    unsigned capabilities;
    /* Player-wide, and reported by the server even when the source cannot use them. */
    int shuffle;
    enum wj_repeat repeat;
    int position_ms, duration_ms, has_progress;
    /* A seek waits for the stream to reach the speakers; show its target meanwhile. */
    int seek_target_ms;
    long long seek_until;
    int volume, busy, audio_running, stream_started, underruns;
    struct wj_audio_state audio;
    unsigned art_version, large_art_version;
    int has_art, has_large_art;
};

void wj_session_init(int argc, char **argv);
void wj_session_update(void);
const struct wj_session *wj_session(void);
const unsigned char *wj_session_art(void);
const unsigned char *wj_session_large_art(void);
/* Ask for the WJ_ART_LARGE cover while the expanded view is open. */
void wj_session_want_large_art(int want);
void wj_session_select(int index);
void wj_session_move(int delta);
void wj_session_act(enum wj_action action, int argument);
/* Cancels a stalled network start instead of queueing a refresh. */
int wj_session_restart_network(void);
void wj_session_volume(int delta);
void wj_session_set_message(const char *text);
void wj_session_shutdown(void);
#endif
