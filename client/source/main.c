// SPDX-License-Identifier: GPL-3.0-only
#include <gccore.h>
#include <wiiuse/wpad.h>
#include <asndlib.h>
#include <mp3player.h>
#include <fat.h>
#include <network.h>
#include <ogc/mutex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "net.h"
#include "wire.h"
#include "discovery_port.h"

#if WJ_DISCOVERY_PORT < 1 || WJ_DISCOVERY_PORT > 65535
#error "DISCOVERY_PORT must be between 1 and 65535"
#endif

#define PAGE_SIZE 12
#define DEPTH 16

enum job_kind { JOB_NONE, JOB_DISCOVER, JOB_LIST, JOB_STATUS, JOB_CONTROL, JOB_STREAM };
struct item { char ref[64], type[24], title[257]; };
struct location { char ref[64]; int offset, selected; };
static struct wj_server servers[WJ_SERVERS], server;
static struct item items[PAGE_SIZE];
static struct location stack[DEPTH], location;
static char source[64], title[257] = "WiiJukebox", message[257] = "Finding your server...";
static char now_playing[257] = "Nothing playing", artist[257], play_state[24] = "idle";
static char saved_id[37];
static int count, selected, total, server_count, depth;
static int screen; // 0: servers, 1: sources, 2: source contents
static int volume = 160;
static int stream_fd = -1;
static int stream_started;
static int storage;
static long long next_status, next_stream, next_discovery;
static int stream_failures;
static mutex_t mutex;
static lwp_t worker;
static int job_busy, job_done, job_result;
static enum job_kind job;
static char job_path[2048], job_method[8], reply[WJ_BODY];
static int exiting;
static char direct_address[32], network_status[80] = "Network not initialized";
static char job_ip[16];
static int job_network_result, job_direct;

static void copy(char *out, size_t size, const char *in) {
    snprintf(out, size, "%s", in);
}

static void save_server(void) {
    copy(saved_id, sizeof(saved_id), server.id);
    if (!storage) return;
    FILE *file = fopen("sd:/apps/wiijukebox/server.id", "w");
    if (file) { fprintf(file, "%s\n", saved_id); fclose(file); }
}

static void *run_job(void *unused) {
    (void)unused;
    int result;
    if (job == JOB_DISCOVER) {
        job_ip[0] = 0;
        job_direct = 0;
        job_network_result = if_config(job_ip, NULL, NULL, true, 3);
        if (job_network_result >= 0 && (!job_ip[0] || !strcmp(job_ip, "0.0.0.0")))
            job_network_result = -1;
        result = job_network_result;
        if (result >= 0) {
            if (direct_address[0] && !wj_lookup(&servers[0], direct_address)) {
                result = 1;
                job_direct = 1;
            } else result = wj_discover(servers, WJ_SERVERS, "255.255.255.255", WJ_DISCOVERY_PORT);
        }
    } else if (job == JOB_STREAM) {
        int status = 0;
        result = wj_open(&server, "GET", server.mount, &status);
        if (result >= 0 && status != 200) { wj_close(result); result = -1; }
    } else {
        result = wj_request(&server, job_method, job_path, reply, sizeof(reply));
    }
    LWP_MutexLock(mutex);
    job_result = result;
    job_done = 1;
    LWP_MutexUnlock(mutex);
    return NULL;
}

static void start_job(enum job_kind kind, const char *method, const char *path) {
    if (job_busy) return;
    if (kind == JOB_DISCOVER) copy(message, sizeof(message), "Initializing network and finding server...");
    job = kind;
    copy(job_method, sizeof(job_method), method ? method : "GET");
    copy(job_path, sizeof(job_path), path ? path : "");
    reply[0] = 0;
    job_busy = 1;
    job_done = 0;
    if (LWP_CreateThread(&worker, run_job, NULL, NULL, 65536, 60) < 0) {
        job_busy = 0;
        copy(message, sizeof(message), "Could not create network worker");
    }
}

static void load_list(void) {
    char path[512];
    if (screen == 1) copy(path, sizeof(path), "/api/wii/sources");
    else snprintf(path, sizeof(path), "/api/wii/browse?source=%s&ref=%s&offset=%d",
                  source, location.ref, location.offset);
    copy(message, sizeof(message), "Loading...");
    start_job(JOB_LIST, "GET", path);
}

static void choose_server(int index) {
    server = servers[index];
    save_server();
    screen = 1;
    selected = 0;
    count = 0;
    depth = 0;
    next_stream = 0;
    stream_failures = 0;
    copy(title, sizeof(title), "Music sources");
    load_list();
}

static s32 audio_read(void *unused, void *buffer, s32 size) {
    (void)unused;
    LWP_MutexLock(mutex);
    int stop = exiting;
    LWP_MutexUnlock(mutex);
    if (stop) return 0;
    // A bounded receive lets HOME terminate a stalled server connection.
    int n = wj_receive(stream_fd, buffer, size, 1500);
    return n > 0 ? n : 0;
}

static void stop_audio(void) {
    MP3Player_Stop();
    wj_close(stream_fd);
    stream_fd = -1;
    stream_started = 0;
}

static void finish_job(void) {
    LWP_MutexLock(mutex);
    int done = job_done;
    LWP_MutexUnlock(mutex);
    if (!job_busy || !done) return;
    LWP_JoinThread(worker, NULL);
    job_busy = 0;
    if (job == JOB_DISCOVER) {
        if (job_network_result < 0)
            snprintf(network_status, sizeof(network_status), "Network init failed (%d); 1: retry", job_network_result);
        else snprintf(network_status, sizeof(network_status), "Wii IP %s | discovery UDP %d", job_ip, WJ_DISCOVERY_PORT);
        next_discovery = wj_milliseconds() + 5000;
        server_count = job_result > 0 ? job_result : 0;
        count = server_count;
        selected = 0;
        for (int i = 0; i < count; i++) {
            copy(items[i].title, sizeof(items[i].title), servers[i].name);
            if (job_direct || (saved_id[0] && !strcmp(saved_id, servers[i].id))) {
                choose_server(i);
                return;
            }
        }
        if (count) copy(message, sizeof(message), "A: choose server   1: scan again");
        else if (job_result < 0) snprintf(message, sizeof(message),
            "Network/discovery error %d. 1: retry", job_result);
        else snprintf(message, sizeof(message),
            "No server. Allow UDP %d. 1: retry", WJ_DISCOVERY_PORT);
        return;
    }
    if (job == JOB_STREAM) {
        stream_fd = job_result;
        if (stream_fd >= 0) {
            if (MP3Player_PlayFile(NULL, audio_read, NULL) < 0) {
                wj_close(stream_fd);
                stream_fd = -1;
            } else stream_started = 1;
        }
        next_stream = wj_milliseconds() + 3000;
        if (stream_fd < 0) {
            stream_failures++;
            copy(message, sizeof(message), "Audio disconnected; retrying...");
            if (stream_failures >= 3) {
                screen = 0;
                count = 0;
                next_discovery = 0;
                copy(title, sizeof(title), "Finding remembered server...");
            }
        } else stream_failures = 0;
        return;
    }
    if (job_result != 200) {
        struct wj_document doc;
        if (!wj_document(reply, &doc) && doc.count && doc.rows[0].count >= 2 &&
            !strcmp(doc.rows[0].field[0], "error")) {
            copy(message, sizeof(message), doc.rows[0].field[1]);
        } else copy(message, sizeof(message), "Server request failed; 1: refresh, B: back");
        return;
    }
    if (job == JOB_CONTROL) {
        copy(message, sizeof(message), "Command sent");
        next_status = 0;
        return;
    }
    struct wj_document doc;
    if (wj_document(reply, &doc)) {
        copy(message, sizeof(message), "Unsupported or malformed server response");
        return;
    }
    if (job == JOB_STATUS) {
        for (int i = 0; i < doc.count; i++) {
            struct wj_row *row = &doc.rows[i];
            if (row->count == 2 && !strcmp(row->field[0], "command") && row->field[1][0]) {
                copy(message, sizeof(message), row->field[1]);
            } else if (row->count >= 4 && !strcmp(row->field[0], "status")) {
                copy(now_playing, sizeof(now_playing), row->field[1]);
                copy(artist, sizeof(artist), row->field[2]);
                copy(play_state, sizeof(play_state), row->field[3]);
            }
        }
        return;
    }
    count = 0;
    total = 0;
    for (int i = 0; i < doc.count; i++) {
        struct wj_row *row = &doc.rows[i];
        if (row->count == 3 && !strcmp(row->field[0], "page")) {
            if (wj_number(row->field[2], 0, 2147483647, &total)) total = 0;
        } else if (count < PAGE_SIZE && row->count >= 4 &&
                   (!strcmp(row->field[0], "source") || !strcmp(row->field[0], "item"))) {
            // References are used in request URLs. Reject injected delimiters.
            if (!*row->field[1] || strspn(row->field[1], "abcdefghijklmnopqrstuvwxyz0123456789-") != strlen(row->field[1])) continue;
            copy(items[count].ref, sizeof(items[count].ref), row->field[1]);
            copy(items[count].type, sizeof(items[count].type), screen == 1 ? "source" : row->field[2]);
            copy(items[count].title, sizeof(items[count].title), row->field[screen == 1 ? 2 : 3]);
            count++;
        }
    }
    selected = location.selected < count ? location.selected : 0;
    copy(message, sizeof(message), count ? "A: open/play  B: back  2: play album/list" :
        "Empty. Add saved links/stations in the web UI; 1: refresh");
}

static void play_item(void) {
    if (!count || screen != 2) return;
    char path[256];
    snprintf(path, sizeof(path), "/api/wii/play?source=%s&ref=%s", source, items[selected].ref);
    copy(message, sizeof(message), "Starting selection...");
    start_job(JOB_CONTROL, "POST", path);
}

static void select_item(void) {
    if (!count) return;
    if (screen == 0) { choose_server(selected); return; }
    if (screen == 1) {
        copy(source, sizeof(source), items[selected].ref);
        copy(title, sizeof(title), items[selected].title);
        memset(&location, 0, sizeof(location));
        screen = 2;
        depth = 0;
    } else {
        const char *type = items[selected].type;
        if (!strcmp(type, "track") || !strcmp(type, "station")) { play_item(); return; }
        if (depth == DEPTH) { copy(message, sizeof(message), "Folder depth limit reached"); return; }
        location.selected = selected;
        stack[depth++] = location;
        memset(&location, 0, sizeof(location));
        copy(location.ref, sizeof(location.ref), items[selected].ref);
    }
    count = 0;
    selected = 0;
    load_list();
}

static void control(const char *action) {
    char path[80];
    snprintf(path, sizeof(path), "/api/wii/control?action=%s", action);
    start_job(JOB_CONTROL, "POST", path);
}

// Update only changed, padded rows: clearing the whole live framebuffer caused
// visible flashing, and newline-driven output could scroll past the console.
static void draw_line(int row, const char *format, ...) {
    static char previous[26][73];
    char text[512], line[73];
    va_list args;
    va_start(args, format);
    vsnprintf(text, sizeof(text), format, args);
    va_end(args);
    int columns, rows;
    CON_GetMetrics(&columns, &rows);
    if (row < 1 || row > rows || row > 26) return;
    int width = columns - 1 < 72 ? columns - 1 : 72;
    int length = (int)strlen(text);
    for (int i = 0; i < width; i++) {
        unsigned char c = i < length ? (unsigned char)text[i] : ' ';
        line[i] = c >= 32 && c < 127 ? c : '?';
    }
    line[width] = 0;
    if (!strcmp(previous[row - 1], line)) return;
    printf("\x1b[%d;1H%s", row, line);
    copy(previous[row - 1], sizeof(previous[0]), line);
}

static void draw(void) {
    draw_line(1, "WiiJukebox  |  native client prototype");
    draw_line(2, "%s", screen ? server.name : "Choose a server");
    draw_line(3, "%s", title);
    draw_line(4, "%s", network_status);
    for (int i = 0; i < PAGE_SIZE; i++) {
        draw_line(6 + i, "%s %.65s", i < count && i == selected ? ">" : " ",
                  i < count ? items[i].title : "");
    }
    draw_line(19, "%s", message);
    draw_line(20, "%.10s  %.57s", play_state, now_playing);
    draw_line(21, "%s", artist);
    draw_line(23, "HOME exit | +/- volume %d%% | 1 refresh/retry", volume * 100 / 255);
    draw_line(24, "Left/right page | B + left/right skip track");
    draw_line(25, "B + 1 pause/resume | B + 2 stop | A choose/play");
    draw_line(26, "%s | %s", job_busy ? "Working..." : "Ready",
              stream_started ? "Audio connected" : "Audio disconnected");
    fflush(stdout);
}

int main(int argc, char **argv) {
    // wiiload can put the first application argument in argv[0]; HBC can
    // prepend the executable path. Accept the endpoint in either position.
    for (int i = 0; i < argc; i++) {
        if (strlen(argv[i]) < sizeof(direct_address) && strchr(argv[i], ':') &&
            strspn(argv[i], "0123456789.:") == strlen(argv[i])) {
            copy(direct_address, sizeof(direct_address), argv[i]);
            break;
        }
    }
    VIDEO_Init();
    WPAD_Init();
    PAD_Init();
    GXRModeObj *mode = VIDEO_GetPreferredMode(NULL);
    void *framebuffer = MEM_K0_TO_K1(SYS_AllocateFramebuffer(mode));
    console_init(framebuffer, 16, 16, mode->fbWidth - 16, mode->xfbHeight - 16,
                 mode->fbWidth * VI_DISPLAY_PIX_SZ);
    VIDEO_ClearFrameBuffer(mode, framebuffer, COLOR_BLACK);
    VIDEO_Configure(mode);
    VIDEO_SetNextFramebuffer(framebuffer);
    VIDEO_SetBlack(false);
    VIDEO_Flush();
    VIDEO_WaitVSync();
    ASND_Init();
    MP3Player_Init();
    MP3Player_Volume(volume);
    LWP_MutexInit(&mutex, false);
    storage = fatInitDefault();
    if (storage) {
        FILE *file = fopen("sd:/apps/wiijukebox/server.id", "r");
        if (file) { if (fgets(saved_id, sizeof(saved_id), file)) saved_id[strcspn(saved_id, "\r\n")] = 0; fclose(file); }
    }
    start_job(JOB_DISCOVER, NULL, NULL);
    long long last_draw = 0;
    int b_combo = 0;
    while (SYS_MainLoop()) {
        WPAD_ScanPads();
        u32 down = WPAD_ButtonsDown(0), held = WPAD_ButtonsHeld(0), up = WPAD_ButtonsUp(0);
        if (down & WPAD_BUTTON_HOME) break;
        finish_job();
        if (down & WPAD_BUTTON_PLUS) { volume = volume < 239 ? volume + 16 : 255; MP3Player_Volume(volume); }
        if (down & WPAD_BUTTON_MINUS) { volume = volume > 16 ? volume - 16 : 0; MP3Player_Volume(volume); }
        if (!job_busy) {
            if ((held & WPAD_BUTTON_B) && screen && (down & (WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT | WPAD_BUTTON_1 | WPAD_BUTTON_2))) {
                b_combo = 1;
                if (down & WPAD_BUTTON_LEFT) control("previous");
                else if (down & WPAD_BUTTON_RIGHT) control("next");
                else if (down & WPAD_BUTTON_2) control("stop");
                else control(!strcmp(play_state, "paused") ? "play" : "pause");
            } else if (down & WPAD_BUTTON_A) select_item();
            else if (down & WPAD_BUTTON_2) play_item();
            else if (down & WPAD_BUTTON_UP) selected = count ? (selected + count - 1) % count : 0;
            else if (down & WPAD_BUTTON_DOWN) selected = count ? (selected + 1) % count : 0;
            else if (down & WPAD_BUTTON_1) {
                if (!screen) start_job(JOB_DISCOVER, NULL, NULL);
                else load_list();
            } else if (screen == 2 && (down & (WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT))) {
                int offset = location.offset + (down & WPAD_BUTTON_RIGHT ? PAGE_SIZE : -PAGE_SIZE);
                if (offset >= 0 && offset < total) {
                    location.offset = offset;
                    location.selected = 0;
                    load_list();
                }
            } else if ((up & WPAD_BUTTON_B) && !b_combo) {
                if (screen == 2) {
                    if (depth) location = stack[--depth];
                    else { screen = 1; memset(&location, 0, sizeof(location)); copy(title, sizeof(title), "Music sources"); }
                    load_list();
                } else if (screen == 1) {
                    stop_audio();
                    screen = 0;
                    count = 0;
                    copy(title, sizeof(title), "Choose a server");
                    start_job(JOB_DISCOVER, NULL, NULL);
                    saved_id[0] = 0; // Explicitly going back should show the chooser.
                }
            }
        }
        if (up & WPAD_BUTTON_B) b_combo = 0;
        long long now = wj_milliseconds();
        if (!screen && !count && !job_busy && now >= next_discovery) {
            start_job(JOB_DISCOVER, NULL, NULL);
        }
        if (screen && !job_busy) {
            if (now >= next_stream && (!stream_started || !MP3Player_IsPlaying())) {
                stop_audio();
                start_job(JOB_STREAM, NULL, NULL);
            } else if (now >= next_status) {
                next_status = now + 3000;
                start_job(JOB_STATUS, "GET", "/api/wii/status");
            }
        }
        if (now - last_draw > 100 || down || up) { draw(); last_draw = now; }
        VIDEO_WaitVSync();
    }
    LWP_MutexLock(mutex);
    exiting = 1;
    LWP_MutexUnlock(mutex);
    if (job_busy) {
        LWP_JoinThread(worker, NULL);
        if (job == JOB_STREAM && job_result >= 0) wj_close(job_result);
    }
    stop_audio();
    LWP_MutexDestroy(mutex);
    ASND_End();
    return 0;
}
