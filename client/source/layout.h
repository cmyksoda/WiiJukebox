// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_LAYOUT_H
#define WJ_LAYOUT_H
#include <stddef.h>

/* Width of the first `bytes` of a UTF-8 string, in layout units. */
typedef float (*wj_measure)(void *context, const char *text, int bytes);

/* Bytes of `text` to draw within `width`. When the text is truncated, room for
   an ellipsis of `ellipsis_width` is kept and *truncated is set. Never splits
   a UTF-8 sequence. */
int wj_fit_text(const char *text, float width, float ellipsis_width, wj_measure measure,
                void *context, int *truncated);
/* m:ss, or h:mm:ss from an hour; negative times read "--:--". */
void wj_format_time(char *out, size_t size, int milliseconds);
/* Seek target for a pointer at x over a bar, rounded to whole seconds. */
int wj_seek_at(float x, float left, float width, int duration_ms);
float wj_seek_fraction(int position_ms, int duration_ms);
int wj_wrap(int selected, int count, int delta);
/* Moves within a grid of `columns`, clamped at the edges, never past `count`. */
int wj_grid_move(int selected, int count, int columns, int dx, int dy);
#endif
