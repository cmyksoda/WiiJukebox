// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_PRESETS_H
#define WJ_PRESETS_H
struct wj_preset { const char *name, *text; };
extern const struct wj_preset wj_presets[];
extern const unsigned wj_preset_count;
#endif
