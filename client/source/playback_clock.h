// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_PLAYBACK_CLOCK_H
#define WJ_PLAYBACK_CLOCK_H
/* Byte position of the first MP3 frame in the current decoder run, plus
   time actually consumed by ASND, excluding the initial silent DMA block. */
struct wj_playback_clock { long long byte, milliseconds; int ready; };
void wj_mp3_clock_start(long long byte);
void wj_mp3_clock_frame(long long offset);
void wj_mp3_clock_begin(void);
void wj_mp3_clock_submit(int bytes);
struct wj_playback_clock wj_mp3_clock(void);
#endif
