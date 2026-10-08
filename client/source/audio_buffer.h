// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_AUDIO_BUFFER_H
#define WJ_AUDIO_BUFFER_H

#define WJ_AUDIO_CAPACITY (64 * 1024)
#define WJ_AUDIO_PREBUFFER (32 * 1024)

struct wj_audio_state { int buffered, ended, failed; long long consumed; };

/* A successful start takes ownership of the socket until stop. The decoder's
   reader can briefly wait for the ring to refill, without doing socket I/O. */
int wj_audio_start(int fd);
void wj_audio_stop(void);
int wj_audio_read(void *buffer, int size);
int wj_audio_read_wait(void *buffer, int size, int wait_ms);
struct wj_audio_state wj_audio_state(void);

#endif
