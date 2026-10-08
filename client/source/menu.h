// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_MENU_H
#define WJ_MENU_H
#include "wire.h"
#define WJ_PAGE_SIZE 12
struct wj_item { char ref[64], type[24], title[257]; };
struct wj_menu { struct wj_item items[WJ_PAGE_SIZE]; int count, total; };
/* Commit a complete reply only; a rejected refresh leaves the old menu intact. */
int wj_menu_parse(const struct wj_document *doc, int sources, int offset,
                  struct wj_menu *menu);
#endif
