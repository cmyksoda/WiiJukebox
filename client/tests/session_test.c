// SPDX-License-Identifier: GPL-3.0-only
// Runs the real session.c against fakes: pthreads for the worker, a directory for the SD card and a
// scripted network and server. Each scenario forks, since the session is one set of statics.
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static char sd_root[256];  // short enough that every path below fits its buffer

static const char *host_path(const char *path, char *out, size_t size) {
    if (strncmp(path, "sd:/", 4)) return path;
    snprintf(out, size, "%s/%s", sd_root, path + 4);
    return out;
}
static FILE *shim_fopen(const char *path, const char *mode) {
    char host[4096];
    return fopen(host_path(path, host, sizeof(host)), mode);
}
static int shim_remove(const char *path) {
    char host[4096];
    return remove(host_path(path, host, sizeof(host)));
}
static int shim_mkdir(const char *path, mode_t mode) {
    char host[4096];
    return mkdir(host_path(path, host, sizeof(host)), mode);
}
#define fopen shim_fopen
#define remove shim_remove
#define mkdir shim_mkdir
#include "session.c"
#undef fopen
#undef remove
#undef mkdir

static long long clock_ms = 1000;
static int fat_ok = 1, net_ok = 1, net_deinits, discover_calls, lookup_count;
static char lookups[16][32];
/* The server on the network: reachable at `endpoint` (empty for none). Discovery finds it when `discovered`. */
static struct { char endpoint[32], id[37], name[32]; int delay_ms, discovered, discover_result; } fake;
#define FAKE_ID "3f2a9c1e-77b0-4d42-9a10-0123456789ab"
#define OTHER_ID "aa11bb22-77b0-4d42-9a10-0123456789ab"

uint32_t wj_clock_test_ticks;
long long wj_milliseconds(void) { return clock_ms; }
bool fatInitDefault(void) { return fat_ok; }
s32 net_init_async(void *callback, void *data) { (void)callback; (void)data; return 0; }
s32 net_get_status(void) { return net_ok ? 0 : -ENETDOWN; }
void net_deinit(void) { net_deinits++; }
s32 if_config(char *ip, char *netmask, char *gateway, bool dhcp, int retries) {
    (void)netmask; (void)gateway; (void)dhcp; (void)retries;
    strcpy(ip, "192.168.0.8");
    return 0;
}
s32 LWP_MutexInit(mutex_t *mutex, bool recursive) {
    (void)recursive;
    *mutex = malloc(sizeof(pthread_mutex_t));
    return pthread_mutex_init(*mutex, NULL);
}
s32 LWP_MutexLock(mutex_t mutex) { return pthread_mutex_lock(mutex); }
s32 LWP_MutexUnlock(mutex_t mutex) { return pthread_mutex_unlock(mutex); }
s32 LWP_MutexDestroy(mutex_t mutex) { pthread_mutex_destroy(mutex); free(mutex); return 0; }
s32 LWP_CreateThread(lwp_t *thread, void *(*entry)(void *), void *argument, void *stack, u32 size, u8 priority) {
    (void)stack; (void)size; (void)priority;
    return pthread_create(thread, NULL, entry, argument);
}
s32 LWP_JoinThread(lwp_t thread, void **value) { return pthread_join(thread, value); }
void MP3Player_Volume(u32 volume) { (void)volume; }
void MP3Player_Stop(void) {}
bool MP3Player_IsPlaying(void) { return false; }
s32 MP3Player_PlayFile(void *data, s32 (*reader)(void *, void *, s32), void *stat) {
    (void)data; (void)reader; (void)stat;
    return -1;
}

const char *wj_http_stage_name(enum wj_http_stage stage) { (void)stage; return "stage"; }
int wj_open_audio(const struct wj_server *server, const char *path, int *status, struct wj_stream_clock *clock) {
    (void)server; (void)path; (void)status; (void)clock;
    return -1;
}
void wj_close(int fd) { (void)fd; }
int wj_audio_start(wj_audio_opener open) { (void)open; return 0; }
void wj_audio_stop(void) {}
void wj_audio_resync(void) {}
int wj_audio_jump(int epoch, long long byte) { (void)epoch; (void)byte; return 0; }
int wj_audio_read_wait(void *buffer, int size, int wait_ms) { (void)buffer; (void)size; (void)wait_ms; return 0; }
long long wj_audio_begin_decode(int keep) { (void)keep; return 0; }
struct wj_audio_state wj_audio_state(void) { struct wj_audio_state state = {0}; return state; }
int wj_audio_bytes(int milliseconds, int bitrate) { return milliseconds * (bitrate ? bitrate : 128) / 8; }

static void fill_server(struct wj_server *server) {
    memset(server, 0, sizeof(*server));
    sscanf(fake.endpoint, "%15[0-9.]:%d", server->ip, &server->port);
    snprintf(server->id, sizeof(server->id), "%s", fake.id);
    snprintf(server->name, sizeof(server->name), "%s", fake.name);
    snprintf(server->mount, sizeof(server->mount), "/stream");
}
int wj_lookup(struct wj_server *server, const char *endpoint) {
    snprintf(lookups[lookup_count++ % 16], sizeof(lookups[0]), "%s", endpoint);
    if (fake.delay_ms) usleep((useconds_t)fake.delay_ms * 1000);
    if (strcmp(endpoint, fake.endpoint)) return -1;
    fill_server(server);
    return 0;
}
int wj_discover(struct wj_server *servers, int capacity, const char *target, int port) {
    (void)capacity; (void)target; (void)port;
    discover_calls++;
    if (fake.delay_ms) usleep((useconds_t)fake.delay_ms * 1000);
    if (fake.discovered) fill_server(&servers[0]);
    return fake.discovered ? 1 : fake.discover_result;
}
int wj_request_traced(const struct wj_server *server, const char *method, const char *path, char *body,
                      size_t capacity, struct wj_http_trace *trace) {
    (void)server; (void)method;
    const char *reply = strstr(path, "/sources") ? "WIIJUKEBOX\t1\nsource\tradio\tInternet%20Radio\tready\n" :
        strstr(path, "/status") ? "WIIJUKEBOX\t1\nstatus\t\t\tidle\t\t\n" : "WIIJUKEBOX\t1\n";
    snprintf(body, capacity, "%s", reply);
    memset(trace, 0, sizeof(*trace));
    trace->received = (int)strlen(reply);
    return 200;
}

/* The SD card, as the tests see it. */
static void sd_write(const char *name, const char *text) {
    char dir[4096], path[8300];
    snprintf(dir, sizeof(dir), "%s/apps", sd_root);
    mkdir(dir, 0777);
    snprintf(dir, sizeof(dir), "%s/apps/wiijukebox", sd_root);
    mkdir(dir, 0777);
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *file = fopen(path, "w");
    assert(file);
    fputs(text, file);
    fclose(file);
}
static int sd_read(const char *name, char *out, size_t size) {
    char path[8300];
    snprintf(path, sizeof(path), "%s/apps/wiijukebox/%s", sd_root, name);
    FILE *file = fopen(path, "r");
    if (!file) return -1;
    size_t length = fread(out, 1, size - 1, file);
    out[length] = 0;
    fclose(file);
    return 0;
}
static int sd_has(const char *name) { char text[256]; return !sd_read(name, text, sizeof(text)); }
static void assert_sd(const char *name, const char *expected) {
    char text[256];
    assert(!sd_read(name, text, sizeof(text)));
    if (strcmp(text, expected)) fprintf(stderr, "%s holds \"%s\", expected \"%s\"\n", name, text, expected);
    assert(!strcmp(text, expected));
}

static void settle(void) {
    for (int i = 0; i < 160; i++) {
        clock_ms += 10;
        wj_session_update();
        usleep(1000);
    }
}
static void start(int argc, char **argv) {
    wj_session_init(argc, argv);
}
static int key_for(char c) {
    for (int i = 0; i < WJ_KEY_COUNT; i++)
        if (wj_keypad[i].kind == WJ_KEY_CHAR && wj_keypad[i].character == c) return i;
    abort();
}
static int kind_key(enum wj_key_kind kind) {
    for (int i = 0; i < WJ_KEY_COUNT; i++)
        if (wj_keypad[i].kind == kind) return i;
    abort();
}
static void type(const char *text) {
    for (; *text; text++) wj_session_entry_press(key_for(*text));
}
static void present(const char *endpoint, const char *id) {
    snprintf(fake.endpoint, sizeof(fake.endpoint), "%s", endpoint);
    snprintf(fake.id, sizeof(fake.id), "%s", id);
}

static void typed_address_flow(void) {
    start(0, NULL);
    settle();
    assert(S.view == WJ_VIEW_SERVERS && !S.count && !S.busy);
    assert(strstr(S.message, "enter") || strstr(S.message, "Enter"));
    assert(!strcmp(S.network, "Wii 192.168.0.8"));

    wj_session_entry_open();
    const struct wj_entry *e = &S.entry;
    assert(e->open && !e->connecting && !S.home_open && !strcmp(e->text, "192.168.0."));
    // Too little to connect with: a message, and no network request.
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    assert(e->failed && !e->connecting && !strcmp(e->message, wj_address_error_text(WJ_ADDRESS_INCOMPLETE)));
    assert(!S.busy);
    // Nobody home at that address: the reason shows in the numpad and nothing is saved.
    type("3");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    assert(e->connecting && !e->failed);
    settle();
    assert(e->open && !e->connecting && e->failed);
    assert(strstr(e->message, "No server answered at 192.168.0.3:4005"));
    assert(!strcmp(e->text, "192.168.0.3:4005") && !strcmp(lookups[(lookup_count - 1) % 16], "192.168.0.3:4005"));
    assert(S.view == WJ_VIEW_SERVERS && !sd_has("server.addr") && !e->saved[0]);

    // The server appears: Connect selects it and remembers the address.
    snprintf(fake.name, sizeof(fake.name), "Living room PC");
    present("192.168.0.3:4005", FAKE_ID);
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    assert(!e->open && S.view == WJ_VIEW_SOURCES && !strcmp(S.server_name, "Living room PC"));
    assert(!strcmp(server.ip, "192.168.0.3") && server.port == 4005);
    assert_sd("server.addr", "192.168.0.3:4005\n");
    assert_sd("server.id", FAKE_ID "\n");
    assert(!strcmp(e->saved, "192.168.0.3:4005") && !strcmp(direct_address, "192.168.0.3:4005") && direct_saved);
    assert(S.count == 1 && !strcmp(S.menu.items[0].ref, "radio"));
}

static void saved_address_next_launch(void) {
    sd_write("server.addr", "192.168.0.3:4005\n");
    sd_write("settings.txt", "theme=dark\n");
    present("192.168.0.3:4005", FAKE_ID);
    start(0, NULL);
    settle();
    assert(!strcmp(lookups[0], "192.168.0.3:4005") && !discover_calls);
    assert(S.view == WJ_VIEW_SOURCES && S.dark == 1 && !strcmp(S.entry.saved, "192.168.0.3:4005"));
}

static void launch_argument_wins(void) {
    char *argv[] = { "boot.dol", "10.0.0.9:4280" };
    sd_write("server.addr", "192.168.0.3:4005\n");
    present("10.0.0.9:4280", FAKE_ID);
    start(2, argv);
    settle();
    assert(!strcmp(lookups[0], "10.0.0.9:4280") && S.view == WJ_VIEW_SOURCES);
    assert(!strcmp(direct_address, "10.0.0.9:4280") && !direct_saved && !strcmp(S.entry.saved, "192.168.0.3:4005"));
    // Forgetting the remembered address leaves the launch argument alone.
    wj_session_entry_forget();
    assert(!sd_has("server.addr") && !S.entry.saved[0] && !strcmp(direct_address, "10.0.0.9:4280"));
}

static void saved_address_falls_back_to_discovery(void) {
    sd_write("server.addr", "192.168.0.3:4005\n");
    present("192.168.0.9:4005", OTHER_ID);
    fake.discovered = 1;
    start(0, NULL);
    settle();
    assert(!strcmp(lookups[0], "192.168.0.3:4005") && discover_calls >= 1);
    assert(S.view == WJ_VIEW_SERVERS && S.count == 1 && !S.message[0]);
}

static void saved_address_fails_with_nothing_found(void) {
    sd_write("server.addr", "192.168.0.3:4005\n");
    fake.discover_result = 0;
    start(0, NULL);
    settle();
    assert(S.view == WJ_VIEW_SERVERS && !S.count);
    assert(strstr(S.message, "saved address 192.168.0.3:4005 didn't answer") && strstr(S.message, "HOME menu"));
}

static void forget_saved_address(void) {
    sd_write("server.addr", "192.168.0.3:4005\n");
    fake.discover_result = 0;
    start(0, NULL);
    settle();
    assert(direct_address[0] && direct_saved && S.entry.saved[0]);
    wj_session_entry_open();
    wj_session_entry_forget();
    assert(!sd_has("server.addr") && !S.entry.saved[0] && !direct_address[0] && !direct_saved);
    assert(!strcmp(S.entry.message, "Saved address forgotten.") && !S.entry.failed);
    wj_session_entry_forget();
    assert(!strcmp(S.entry.message, "Saved address forgotten."));
}

static void no_writable_sd(void) {
    fat_ok = 0;
    fake.discover_result = -22;
    present("192.168.0.3:4005", FAKE_ID);
    start(0, NULL);
    settle();
    wj_session_entry_open();
    type("3");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    assert(S.view == WJ_VIEW_SOURCES && !sd_has("server.addr") && !sd_has("server.id"));
    assert(!strcmp(S.entry.saved, "192.168.0.3:4005") && !strcmp(direct_address, "192.168.0.3:4005"));
    wj_session_set_dark(1);
    assert(S.dark == 1 && !sd_has("settings.txt"));
}

static void theme_toggle(void) {
    fake.discover_result = 0;
    start(0, NULL);
    settle();
    wj_session_home(1);
    assert(S.home_open && S.home_selected == 0);
    wj_session_home_move(1);
    assert(S.home_selected == WJ_HOME_THEME);
    assert(wj_session_home_activate() == WJ_HOME_THEME && S.dark == 1 && S.home_open);
    assert_sd("settings.txt", "theme=dark\n");
    wj_session_home_activate();
    assert(S.dark == 0);
    assert_sd("settings.txt", "theme=light\n");
    wj_session_home_move(1);
    assert(S.home_selected == WJ_HOME_EXIT && wj_session_home_activate() == WJ_HOME_EXIT && S.home_open && !S.dark);
    wj_session_home_move(1);
    assert(S.home_selected == 0);
    wj_session_home_move(-1);
    assert(S.home_selected == WJ_HOME_EXIT);
    wj_session_home_select(7);
    assert(S.home_selected == WJ_HOME_EXIT);
    wj_session_home_select(0);
    assert(wj_session_home_activate() == WJ_HOME_ADDRESS && S.entry.open && !S.home_open);
    wj_session_home(1);
    wj_session_home(0);
    assert(!S.home_open);
}

static void back_and_delete(void) {
    fake.discover_result = 0;
    start(0, NULL);
    settle();
    struct wj_entry *e = &S.entry;
    wj_session_entry_open();
    wj_session_entry_back();
    assert(!e->open);
    wj_session_entry_open();
    type("12");
    assert(!strcmp(e->text, "192.168.0.12"));
    wj_session_entry_back();
    assert(e->open && !strcmp(e->text, "192.168.0.1"));
    wj_session_entry_press(kind_key(WJ_KEY_CLEAR));
    assert(!e->text[0] && e->open);
    type("1234");
    assert(!strcmp(e->text, "123"));
    wj_session_entry_press(kind_key(WJ_KEY_BACKSPACE));
    assert(!strcmp(e->text, "12"));
    for (int i = 0; i < 5; i++) wj_session_entry_delete();
    assert(e->open && !e->text[0]);
    wj_session_entry_back();
    assert(!e->open);
    // The focus moves on the pad, stops at its edges, and A presses it.
    wj_session_entry_open();
    assert(e->column == 1 && e->row == 1);
    wj_session_entry_press(-1);
    assert(!strcmp(e->text, "192.168.0.5"));
    wj_session_entry_move(1, 0);
    wj_session_entry_press(-1);
    assert(!strcmp(e->text, "192.168.0.56"));
    wj_session_entry_move(1, 0);
    wj_session_entry_move(1, 0);
    assert(e->column == 3);
    wj_session_entry_press(-1);
    assert(!e->text[0]);
    wj_session_entry_focus(key_for('9'));
    assert(e->column == 2 && e->row == 2);
    wj_session_entry_press(key_for('0'));
    assert(e->column == 1 && e->row == 3 && e->pressed == key_for('0'));
    wj_session_entry_focus(-1);
    wj_session_entry_focus(WJ_KEY_COUNT);
    assert(e->column == 1 && e->row == 3);
    // Pressing nothing while closed, or an out-of-range key, changes nothing.
    wj_session_entry_close();
    wj_session_entry_press(key_for('1'));
    assert(!e->text[0] || !e->open);
}

static void cancel_while_connecting(void) {
    fake.discover_result = 0;
    present("192.168.0.3:4005", FAKE_ID);
    start(0, NULL);
    settle();
    wj_session_entry_open();
    type("3");
    fake.delay_ms = 60;
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    assert(S.entry.connecting);
    // Keys rest while it waits.
    char before[WJ_ADDRESS_TEXT];
    snprintf(before, sizeof(before), "%s", S.entry.text);
    wj_session_entry_press(key_for('7'));
    wj_session_entry_delete();
    assert(!strcmp(S.entry.text, before));
    wj_session_entry_back();
    assert(!S.entry.open && !S.entry.connecting);
    settle();
    assert(S.view == WJ_VIEW_SERVERS && !sd_has("server.addr") && !S.entry.saved[0]);
}

static void old_attempt_finishes_after_retyping(void) {
    fake.discover_result = 0;
    present("192.168.0.3:4005", FAKE_ID);
    start(0, NULL);
    settle();
    wj_session_entry_open();
    type("3");
    fake.delay_ms = 60;
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    wj_session_entry_close();
    wj_session_entry_open();
    type("4");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    // The answer for .3 must not stand in for the address typed since.
    assert(S.view == WJ_VIEW_SERVERS && S.entry.open && !sd_has("server.addr"));
    assert(strstr(S.entry.message, "No server answered at 192.168.0.4:4005"));
}

static void connect_waits_for_a_busy_worker(void) {
    fake.discover_result = 0;
    fake.delay_ms = 60;
    present("192.168.0.3:4005", FAKE_ID);
    start(0, NULL);
    assert(S.busy);
    wj_session_entry_open();
    type("192.168.0.3");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    assert(S.entry.connecting && !strcmp(S.entry.text, "192.168.0.3:4005"));
    settle();
    assert(S.view == WJ_VIEW_SOURCES && !S.entry.open);
    assert_sd("server.addr", "192.168.0.3:4005\n");
}

static void discovery_leaves_the_numpad_alone(void) {
    sd_write("server.id", FAKE_ID "\n");
    present("192.168.0.9:4005", FAKE_ID);
    fake.discovered = 1;
    fake.delay_ms = 60;
    start(0, NULL);
    wj_session_entry_open();
    settle();
    // The remembered server was found, but it is not selected over someone typing.
    assert(S.view == WJ_VIEW_SERVERS && S.entry.open && S.count == 1);
    wj_session_entry_close();
    settle();
    assert(S.view == WJ_VIEW_SERVERS && S.count == 1);
}

static void no_rescans_while_typing(void) {
    fake.discover_result = 0;
    start(0, NULL);
    settle();
    wj_session_entry_open();
    int calls = discover_calls;
    clock_ms += 30000;
    settle();
    assert(discover_calls == calls);
    wj_session_entry_close();
    clock_ms += 30000;
    settle();
    assert(discover_calls > calls);
}

static void network_is_down(void) {
    net_ok = 0;
    start(0, NULL);
    settle();
    assert(strstr(S.message, "couldn't join the network") && net_deinits >= 1);
    wj_session_entry_open();
    assert(!S.entry.prefix[0] && !S.entry.text[0]);
    type("10.0.0.5");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    assert(S.entry.open && S.entry.failed && !S.entry.connecting);
    assert(strstr(S.entry.message, "couldn't join the network"));
}

static void switching_servers(void) {
    sd_write("server.addr", "192.168.0.3:4005\n");
    present("192.168.0.3:4005", FAKE_ID);
    snprintf(fake.name, sizeof(fake.name), "First");
    start(0, NULL);
    settle();
    assert(S.view == WJ_VIEW_SOURCES && !strcmp(S.server_id, FAKE_ID));
    // Typing another address while browsing replaces the server and the remembered address.
    present("192.168.0.4:4005", OTHER_ID);
    snprintf(fake.name, sizeof(fake.name), "Second");
    wj_session_home(1);
    assert(wj_session_home_activate() == WJ_HOME_ADDRESS && S.entry.open);
    assert(!strcmp(S.entry.text, "192.168.0."));
    type("4");
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    assert(!S.entry.open && S.view == WJ_VIEW_SOURCES && !strcmp(S.server_id, OTHER_ID) && !strcmp(S.server_name, "Second"));
    assert_sd("server.addr", "192.168.0.4:4005\n");
    assert_sd("server.id", OTHER_ID "\n");
    assert(!strcmp(direct_address, "192.168.0.4:4005"));
}

static void with_port(void) {
    fake.discover_result = 0;
    present("192.168.0.3:4280", FAKE_ID);
    start(0, NULL);
    settle();
    wj_session_entry_open();
    type("3:4280");
    assert(!strcmp(S.entry.text, "192.168.0.3:4280"));
    wj_session_entry_press(kind_key(WJ_KEY_CONNECT));
    settle();
    assert(S.view == WJ_VIEW_SOURCES && server.port == 4280);
    assert_sd("server.addr", "192.168.0.3:4280\n");
}

static int rm_entry(const char *path, const struct stat *st, int type_flag, struct FTW *ftw) {
    (void)st; (void)type_flag; (void)ftw;
    return remove(path);
}

static void run(const char *name, void (*scenario)(void)) {
    const char *tmp = getenv("TMPDIR");
    snprintf(sd_root, sizeof(sd_root), "%s/wjsession-XXXXXX", tmp ? tmp : "/tmp");
    assert(mkdtemp(sd_root));
    fflush(NULL);
    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
        scenario();
        wj_session_shutdown();
        _exit(0);
    }
    int status = 0;
    assert(waitpid(child, &status, 0) == child);
    nftw(sd_root, rm_entry, 8, FTW_DEPTH | FTW_PHYS);
    if (!WIFEXITED(status) || WEXITSTATUS(status)) {
        fprintf(stderr, "session scenario failed: %s\n", name);
        exit(1);
    }
}

int main(void) {
    run("typed address", typed_address_flow);
    run("saved address on the next launch", saved_address_next_launch);
    run("launch argument wins", launch_argument_wins);
    run("saved address falls back to discovery", saved_address_falls_back_to_discovery);
    run("saved address, nothing found", saved_address_fails_with_nothing_found);
    run("forget", forget_saved_address);
    run("no writable SD", no_writable_sd);
    run("theme toggle", theme_toggle);
    run("back, delete and focus", back_and_delete);
    run("cancel while connecting", cancel_while_connecting);
    run("old attempt finishes after retyping", old_attempt_finishes_after_retyping);
    run("connect waits for a busy worker", connect_waits_for_a_busy_worker);
    run("discovery leaves the numpad alone", discovery_leaves_the_numpad_alone);
    run("no rescans while typing", no_rescans_while_typing);
    run("network down", network_is_down);
    run("switching servers", switching_servers);
    run("address with a port", with_port);
    puts("session: typed address, remembering and forgetting it, launch argument, discovery fallback, no SD, theme toggle, "
         "numpad editing, cancel, queueing and network failure passed (real session.c, fake network and SD)");
    return 0;
}
