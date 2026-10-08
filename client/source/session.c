// SPDX-License-Identifier: GPL-3.0-only
#include "session.h"
#include "net.h"
#include "wire.h"
#include "init_wait.h"
#include "playback_clock.h"
#include "discovery_port.h"
#include <gccore.h>
#include <asndlib.h>
#include <mp3player.h>
#include <fat.h>
#include <network.h>
#include <ogc/mutex.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if WJ_DISCOVERY_PORT < 1 || WJ_DISCOVERY_PORT > 65535
#error "DISCOVERY_PORT must be between 1 and 65535"
#endif

#define DEPTH 16
#define ART_BYTES (WJ_ART_SIZE * WJ_ART_SIZE * 2)
#define LARGE_ART_BYTES (WJ_ART_LARGE * WJ_ART_LARGE * 2)

enum job_kind { JOB_NONE, JOB_DISCOVER, JOB_REDISCOVER, JOB_LIST, JOB_STATUS, JOB_CONTROL, JOB_ART };
enum network_phase { NETWORK_INIT, NETWORK_IP, NETWORK_LOOKUP, NETWORK_SCAN, NETWORK_CLEANUP };
struct location { char ref[64], type[24], title[257]; int offset, selected; };

static struct wj_session S = { .volume = 160 };
static struct wj_server servers[WJ_SERVERS], server;
static struct location stack[DEPTH], location;
static char source[64], source_title[257], saved_id[37], direct_address[32];
static int storage, decode_epoch, status_failures, pending_command;
/* The last jump marker seen; -1 until the first status sets the baseline, so a
   change made before this client connected is never replayed. */
static int jump_seen = -1;
static long long next_status, next_discovery, next_rediscovery, next_art;
/* After a transport command, poll quickly until its jump marker arrives. */
static long long fast_status_until;
static char art_key[17], art_loaded[17], art_failed[17], art_request[17];
static char large_loaded[17], large_failed[17];
static int art_request_size, want_large;
static unsigned char art[ART_BYTES] ATTRIBUTE_ALIGN(32);
static unsigned char art_large[LARGE_ART_BYTES] ATTRIBUTE_ALIGN(32);
static enum wj_action queued;
static int queued_argument;
static const char *const not_responding = "Server not responding; retrying...";

static mutex_t mutex;
static lwp_t worker;
static int job_done, job_result, exiting, cancel_discovery;
static enum job_kind job;
static char job_path[2048], job_method[8], reply[WJ_BODY];
static char job_ip[16];
static int job_network_result, job_direct, job_init_deadline;
static long long job_started;
static struct wj_http_trace job_trace;
static enum network_phase network_phase;

const struct wj_session *wj_session(void) { return &S; }
const unsigned char *wj_session_art(void) { return art; }
const unsigned char *wj_session_large_art(void) { return art_large; }
void wj_session_want_large_art(int want) { want_large = want; }

static void copy(char *out, size_t size, const char *in) { snprintf(out, size, "%s", in); }
/* Transient messages fade after a few seconds; held ones stay until replaced
   or cleared, because they describe a condition that still applies. */
static void post(const char *text, int held) {
    copy(S.message, sizeof(S.message), text);
    S.message_held = held;
    S.message_at = wj_milliseconds();
}
static void say(const char *text) { post(text, 0); }
static void hold(const char *text) { post(text, 1); }
void wj_session_set_message(const char *text) { say(text); }

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
    fprintf(file, "wall=%lld mono_ms=%lld ", (long long)time(NULL), wj_milliseconds());
    va_list args;
    va_start(args, format);
    vfprintf(file, format, args);
    va_end(args);
    fputc('\n', file);
    fclose(file);
}

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

/* Finds the remembered server's new address without leaving the current
   screen; the audio thread reads `server` under the same mutex. */
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
    if (S.busy) return;
    if (kind == JOB_DISCOVER) {
        LWP_MutexLock(mutex);
        cancel_discovery = 0;
        LWP_MutexUnlock(mutex);
        S.attempt++;
        S.discovery_started = wj_milliseconds();
        copy(S.network, sizeof(S.network), "Initializing network...");
        hold("Connecting...");
    }
    job = kind;
    job_started = wj_milliseconds();
    copy(job_method, sizeof(job_method), method ? method : "GET");
    copy(job_path, sizeof(job_path), path ? path : "");
    reply[0] = 0;
    S.busy = 1;
    job_done = 0;
    if (LWP_CreateThread(&worker, run_job, NULL, NULL, 65536, 60) < 0) {
        S.busy = 0;
        hold("Could not create network worker");
    }
}

static void load_list(void) {
    char path[512];
    if (S.view == WJ_VIEW_SOURCES) copy(path, sizeof(path), "/api/wii/sources");
    else snprintf(path, sizeof(path), "/api/wii/browse?source=%s&ref=%s&offset=%d",
                  source, location.ref, location.offset);
    hold("Loading...");
    S.empty[0] = 0;
    start_job(JOB_LIST, "GET", path);
}

static void save_server(void) {
    copy(saved_id, sizeof(saved_id), server.id);
    if (!storage) return;
    FILE *file = fopen("sd:/apps/wiijukebox/server.id", "w");
    if (file) { fprintf(file, "%s\n", saved_id); fclose(file); }
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
    S.audio_running = S.stream_started = 0;
    memset(&S.audio, 0, sizeof(S.audio));
}

static void clear_playing(void) {
    S.song[0] = S.artist[0] = 0;
    copy(S.state, sizeof(S.state), "idle");
    S.capabilities = 0;
    S.has_progress = 0;
    art_key[0] = 0;
}

static void choose_server(int index) {
    stop_audio();
    LWP_MutexLock(mutex);
    server = servers[index];
    LWP_MutexUnlock(mutex);
    save_server();
    copy(S.server_name, sizeof(S.server_name), server.name);
    copy(S.server_id, sizeof(S.server_id), server.id);
    S.view = WJ_VIEW_SOURCES;
    S.selected = S.count = S.depth = 0;
    status_failures = 0;
    copy(S.title, sizeof(S.title), "Music sources");
    S.audio_running = !wj_audio_start(open_stream);
    if (!S.audio_running) hold("Could not start the audio connection");
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
    if (!S.audio_running) return;
    struct wj_audio_state audio = S.audio = wj_audio_state();
    int target = wj_audio_bytes(WJ_AUDIO_TARGET_MS, audio.bitrate);
    if (S.stream_started && audio.stale) {
        MP3Player_Stop();
        S.stream_started = 0;
    } else if (S.stream_started && !MP3Player_IsPlaying()) {
        MP3Player_Stop();
        S.stream_started = 0;
        S.underruns++;
        log_event("underrun count=%d connected=%d buffered=%d", S.underruns, audio.connected, audio.buffered);
        hold("Refilling audio buffer...");
    } else if (S.stream_started && audio.buffered > wj_audio_bytes(WJ_AUDIO_RESYNC_MS, audio.bitrate)) {
        log_event("resync buffered=%d bitrate=%d", audio.buffered, audio.bitrate);
        wj_audio_resync();
    }
    if (S.stream_started || audio.buffered < wj_audio_bytes(WJ_AUDIO_PREBUFFER_MS, audio.bitrate)) return;
    long long byte = wj_audio_begin_decode(audio.buffered > target * 3 / 2 ? target : 0);
    wj_mp3_clock_start(byte);
    if (MP3Player_PlayFile(NULL, audio_read, NULL) < 0) return;
    S.stream_started = 1;
    decode_epoch = audio.epoch;
    if (!strcmp(S.message, "Refilling audio buffer...")) S.message[0] = 0;
}

static unsigned parse_capabilities(const char *list) {
    static const struct { const char *name; unsigned flag; } names[] = {
        { "play", WJ_CAN_PLAY }, { "pause", WJ_CAN_PAUSE }, { "stop", WJ_CAN_STOP },
        { "next", WJ_CAN_NEXT }, { "previous", WJ_CAN_PREVIOUS }, { "seek", WJ_CAN_SEEK },
    };
    unsigned flags = 0;
    while (*list) {
        size_t length = strcspn(list, ",");
        for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
            if (strlen(names[i].name) == length && !strncmp(list, names[i].name, length)) flags |= names[i].flag;
        }
        list += length;
        if (*list) list++;
    }
    return flags;
}

static void finish_discovery(void) {
    log_event("init attempt=%d result=%d deadline=%d discover=%d elapsed_ms=%lld",
              S.attempt, job_network_result, job_init_deadline, job_result,
              wj_milliseconds() - job_started);
    if (job_network_result < 0)
        copy(S.network, sizeof(S.network), job_init_deadline ? "Network timed out" : "Not connected to the network");
    else snprintf(S.network, sizeof(S.network), "Wii %s", job_ip);
    next_discovery = wj_milliseconds() + 5000;
    int found = job_result > 0 ? job_result : 0;
    memset(&S.menu, 0, sizeof(S.menu));
    S.count = S.total = found;
    S.selected = 0;
    for (int i = 0; i < found; i++) {
        copy(S.menu.items[i].title, sizeof(S.menu.items[i].title), servers[i].name);
        snprintf(S.menu.items[i].subtitle, sizeof(S.menu.items[i].subtitle), "ID %.8s", servers[i].id);
        copy(S.menu.items[i].type, sizeof(S.menu.items[i].type), "server");
        if (job_direct || (saved_id[0] && !strcmp(saved_id, servers[i].id))) {
            choose_server(i);
            return;
        }
    }
    char text[200];
    if (found) S.message[0] = 0;
    else if (job_network_result < 0) hold("The Wii couldn't join the network. Check its Internet settings, then press 1 to retry.");
    else if (direct_address[0]) {
        snprintf(text, sizeof(text), "The server at %s didn't answer. Check that it's running, then press 1 to retry.", direct_address);
        hold(text);
    } else if (job_result < 0)
        hold("Server discovery isn't available on this network. Launch with the server's address (see README), or press 1 to retry.");
    else hold("No server answered. Check that it's running on this network, or launch with its address (see README).");
}

static void finish_status(struct wj_document *doc) {
    if (!strcmp(S.message, not_responding)) S.message[0] = 0;
    status_failures = 0;
    S.has_progress = 0;
    for (int i = 0; i < doc->count; i++) {
        struct wj_row *row = &doc->rows[i];
        if (row->count == 4 && !strcmp(row->field[0], "command") && pending_command) {
            int id;
            if (!wj_number(row->field[2], 1, 2147483647, &id) && id == pending_command) {
                int finished = !strcmp(row->field[3], "complete") || !strcmp(row->field[3], "failed");
                post(row->field[1], !finished);
                if (finished) pending_command = 0;
            }
        } else if (row->count == 3 && !strcmp(row->field[0], "progress")) {
            S.has_progress = !wj_number(row->field[1], 0, 2147483647, &S.position_ms) &&
                !wj_number(row->field[2], 0, 2147483647, &S.duration_ms);
        } else if (row->count >= 4 && !strcmp(row->field[0], "status")) {
            copy(S.song, sizeof(S.song), row->field[1]);
            copy(S.artist, sizeof(S.artist), row->field[2]);
            copy(S.state, sizeof(S.state), row->field[3]);
            S.capabilities = row->count >= 6 ? parse_capabilities(row->field[5]) : 0;
        } else if (row->count == 4 && !strcmp(row->field[0], "jump")) {
            int id, epoch;
            long long byte = strtoll(row->field[3], NULL, 10);
            if (wj_number(row->field[1], 1, 2147483647, &id) || wj_number(row->field[2], 1, 2147483647, &epoch)) continue;
            if (jump_seen >= 0 && id != jump_seen && wj_audio_jump(epoch, byte))
                log_event("jump id=%d byte=%lld", id, byte);
            jump_seen = id;
        } else if (row->count == 2 && !strcmp(row->field[0], "art")) {
            if (strlen(row->field[1]) < sizeof(art_key) && strspn(row->field[1], "0123456789abcdef") == strlen(row->field[1]))
                copy(art_key, sizeof(art_key), row->field[1]);
        }
    }
    if (jump_seen < 0) jump_seen = 0;
    // The heard position catching up to the target ends the optimistic display.
    if (S.seek_until && (wj_milliseconds() > S.seek_until ||
        (S.has_progress && abs(S.position_ms - S.seek_target_ms) < 3000))) S.seek_until = 0;
}

static void finish_art(void) {
    if (art_request_size == WJ_ART_LARGE) {
        if (job_result == 200 && job_trace.received == LARGE_ART_BYTES) {
            memcpy(art_large, reply, LARGE_ART_BYTES);
            copy(large_loaded, sizeof(large_loaded), art_request);
            S.large_art_version++;
        } else copy(large_failed, sizeof(large_failed), art_request);
        return;
    }
    if (job_result == 200 && job_trace.received == ART_BYTES) {
        memcpy(art, reply, ART_BYTES);
        copy(art_loaded, sizeof(art_loaded), art_request);
        S.has_art = 1;
        S.art_version++;
    } else {
        copy(art_failed, sizeof(art_failed), art_request);
        next_art = wj_milliseconds() + 30000;
        log_event("art key=%s result=%d bytes=%d", art_request, job_result, job_trace.received);
    }
}

static void finish_job(void) {
    LWP_MutexLock(mutex);
    int done = job_done;
    LWP_MutexUnlock(mutex);
    if (!S.busy || !done) return;
    LWP_JoinThread(worker, NULL);
    S.busy = 0;
    if (job == JOB_DISCOVER) { finish_discovery(); return; }
    if (job == JOB_REDISCOVER) {
        log_event("rediscover result=%d", job_result);
        if (job_result > 0) {
            char text[64];
            snprintf(text, sizeof(text), "Server found at %s", server.ip);
            say(text);
            status_failures = 0;
            next_status = 0;
        }
        return;
    }
    if (job == JOB_ART) { finish_art(); return; }
    if (job == JOB_STATUS && job_result != 200) {
        // Keep the last known song on screen and poll less often while the
        // server is away, instead of replacing the message every second.
        if (++status_failures == 2) hold(not_responding);
        next_status = wj_milliseconds() + (1000 << (status_failures < 4 ? status_failures : 3));
        log_event("status failure count=%d stage=%s error=%d", status_failures,
                  wj_http_stage_name(job_trace.stage), job_trace.error);
        return;
    }
    if (job == JOB_LIST || job_result != 200) {
        log_event("http job=%d stage=%s error=%d status=%d bytes=%d expected=%d elapsed_ms=%lld",
                  job, wj_http_stage_name(job_trace.stage), job_trace.error, job_trace.status,
                  job_trace.received, job_trace.expected, job_trace.elapsed_ms);
    }
    struct wj_document doc;
    if (job_result != 200) {
        if (!wj_document(reply, &doc) && doc.count && doc.rows[0].count >= 2 &&
            !strcmp(doc.rows[0].field[0], "error")) {
            say(doc.rows[0].field[1]);
        } else {
            char text[64];
            snprintf(text, sizeof(text), "Request %s failed (%d)", wj_http_stage_name(job_trace.stage), job_result);
            say(text);
        }
        if (job == JOB_CONTROL) S.seek_until = 0;
        return;
    }
    if (wj_document(reply, &doc)) {
        if (job == JOB_LIST) log_event("menu malformed bytes=%d", job_trace.received);
        say("Unsupported or malformed server response");
        return;
    }
    if (job == JOB_CONTROL) {
        if (doc.count == 1 && doc.rows[0].count == 3 &&
            !strcmp(doc.rows[0].field[0], "ok") && !strcmp(doc.rows[0].field[1], "accepted") &&
            !wj_number(doc.rows[0].field[2], 1, 2147483647, &pending_command)) {
            hold("Accepted; waiting for server result...");
        } else say("Command accepted; update server for completion status");
        next_status = 0;
        fast_status_until = wj_milliseconds() + 6000;
        return;
    }
    if (job == JOB_STATUS) { finish_status(&doc); return; }
    if (wj_menu_parse(&doc, S.view == WJ_VIEW_SOURCES, location.offset, &S.menu)) {
        log_event("menu rejected screen=%d rows=%d offset=%d", S.view, doc.count, location.offset);
        say("Invalid list reply");
        return;
    }
    S.count = S.menu.count;
    S.total = S.menu.total;
    S.offset = location.offset;
    log_event("menu accepted screen=%d rows=%d items=%d total=%d", S.view, doc.count, S.count, S.total);
    S.selected = location.selected < S.count ? location.selected : 0;
    S.message[0] = 0;
    if (S.count) S.empty[0] = 0;
    else if (S.view == WJ_VIEW_SOURCES) copy(S.empty, sizeof(S.empty), "No sources are set up yet. Add one in the web UI.");
    else if (!strcmp(source, "radio") || !strcmp(source, "ytdlp"))
        copy(S.empty, sizeof(S.empty), "No saved entries. Add them in the web UI.");
    else copy(S.empty, sizeof(S.empty), "This folder is empty.");
}

static void control(const char *action) {
    char path[80];
    snprintf(path, sizeof(path), "/api/wii/control?action=%s", action);
    start_job(JOB_CONTROL, "POST", path);
}

static void play_item(int whole_list) {
    if (!S.count || S.view != WJ_VIEW_BROWSE) return;
    const char *ref = S.menu.items[S.selected].ref;
    if (whole_list && (!strcmp(location.type, "album") || !strcmp(location.type, "playlist")))
        ref = location.ref;
    else if (whole_list && strcmp(S.menu.items[S.selected].type, "album") &&
             strcmp(S.menu.items[S.selected].type, "playlist")) {
        say("Choose an album or playlist first.");
        return;
    }
    char path[256];
    snprintf(path, sizeof(path), "/api/wii/play?source=%s&ref=%s", source, ref);
    hold("Starting selection...");
    copy(S.state, sizeof(S.state), "queued");
    S.position_ms = 0;
    S.seek_until = 0;
    start_job(JOB_CONTROL, "POST", path);
}

static void open_item(void) {
    if (!S.count) return;
    if (S.view == WJ_VIEW_SERVERS) { choose_server(S.selected); return; }
    if (S.view == WJ_VIEW_SOURCES) {
        copy(source, sizeof(source), S.menu.items[S.selected].ref);
        copy(source_title, sizeof(source_title), S.menu.items[S.selected].title);
        copy(S.title, sizeof(S.title), source_title);
        memset(&location, 0, sizeof(location));
        S.view = WJ_VIEW_BROWSE;
        S.depth = 0;
    } else {
        const char *type = S.menu.items[S.selected].type;
        if (!strcmp(type, "track") || !strcmp(type, "station")) { play_item(0); return; }
        if (S.depth == DEPTH) { say("Folder depth limit reached"); return; }
        location.selected = S.selected;
        stack[S.depth++] = location;
        memset(&location, 0, sizeof(location));
        copy(location.ref, sizeof(location.ref), S.menu.items[S.selected].ref);
        copy(location.type, sizeof(location.type), type);
        copy(location.title, sizeof(location.title), S.menu.items[S.selected].title);
        copy(S.title, sizeof(S.title), location.title);
    }
    S.count = S.selected = 0;
    load_list();
}

static void go_back(void) {
    if (S.view == WJ_VIEW_BROWSE) {
        S.count = S.selected = 0;
        if (S.depth) {
            location = stack[--S.depth];
            copy(S.title, sizeof(S.title), location.title[0] ? location.title : source_title);
        } else {
            S.view = WJ_VIEW_SOURCES;
            memset(&location, 0, sizeof(location));
            copy(S.title, sizeof(S.title), "Music sources");
        }
        load_list();
    } else if (S.view == WJ_VIEW_SOURCES) {
        stop_audio();
        clear_playing();
        S.view = WJ_VIEW_SERVERS;
        S.count = 0;
        copy(S.title, sizeof(S.title), "Choose a server");
        start_job(JOB_DISCOVER, NULL, NULL);
        saved_id[0] = 0; // Explicitly going back should show the chooser.
    }
}

static void perform(enum wj_action action, int argument) {
    int browsing = S.view != WJ_VIEW_SERVERS;
    switch (action) {
    case WJ_ACT_OPEN: open_item(); break;
    case WJ_ACT_BACK: go_back(); break;
    case WJ_ACT_REFRESH:
        if (!browsing) start_job(JOB_DISCOVER, NULL, NULL);
        else load_list();
        break;
    case WJ_ACT_PAGE_PREVIOUS:
    case WJ_ACT_PAGE_NEXT: {
        if (S.view != WJ_VIEW_BROWSE) break;
        int offset = location.offset + (action == WJ_ACT_PAGE_NEXT ? WJ_PAGE_SIZE : -WJ_PAGE_SIZE);
        if (offset < 0 || offset >= S.total) break;
        S.count = S.selected = 0;
        location.offset = offset;
        location.selected = 0;
        load_list();
        break;
    }
    case WJ_ACT_PLAY_LIST: if (browsing) play_item(1); break;
    case WJ_ACT_PREVIOUS: if (browsing) control("previous"); break;
    case WJ_ACT_NEXT: if (browsing) control("next"); break;
    case WJ_ACT_STOP: if (browsing) control("stop"); break;
    case WJ_ACT_PAUSE: if (browsing) control(!strcmp(S.state, "paused") ? "play" : "pause"); break;
    case WJ_ACT_SEEK: {
        if (!browsing) break;
        char path[96];
        snprintf(path, sizeof(path), "/api/wii/control?action=seek&position=%d", argument);
        S.seek_target_ms = argument;
        S.seek_until = wj_milliseconds() + 12000;
        start_job(JOB_CONTROL, "POST", path);
        break;
    }
    case WJ_ACT_NONE: break;
    }
}

void wj_session_act(enum wj_action action, int argument) {
    if (action == WJ_ACT_NONE) return;
    if (!S.busy) { perform(action, argument); return; }
    queued = action;
    queued_argument = argument;
    if (S.view != WJ_VIEW_SERVERS) say("Input queued; waiting for network request...");
}

int wj_session_restart_network(void) {
    if (S.view != WJ_VIEW_SERVERS || !S.busy || job != JOB_DISCOVER) return 0;
    log_event("restart requested attempt=%d elapsed_ms=%lld", S.attempt, wj_milliseconds() - S.discovery_started);
    LWP_MutexLock(mutex);
    cancel_discovery = 1;
    LWP_MutexUnlock(mutex);
    hold("Restart requested; resetting network...");
    return 1;
}

void wj_session_select(int index) {
    if (index >= 0 && index < S.count) S.selected = index;
}

void wj_session_move(int delta) {
    if (S.count) S.selected = ((S.selected + delta) % S.count + S.count) % S.count;
}

void wj_session_volume(int delta) {
    S.volume += delta;
    if (S.volume < 0) S.volume = 0;
    if (S.volume > 255) S.volume = 255;
    MP3Player_Volume(S.volume);
}

void wj_session_init(int argc, char **argv) {
    // wiiload can put the first application argument in argv[0]; HBC can
    // prepend the executable path. Accept the endpoint in either position.
    for (int i = 0; i < argc; i++) {
        if (strlen(argv[i]) < sizeof(direct_address) && strchr(argv[i], ':') &&
            strspn(argv[i], "0123456789.:") == strlen(argv[i])) {
            copy(direct_address, sizeof(direct_address), argv[i]);
            break;
        }
    }
    copy(S.title, sizeof(S.title), "Finding your server");
    copy(S.network, sizeof(S.network), "Network not initialized");
    clear_playing();
    MP3Player_Volume(S.volume);
    LWP_MutexInit(&mutex, false);
    storage = fatInitDefault();
    if (storage) {
        mkdir("sd:/apps", 0777);
        mkdir("sd:/apps/wiijukebox", 0777);
        FILE *file = fopen("sd:/apps/wiijukebox/server.id", "r");
        if (file) {
            if (fgets(saved_id, sizeof(saved_id), file)) saved_id[strcspn(saved_id, "\r\n")] = 0;
            fclose(file);
        }
    }
    log_event("launch gui-1 discovery_port=%d", WJ_DISCOVERY_PORT);
    start_job(JOB_DISCOVER, NULL, NULL);
}

static void request_art(int size) {
    char path[96];
    copy(art_request, sizeof(art_request), art_key);
    art_request_size = size;
    snprintf(path, sizeof(path), "/api/wii/art?key=%s&size=%d", art_key, size);
    start_job(JOB_ART, "GET", path);
}

void wj_session_update(void) {
    finish_job();
    static const char *phases[] = { "Initializing", "Reading IP address", "Looking up server", "Searching", "Cleaning up" };
    LWP_MutexLock(mutex);
    S.phase = phases[network_phase];
    LWP_MutexUnlock(mutex);
    S.discovering = S.busy && job == JOB_DISCOVER;
    long long now = wj_milliseconds();
    if (S.message[0] && !S.message_held && now - S.message_at > WJ_MESSAGE_MS) S.message[0] = 0;
    S.has_large_art = S.has_art && art_key[0] && !strcmp(art_key, large_loaded);
    update_audio();
    if (S.busy) return;
    if (queued) {
        enum wj_action action = queued;
        queued = WJ_ACT_NONE;
        perform(action, queued_argument);
        return;
    }
    if (S.view == WJ_VIEW_SERVERS) {
        if (!S.count && now >= next_discovery) start_job(JOB_DISCOVER, NULL, NULL);
        return;
    }
    if ((S.audio.failures >= 3 || status_failures >= 3) && now >= next_rediscovery) {
        next_rediscovery = now + 10000;
        start_job(JOB_REDISCOVER, NULL, NULL);
    } else if (now >= next_status) {
        next_status = now + (now < fast_status_until ? 250 : pending_command || S.seek_until ? 500 :
                             strcmp(S.state, "idle") ? 1000 : 3000);
        struct wj_playback_clock clock = wj_mp3_clock();
        char path[180];
        snprintf(path, sizeof(path), "/api/wii/status?audible=1&epoch=%d&byte=%lld&played=%lld",
                 decode_epoch, S.stream_started && clock.ready ? clock.byte : -1,
                 S.stream_started && clock.ready ? clock.milliseconds : -1);
        start_job(JOB_STATUS, "GET", path);
    } else if (!art_key[0] && S.has_art) {
        S.has_art = 0;
        art_loaded[0] = 0;
        S.art_version++;
    } else if (art_key[0] && strcmp(art_key, art_loaded) && (strcmp(art_key, art_failed) || now >= next_art)) {
        request_art(WJ_ART_SIZE);
    } else if (want_large && S.has_art && strcmp(art_key, large_loaded) && strcmp(art_key, large_failed)) {
        request_art(WJ_ART_LARGE);
    }
}

void wj_session_shutdown(void) {
    LWP_MutexLock(mutex);
    exiting = 1;
    LWP_MutexUnlock(mutex);
    if (S.busy) LWP_JoinThread(worker, NULL);
    stop_audio();
    net_deinit();
    LWP_MutexDestroy(mutex);
}
