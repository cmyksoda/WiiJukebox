// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_AUDIO_BUFFER_H
#define WJ_AUDIO_BUFFER_H

#define WJ_AUDIO_CAPACITY (64 * 1024)
#define WJ_AUDIO_PREBUFFER (32 * 1024)

struct wj_audio_state { int buffered, ended, failed; };

/* A successful start takes ownership of the socket until stop. The decoder's
   read never waits for network I/O; an underrun returns zero for rebuffering. */
int wj_audio_start(int fd);
void wj_audio_stop(void);
int wj_audio_read(void *buffer, int size);
struct wj_audio_state wj_audio_state(void);

#endif
