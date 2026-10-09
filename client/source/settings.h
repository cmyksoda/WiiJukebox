// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_SETTINGS_H
#define WJ_SETTINGS_H
#include <stddef.h>

/* Kept in sd:/apps/wiijukebox/settings.txt as key=value lines. */
struct wj_settings { int dark; };

/* Applies the recognized lines of `text` over *settings. Unknown keys, bad values,
   comments and blank lines are skipped, so a hand-edited file never breaks startup. */
void wj_settings_parse(const char *text, struct wj_settings *settings);
void wj_settings_format(const struct wj_settings *settings, char *out, size_t size);
#endif
