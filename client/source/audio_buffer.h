// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_AUDIO_BUFFER_H
#define WJ_AUDIO_BUFFER_H
#include "net.h"

#define WJ_AUDIO_CAPACITY (384 * 1024)
#define WJ_AUDIO_PREBUFFER_MS 2000
/* The server's burst-on-connect; a longer queue only adds control latency. */
#define WJ_AUDIO_TARGET_MS 4000
#define WJ_AUDIO_RESYNC_MS 9000
#define WJ_AUDIO_STALL_MS 3000

/* Opens the mount with `query` ("?v=2", optionally "&epoch=E&from=B")
   appended. Returns a socket positioned at the first audio byte and fills in
   its clock. */
typedef int (*wj_audio_opener)(const char *query, struct wj_stream_clock *clock);

struct wj_audio_state {
    int buffered, connected, failures, reconnects, bitrate, epoch;
    /* Set after a non-contiguous reconnect until the next decoder run begins. */
    int stale;
    long long read_byte;
};

/* The receive thread owns the connection: it reconnects with backoff and
   continues byte-exactly when the server still holds the missing audio. */
int wj_audio_start(wj_audio_opener open);
void wj_audio_stop(void);
/* Drop the backlog and reconnect at the live edge. */
void wj_audio_resync(void);
/* Skip straight to `byte` of the current epoch, where a transport change's
   audio begins: within the buffer if it is there, else by reconnecting at it.
   The decoder then restarts. Returns 0 if the byte is stale or another epoch. */
int wj_audio_jump(int epoch, long long byte);
int wj_audio_read(void *buffer, int size);
int wj_audio_read_wait(void *buffer, int size, int wait_ms);
/* Start a decoder run on the current audio, keeping at most keep_bytes of the
   newest data. Returns the absolute stream byte that decoding starts from. */
long long wj_audio_begin_decode(int keep_bytes);
struct wj_audio_state wj_audio_state(void);
int wj_audio_bytes(int milliseconds, int bitrate);

#endif
