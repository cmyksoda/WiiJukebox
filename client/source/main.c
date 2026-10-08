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
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <sys/stat.h>
#include "net.h"
#include "wire.h"
#include "menu.h"
#include "init_wait.h"
#include "audio_buffer.h"
#include "pcm_snapshot.h"
#include "visualizer.h"
#include "progress.h"
#include "playback_clock.h"
#include "discovery_port.h"

#if WJ_DISCOVERY_PORT < 1 || WJ_DISCOVERY_PORT > 65535
#error "DISCOVERY_PORT must be between 1 and 65535"
#endif

#define PAGE_SIZE WJ_PAGE_SIZE
#define DEPTH 16

enum job_kind { JOB_NONE, JOB_DISCOVER, JOB_REDISCOVER, JOB_LIST, JOB_STATUS, JOB_CONTROL };
struct location { char ref[64], type[24], title[257]; int offset, selected; };
static struct wj_server servers[WJ_SERVERS], server;
static struct wj_menu menu;

static struct location stack[DEPTH], location;
static char source[64], title[257] = "WiiJukebox", message[257] = "Finding your server...";
static char now_playing[257] = "Nothing playing", artist[257], play_state[24] = "idle";
static int position_ms, duration_ms, progress_available;
static char saved_id[37];
static int count, selected, total, server_count, depth;
static int screen; // 0: servers, 1: sources, 2: source contents
static int volume = 160;
static int audio_running, stream_started;
static int audio_underruns;
static struct wj_audio_state audio;
static int decode_epoch;
static int storage;
static long long next_status, next_discovery, next_rediscovery;
static int status_failures;
static mutex_t mutex;
static lwp_t worker;
static int job_busy, job_done, job_result;
static enum job_kind job;
static char job_path[2048], job_method[8], reply[WJ_BODY];
static int exiting;
static char direct_address[32], network_status[80] = "Network not initialized";
static char job_ip[16];
static int job_network_result, job_direct;
static int cancel_discovery, network_attempt;
static long long discovery_started, job_started;
static struct wj_http_trace job_trace;
static int pending_command;
static char previous_lines[28][73];
static const char *const not_responding = "Server not responding; retrying...";
enum network_phase { NETWORK_INIT, NETWORK_IP, NETWORK_LOOKUP, NETWORK_SCAN, NETWORK_CLEANUP };
static enum network_phase network_phase;
static int job_init_deadline;

static void set_network_phase(enum network_phase phase) {
    LWP_MutexLock(mutex);
    network_phase = phase;
    LWP_MutexUnlock(mutex);
}

static int discovery_cancelled(void) {
    LWP_MutexLock(mutex);
    int cancel = cancel_discovery || exiting;
    LWP_MutexUnlock(mutex);
    return cancel;
}

static int start_network(void) { return net_init_async(NULL, NULL); }
static void wait_network(void) { usleep(20000); }

static void log_event(const char *format, ...) {
    if (!storage) return;
    FILE *file = fopen("sd:/apps/wiijukebox/network.log", "a");
    if (!file) return;
    fseek(file, 0, SEEK_END);
    if (ftell(file) > 256 * 1024) {
        fclose(file);
        file = fopen("sd:/apps/wiijukebox/network.log", "w");
        if (!file) return;
    }
    time_t wall = time(NULL);
    fprintf(file, "wall=%lld mono_ms=%lld ", (long long)wall, wj_milliseconds());
    va_list args;
    va_start(args, format);
    vfprintf(file, format, args);
    va_end(args);
    fputc('\n', file);
    fclose(file);
}

static void copy(char *out, size_t size, const char *in) {
    snprintf(out, size, "%s", in);
}

static void save_server(void) {
    copy(saved_id, sizeof(saved_id), server.id);
    if (!storage) return;
    FILE *file = fopen("sd:/apps/wiijukebox/server.id", "w");
    if (file) { fprintf(file, "%s\n", saved_id); fclose(file); }
}

static int initialize_network(void) {
    const struct wj_init_ops ops = {
        start_network, net_get_status, discovery_cancelled, wj_milliseconds, wait_network
    };
    set_network_phase(NETWORK_INIT);
    int result = wj_wait_for_network(&ops, &job_init_deadline);
    if (result >= 0) {
        set_network_phase(NETWORK_IP);
        result = if_config(job_ip, NULL, NULL, true, 1);
    }
    if (result >= 0 && (!job_ip[0] || !strcmp(job_ip, "0.0.0.0"))) result = -ENETDOWN;
    if (result < 0) {
        /* libogc waits for its IOS callback during cleanup; show that phase
           instead of promising that cancellation can interrupt IOS itself. */
        set_network_phase(NETWORK_CLEANUP);
        net_deinit();
    }
    return result;
}

/* Rediscovery finds the remembered server's new address without leaving the
   current screen; the audio thread reads `server` under the same mutex. */
static int rediscover(void) {
    struct wj_server found[WJ_SERVERS];
    int count;
    if (direct_address[0]) count = wj_lookup(&found[0], direct_address) ? 0 : 1;
    else count = wj_discover(found, WJ_SERVERS, "255.255.255.255", WJ_DISCOVERY_PORT);
    LWP_MutexLock(mutex);
    int moved = -1;
    for (int i = 0; i < count; i++) {
        if (strcmp(found[i].id, server.id)) continue;
        moved = strcmp(found[i].ip, server.ip) || found[i].port != server.port;
        server = found[i];
    }
    LWP_MutexUnlock(mutex);
    return count < 0 ? count : moved;
}

static void *run_job(void *unused) {
    (void)unused;
    int result;
    if (job == JOB_REDISCOVER) {
        result = rediscover();
    } else if (job == JOB_DISCOVER) {
        job_ip[0] = 0;
        job_direct = 0;
        job_network_result = initialize_network();
        result = job_network_result;
        if (result >= 0) {
            set_network_phase(NETWORK_LOOKUP);
            if (direct_address[0] && !wj_lookup(&servers[0], direct_address)) {
                result = 1;
                job_direct = 1;
            } else if (discovery_cancelled()) result = -ECANCELED;
            else {
                set_network_phase(NETWORK_SCAN);
                result = wj_discover(servers, WJ_SERVERS, "255.255.255.255", WJ_DISCOVERY_PORT);
            }
        }
    } else {
        LWP_MutexLock(mutex);
        struct wj_server target = server;
        LWP_MutexUnlock(mutex);
        result = wj_request_traced(&target, job_method, job_path, reply, sizeof(reply), &job_trace);
    }
    LWP_MutexLock(mutex);
    job_result = result;
    job_done = 1;
    LWP_MutexUnlock(mutex);
    return NULL;
}

static void start_job(enum job_kind kind, const char *method, const char *path) {
    if (job_busy) return;
    if (kind == JOB_DISCOVER) {
        LWP_MutexLock(mutex);
        cancel_discovery = 0;
        LWP_MutexUnlock(mutex);
        network_attempt++;
        discovery_started = wj_milliseconds();
        copy(network_status, sizeof(network_status), "Initializing network...");
        copy(message, sizeof(message), "Connecting...");
    }
    job = kind;
    job_started = wj_milliseconds();
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

static int open_stream(const char *query, struct wj_stream_clock *clock) {
    LWP_MutexLock(mutex);
    struct wj_server target = server;
    LWP_MutexUnlock(mutex);
    char path[sizeof(target.mount) + 64];
    snprintf(path, sizeof(path), "%s%s", target.mount, query);
    int status = 0;
    long long started = wj_milliseconds();
    int fd = wj_open_audio(&target, path, &status, clock);
    if (fd >= 0 && status != 200) { wj_close(fd); fd = -1; }
    log_event("stream result=%d resume=%d byte=%lld elapsed_ms=%lld", fd, query[0] != 0,
              fd >= 0 ? clock->byte_start : -1, wj_milliseconds() - started);
    return fd;
}

static void stop_audio(void) {
    MP3Player_Stop();
    wj_audio_stop();
    audio_running = stream_started = 0;
    memset(&audio, 0, sizeof(audio));
}

static void choose_server(int index) {
    stop_audio();
    LWP_MutexLock(mutex);
    server = servers[index];
    LWP_MutexUnlock(mutex);
    save_server();
    screen = 1;
    selected = 0;
    count = 0;
    depth = 0;
    status_failures = 0;
    copy(title, sizeof(title), "Music sources");
    audio_running = !wj_audio_start(open_stream);
    if (!audio_running) copy(message, sizeof(message), "Could not start the audio connection");
    load_list();
}

static s32 audio_read(void *unused, void *buffer, s32 size) {
    (void)unused;
    LWP_MutexLock(mutex);
    int stop = exiting;
    LWP_MutexUnlock(mutex);
    if (stop) return 0;
    return wj_audio_read_wait(buffer, size, 50);
}

/* Keeps the decoder fed: restarts it after underruns or non-contiguous
   reconnects, and trims or resyncs when a backlog would add latency. */
static void update_audio(void) {
    if (!audio_running) return;
    audio = wj_audio_state();
    int target = wj_audio_bytes(WJ_AUDIO_TARGET_MS, audio.bitrate);
    if (stream_started && audio.stale) {
        MP3Player_Stop();
        stream_started = 0;
    } else if (stream_started && !MP3Player_IsPlaying()) {
        MP3Player_Stop();
        stream_started = 0;
        audio_underruns++;
        log_event("underrun count=%d connected=%d buffered=%d", audio_underruns, audio.connected, audio.buffered);
        copy(message, sizeof(message), "Refilling audio buffer...");
    } else if (stream_started && audio.buffered > wj_audio_bytes(WJ_AUDIO_RESYNC_MS, audio.bitrate)) {
        log_event("resync buffered=%d bitrate=%d", audio.buffered, audio.bitrate);
        wj_audio_resync();
    }
    if (stream_started || audio.buffered < wj_audio_bytes(WJ_AUDIO_PREBUFFER_MS, audio.bitrate)) return;
    long long byte = wj_audio_begin_decode(audio.buffered > target * 3 / 2 ? target : 0);
    wj_mp3_clock_start(byte);
    if (MP3Player_PlayFile(NULL, audio_read, NULL) < 0) return;
    stream_started = 1;
    decode_epoch = audio.epoch;
    if (!strcmp(message, "Refilling audio buffer...") || !strcmp(message, "Buffering audio...")) message[0] = 0;
}

static void finish_job(void) {
    LWP_MutexLock(mutex);
    int done = job_done;
    LWP_MutexUnlock(mutex);
    if (!job_busy || !done) return;
    LWP_JoinThread(worker, NULL);
    job_busy = 0;
    if (job == JOB_DISCOVER) {
        log_event("init attempt=%d result=%d deadline=%d discover=%d elapsed_ms=%lld",
                  network_attempt, job_network_result, job_init_deadline, job_result,
                  wj_milliseconds() - job_started);
        if (job_network_result < 0)
            snprintf(network_status, sizeof(network_status), "Network %s (%d); 1: retry", job_init_deadline ? "deadline" : "init failed", job_network_result);
        else snprintf(network_status, sizeof(network_status), "Network connected | Wii %s", job_ip);
        next_discovery = wj_milliseconds() + 5000;
        server_count = job_result > 0 ? job_result : 0;
        count = server_count;
        selected = 0;
        for (int i = 0; i < count; i++) {
            copy(menu.items[i].title, sizeof(menu.items[i].title), servers[i].name);
            if (job_direct || (saved_id[0] && !strcmp(saved_id, servers[i].id))) {
                choose_server(i);
                return;
            }
        }
        if (count) message[0] = 0;
        else if (job_result < 0) snprintf(message, sizeof(message),
            "Network/discovery error %d. 1: retry", job_result);
        else copy(message, sizeof(message), "No server found on your network.");
        return;
    }
    if (job == JOB_REDISCOVER) {
        log_event("rediscover result=%d", job_result);
        if (job_result > 0) {
            snprintf(message, sizeof(message), "Server found at %s", server.ip);
            status_failures = 0;
            next_status = 0;
        }
        return;
    }
    if (job == JOB_STATUS && job_result != 200) {
        // Keep the last known song on screen and poll less often while the
        // server is away, instead of replacing the message every second.
        if (++status_failures == 2) copy(message, sizeof(message), not_responding);
        int delay = 1000 << (status_failures < 4 ? status_failures : 3);
        next_status = wj_milliseconds() + delay;
        log_event("status failure count=%d stage=%s error=%d", status_failures,
                  wj_http_stage_name(job_trace.stage), job_trace.error);
        return;
    }
    if (job == JOB_STATUS) {
        if (!strcmp(message, not_responding)) message[0] = 0;
        status_failures = 0;
    }
    if (job == JOB_LIST || job_result != 200) {
        log_event("http job=%d stage=%s error=%d status=%d bytes=%d expected=%d elapsed_ms=%lld",
                  job, wj_http_stage_name(job_trace.stage), job_trace.error, job_trace.status,
                  job_trace.received, job_trace.expected, job_trace.elapsed_ms);
    }
    if (job_result != 200) {
        struct wj_document doc;
        if (!wj_document(reply, &doc) && doc.count && doc.rows[0].count >= 2 &&
            !strcmp(doc.rows[0].field[0], "error")) {
            copy(message, sizeof(message), doc.rows[0].field[1]);
        } else snprintf(message, sizeof(message), "Request %s failed (%d)",
                        wj_http_stage_name(job_trace.stage), job_result);
        return;
    }
    struct wj_document doc;
    if (wj_document(reply, &doc)) {
        if (job == JOB_LIST) {
            log_event("menu malformed bytes=%d", job_trace.received);
        }
        copy(message, sizeof(message), "Unsupported or malformed server response");
        return;
    }
    if (job == JOB_CONTROL) {
        if (doc.count == 1 && doc.rows[0].count == 3 &&
            !strcmp(doc.rows[0].field[0], "ok") && !strcmp(doc.rows[0].field[1], "accepted") &&
            !wj_number(doc.rows[0].field[2], 1, 2147483647, &pending_command)) {
            copy(message, sizeof(message), "Accepted; waiting for server result...");
        } else copy(message, sizeof(message), "Command accepted; update server for completion status");
        next_status = 0;
        return;
    }
    if (job == JOB_STATUS) {
        progress_available = 0;
        for (int i = 0; i < doc.count; i++) {
            struct wj_row *row = &doc.rows[i];
            if (row->count == 4 && !strcmp(row->field[0], "command") && pending_command) {
                int id;
                if (!wj_number(row->field[2], 1, 2147483647, &id) && id == pending_command) {
                    copy(message, sizeof(message), row->field[1]);
                    if (!strcmp(row->field[3], "complete") || !strcmp(row->field[3], "failed")) pending_command = 0;
                }
            } else if (row->count == 3 && !strcmp(row->field[0], "progress")) {
                progress_available = !wj_number(row->field[1], 0, 2147483647, &position_ms) &&
                    !wj_number(row->field[2], 0, 2147483647, &duration_ms);
            } else if (row->count >= 4 && !strcmp(row->field[0], "status")) {
                copy(now_playing, sizeof(now_playing), row->field[1]);
                copy(artist, sizeof(artist), row->field[2]);
                copy(play_state, sizeof(play_state), row->field[3]);
            }
        }
        return;
    }
    if (wj_menu_parse(&doc, screen == 1, location.offset, &menu)) {
        log_event("menu rejected screen=%d rows=%d offset=%d", screen, doc.count, location.offset);
        copy(message, sizeof(message), "Invalid list reply");
        return;
    }
    count = menu.count;
    total = menu.total;
    log_event("menu accepted screen=%d rows=%d items=%d total=%d", screen, doc.count, count, total);
    selected = location.selected < count ? location.selected : 0;
    if (count) message[0] = 0;
    else if (screen == 1) copy(message, sizeof(message), "No configured sources");
    else if (!strcmp(source, "radio") || !strcmp(source, "ytdlp"))
        copy(message, sizeof(message), "No saved entries. Add them in the web UI.");
    else copy(message, sizeof(message), "This folder is empty.");
}

static void play_item(int whole_list) {
    if (!count || screen != 2) return;
    const char *ref = menu.items[selected].ref;
    if (whole_list && (!strcmp(location.type, "album") || !strcmp(location.type, "playlist")))
        ref = location.ref;
    else if (whole_list && strcmp(menu.items[selected].type, "album") &&
             strcmp(menu.items[selected].type, "playlist")) {
        copy(message, sizeof(message), "Choose an album or playlist first.");
        return;
    }
    char path[256];
    snprintf(path, sizeof(path), "/api/wii/play?source=%s&ref=%s", source, ref);
    copy(message, sizeof(message), "Starting selection...");
    copy(play_state, sizeof(play_state), "queued");
    position_ms = 0;
    start_job(JOB_CONTROL, "POST", path);
}

static void select_item(void) {
    if (!count) return;
    if (screen == 0) { choose_server(selected); return; }
    if (screen == 1) {
        copy(source, sizeof(source), menu.items[selected].ref);
        copy(title, sizeof(title), menu.items[selected].title);
        memset(&location, 0, sizeof(location));
        screen = 2;
        depth = 0;
    } else {
        const char *type = menu.items[selected].type;
        if (!strcmp(type, "track") || !strcmp(type, "station")) { play_item(0); return; }
        if (depth == DEPTH) { copy(message, sizeof(message), "Folder depth limit reached"); return; }
        location.selected = selected;
        stack[depth++] = location;
        memset(&location, 0, sizeof(location));
        copy(location.ref, sizeof(location.ref), menu.items[selected].ref);
        copy(location.type, sizeof(location.type), type);
        copy(location.title, sizeof(location.title), menu.items[selected].title);
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
    char text[512], line[73];
    va_list args;
    va_start(args, format);
    vsnprintf(text, sizeof(text), format, args);
    va_end(args);
    wj_display_text(text);
    int columns, rows;
    CON_GetMetrics(&columns, &rows);
    if (row < 1 || row >= rows || row > 28) return;
    int width = columns - 1 < 72 ? columns - 1 : 72;
    int length = (int)strlen(text);
    for (int i = 0; i < width; i++) {
        unsigned char c = i < length ? (unsigned char)text[i] : ' ';
        line[i] = c >= 32 && c < 127 ? c : '?';
    }
    line[width] = 0;
    if (!strcmp(previous_lines[row - 1], line)) return;
    printf("\x1b[%d;1H%s", row, line);
    copy(previous_lines[row - 1], sizeof(previous_lines[0]), line);
}

static void draw(void) {
    draw_line(1, "WiiJukebox  |  native client prototype");
    draw_line(2, "%s", "");
    draw_line(3, "%s", location.title[0] && screen == 2 ? location.title : title);
    if (job_busy && job == JOB_DISCOVER) {
        static const char *phases[] = { "initializing", "reading IP", "server lookup", "discovery", "IOS cleanup" };
        LWP_MutexLock(mutex);
        enum network_phase phase = network_phase;
        LWP_MutexUnlock(mutex);
        draw_line(4, "Attempt %d: %s %llds | 1 restart", network_attempt,
                  phases[phase], (wj_milliseconds() - discovery_started) / 1000);
    } else draw_line(4, "%s", network_status);
    for (int i = 0; i < PAGE_SIZE; i++) {
        draw_line(5 + i, "%s %.65s", i < count && i == selected ? ">" : " ",
                  i < count ? menu.items[i].title : "");
    }
    draw_line(17, "%s", "");
    if (screen == 2 && total > 0) {
        draw_line(18, "Page %d / %d | %d-%d of %d | Left/right: page",
                  location.offset / PAGE_SIZE + 1, (total - 1) / PAGE_SIZE + 1,
                  count ? location.offset + 1 : 0, location.offset + count, total);
    } else draw_line(18, "%s", "");
    draw_line(19, "%s", screen ? "A: open/play | B: back | Up/down: select" : "A: choose server | Up/down: select | 1: search again");
    char playback_label[24];
    copy(playback_label, sizeof(playback_label), play_state);
    if (playback_label[0] >= 'a' && playback_label[0] <= 'z') playback_label[0] -= 'a' - 'A';
    draw_line(20, "%.10s  %.57s", playback_label, now_playing);
    draw_line(21, "%s", artist);
    char progress[73] = "";
    if (progress_available && strcmp(play_state, "idle")) wj_progress(progress, sizeof(progress), position_ms, duration_ms);
    draw_line(22, "%s", progress);
    draw_line(23, "HOME exit | +/- volume %d%% | 1 refresh/retry", volume * 100 / 255);
    draw_line(24, "Left/right page | B + left/right skip track");
    draw_line(25, "B+1 pause | B+2 stop | B+A play list | 2 visualizer");
    int buffered_tenths = (int)((long long)audio.buffered * 80 / ((audio.bitrate ? audio.bitrate : 128) * 1000));
    char connection[48];
    if (!audio_running) copy(connection, sizeof(connection), "Disconnected");
    else if (!audio.connected) snprintf(connection, sizeof(connection), "Reconnecting (%d)", audio.failures);
    else copy(connection, sizeof(connection), stream_started ? "Connected" : "Buffering");
    draw_line(26, "%s | %d kbps | Buffer %d.%ds | Audio restarts %d", connection, audio.bitrate,
              buffered_tenths / 10, buffered_tenths % 10, audio_underruns);
    draw_line(27, "%s", message);
    draw_line(28, "%s", "");
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
    int pcm_available = wj_pcm_init() == 0;
    MP3Player_Volume(volume);
    LWP_MutexInit(&mutex, false);
    storage = fatInitDefault();
    if (storage) {
        mkdir("sd:/apps", 0777);
        mkdir("sd:/apps/wiijukebox", 0777);
        FILE *file = fopen("sd:/apps/wiijukebox/server.id", "r");
        if (file) { if (fgets(saved_id, sizeof(saved_id), file)) saved_id[strcspn(saved_id, "\r\n")] = 0; fclose(file); }
    }
    log_event("launch audible-clock-1 discovery_port=%d", WJ_DISCOVERY_PORT);
    start_job(JOB_DISCOVER, NULL, NULL);
    long long last_draw = 0;
    int b_combo = 0, visualizer = 0;
    u32 pending_buttons = 0;
    int pending_back = 0, pending_combo = 0;
    while (SYS_MainLoop()) {
        WPAD_ScanPads();
        u32 down = WPAD_ButtonsDown(0), held = WPAD_ButtonsHeld(0), up = WPAD_ButtonsUp(0);
        if (down & WPAD_BUTTON_HOME) break;
        finish_job();
        if ((down & WPAD_BUTTON_2) && !(held & WPAD_BUTTON_B)) {
            down &= ~WPAD_BUTTON_2;
            if (visualizer) {
                wj_visualizer_leave(framebuffer);
                visualizer = 0;
                VIDEO_ClearFrameBuffer(mode, framebuffer, COLOR_BLACK);
                memset(previous_lines, 0, sizeof(previous_lines));
            } else if (!pcm_available) {
                copy(message, sizeof(message), "Could not initialize visualizer audio tap");
            } else if (!wj_visualizer_enter(mode)) visualizer = 1;
            else {
                wj_visualizer_leave(framebuffer);
                copy(message, sizeof(message), wj_visualizer_error());
            }
        }
        if (visualizer && (up & WPAD_BUTTON_B) && !b_combo) {
            wj_visualizer_leave(framebuffer);
            visualizer = 0;
            up &= ~WPAD_BUTTON_B;
            VIDEO_ClearFrameBuffer(mode, framebuffer, COLOR_BLACK);
            memset(previous_lines, 0, sizeof(previous_lines));
        }
        if (visualizer && !(held & WPAD_BUTTON_B)) {
            down &= ~(WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_LEFT |
                      WPAD_BUTTON_RIGHT | WPAD_BUTTON_UP | WPAD_BUTTON_DOWN);
        }
        if (down & WPAD_BUTTON_PLUS) { volume = volume < 239 ? volume + 16 : 255; MP3Player_Volume(volume); }
        if (down & WPAD_BUTTON_MINUS) { volume = volume > 16 ? volume - 16 : 0; MP3Player_Volume(volume); }
        if (down & WPAD_BUTTON_UP) selected = count ? (selected + count - 1) % count : 0;
        if (down & WPAD_BUTTON_DOWN) selected = count ? (selected + 1) % count : 0;
        u32 action = down & (WPAD_BUTTON_A | WPAD_BUTTON_1 | WPAD_BUTTON_2 | WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT);
        if (action) {
            pending_buttons = action;
            if (job_busy && screen) copy(message, sizeof(message), "Input queued; waiting for network request...");
            pending_combo = (held & WPAD_BUTTON_B) && screen;
            if (pending_combo) b_combo = 1;
            if ((action & WPAD_BUTTON_1) && !screen && job_busy && job == JOB_DISCOVER) {
                log_event("restart requested attempt=%d elapsed_ms=%lld",
                          network_attempt, wj_milliseconds() - discovery_started);
                LWP_MutexLock(mutex);
                cancel_discovery = 1;
                LWP_MutexUnlock(mutex);
                copy(message, sizeof(message), "Restart requested; resetting network...");
            }
        }
        if ((up & WPAD_BUTTON_B) && !b_combo) { pending_back = 1; pending_buttons = 0; }
        if (!job_busy) {
            u32 pressed = pending_buttons;
            int back = pending_back, combo = pending_combo;
            pending_buttons = 0;
            pending_back = pending_combo = 0;
            if (combo && screen && pressed) {
                if (pressed & WPAD_BUTTON_A) play_item(1);
                else if (pressed & WPAD_BUTTON_LEFT) control("previous");
                else if (pressed & WPAD_BUTTON_RIGHT) control("next");
                else if (pressed & WPAD_BUTTON_2) control("stop");
                else control(!strcmp(play_state, "paused") ? "play" : "pause");
            } else if (pressed & WPAD_BUTTON_A) select_item();
            else if (pressed & WPAD_BUTTON_1) {
                if (!screen) start_job(JOB_DISCOVER, NULL, NULL);
                else load_list();
            } else if (screen == 2 && (pressed & (WPAD_BUTTON_LEFT | WPAD_BUTTON_RIGHT))) {
                int offset = location.offset + (pressed & WPAD_BUTTON_RIGHT ? PAGE_SIZE : -PAGE_SIZE);
                if (offset >= 0 && offset < total) {
                    count = selected = 0;
                    location.offset = offset;
                    location.selected = 0;
                    load_list();
                }
            } else if (back) {
                if (screen == 2) {
                    count = selected = 0;
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
        update_audio();
        if (screen && !job_busy) {
            int lost = audio.failures >= 3 || status_failures >= 3;
            if (lost && now >= next_rediscovery) {
                next_rediscovery = now + 10000;
                start_job(JOB_REDISCOVER, NULL, NULL);
            } else if (now >= next_status) {
                next_status = now + (pending_command ? 500 : strcmp(play_state, "idle") ? 1000 : 3000);
                struct wj_playback_clock clock = wj_mp3_clock();
                char path[180];
                snprintf(path, sizeof(path), "/api/wii/status?audible=1&epoch=%d&byte=%lld&played=%lld",
                         decode_epoch, stream_started && clock.ready ? clock.byte : -1,
                         stream_started && clock.ready ? clock.milliseconds : -1);
                start_job(JOB_STATUS, "GET", path);
            }
        }
        if (visualizer) {
            if (wj_visualizer_render()) {
                wj_visualizer_leave(framebuffer);
                visualizer = 0;
                VIDEO_ClearFrameBuffer(mode, framebuffer, COLOR_BLACK);
                memset(previous_lines, 0, sizeof(previous_lines));
                copy(message, sizeof(message), wj_visualizer_error());
            }
        } else if (now - last_draw > 100 || down || up) { draw(); last_draw = now; }
        VIDEO_WaitVSync();
    }
    LWP_MutexLock(mutex);
    exiting = 1;
    LWP_MutexUnlock(mutex);
    if (job_busy) LWP_JoinThread(worker, NULL);
    stop_audio();
    wj_visualizer_leave(framebuffer);
    wj_visualizer_shutdown();
    net_deinit();
    LWP_MutexDestroy(mutex);
    ASND_End();
    return 0;
}
