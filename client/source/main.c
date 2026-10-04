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
#include "net.h"
#include "wire.h"

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

static void copy(char *out, size_t size, const char *in) {
    snprintf(out, size, "%s", in);
}

// Metadata is untrusted text, not terminal escape sequences. The initial
// console font is ASCII; a graphical UTF-8 renderer is a later UI milestone.
static void print_text(const char *text, int width) {
    for (int i = 0; i < width && text[i]; i++) {
        unsigned char c = (unsigned char)text[i];
        putchar(c >= 32 && c < 127 ? c : '?');
    }
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
        char ip[16];
        result = if_config(ip, NULL, NULL, true, 3);
        if (result >= 0) result = wj_discover(servers, WJ_SERVERS, "255.255.255.255", 4001);
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
        next_discovery = wj_milliseconds() + 5000;
        server_count = job_result > 0 ? job_result : 0;
        count = server_count;
        selected = 0;
        for (int i = 0; i < count; i++) {
            copy(items[i].title, sizeof(items[i].title), servers[i].name);
            if (saved_id[0] && !strcmp(saved_id, servers[i].id)) {
                choose_server(i);
                return;
            }
        }
        copy(message, sizeof(message), count ? "A: choose server   1: scan again" :
            "No server. Start npm start; allow UDP 4001. 1: retry");
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

static void draw(void) {
    printf("\x1b[2J\x1b[H\x1b[36;1m  WiiJukebox\x1b[37;0m   native client prototype\n\n  ");
    print_text(screen ? server.name : "Choose a server", 56);
    if (screen) printf(" [%.*s]", 8, server.id);
    printf("\n  "); print_text(title, 64);
    printf("\n\n");
    for (int i = 0; i < PAGE_SIZE; i++) {
        printf("  %s ", i < count && i == selected ? ">" : " ");
        if (i < count) print_text(items[i].title, 65);
        printf("\n");
    }
    printf("\n  "); print_text(message, 71);
    printf("\n  %s  ", play_state); print_text(now_playing, 57);
    printf("\n  "); print_text(artist, 64);
    printf("\n\n  HOME exit | +/- volume %d%% | 1 refresh\n", volume * 100 / 255);
    printf("  Left/right page | Hold B + left/right skip track\n");
    printf("  Hold B + 1 pause/resume | Hold B + 2 stop\n");
    printf("  %s | %s\n", job_busy ? "Working..." : "Ready", stream_started ? "Audio connected" : "Audio disconnected");
}

int main(void) {
    VIDEO_Init();
    WPAD_Init();
    PAD_Init();
    GXRModeObj *mode = VIDEO_GetPreferredMode(NULL);
    void *framebuffer = MEM_K0_TO_K1(SYS_AllocateFramebuffer(mode));
    console_init(framebuffer, 20, 20, mode->fbWidth - 40, mode->xfbHeight - 40,
                 mode->fbWidth * VI_DISPLAY_PIX_SZ);
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
        if (!screen && !job_busy && saved_id[0] && now >= next_discovery) {
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
