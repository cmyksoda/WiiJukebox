// SPDX-License-Identifier: GPL-3.0-only
#include "layout.h"
#include "utf8.h"
#include <stdio.h>

int wj_fit_text(const char *text, float width, float ellipsis_width, wj_measure measure,
                void *context, int *truncated) {
    int length = 0;
    while (text[length]) length++;
    *truncated = 0;
    if (measure(context, text, length) <= width) return length;
    *truncated = 1;
    int fits = 0;
    for (const char *next = text; *next;) {
        const char *before = next;
        wj_utf8_next(&next);
        if (measure(context, text, (int)(next - text)) + ellipsis_width > width) return (int)(before - text);
        fits = (int)(next - text);
    }
    return fits;
}

void wj_format_time(char *out, size_t size, int milliseconds) {
    if (milliseconds < 0) { snprintf(out, size, "--:--"); return; }
    int seconds = milliseconds / 1000;
    if (seconds >= 3600) snprintf(out, size, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    else snprintf(out, size, "%d:%02d", seconds / 60, seconds % 60);
}

int wj_seek_at(float x, float left, float width, int duration_ms) {
    if (duration_ms <= 0 || width <= 0) return 0;
    float fraction = (x - left) / width;
    if (fraction < 0) fraction = 0;
    if (fraction > 1) fraction = 1;
    int seconds = (int)(fraction * (duration_ms / 1000.0f) + 0.5f);
    int last = (duration_ms - 1) / 1000;
    return (seconds > last ? last : seconds) * 1000;
}

float wj_seek_fraction(int position_ms, int duration_ms) {
    if (duration_ms <= 0 || position_ms <= 0) return 0;
    return position_ms >= duration_ms ? 1 : (float)position_ms / duration_ms;
}

int wj_wrap(int selected, int count, int delta) {
    if (count <= 0) return 0;
    int next = (selected + delta) % count;
    return next < 0 ? next + count : next;
}

int wj_grid_move(int selected, int count, int columns, int dx, int dy) {
    if (count <= 0 || columns <= 0) return 0;
    int row = selected / columns, column = selected % columns;
    column += dx;
    row += dy;
    if (column < 0) column = 0;
    if (column >= columns) column = columns - 1;
    if (row < 0) row = 0;
    if (row * columns >= count) return selected;
    int next = row * columns + column;
    return next >= count ? count - 1 : next;
}
