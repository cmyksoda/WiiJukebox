// SPDX-License-Identifier: GPL-3.0-only
#include "menu.h"
#include "utf8.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>

int wj_menu_parse(const struct wj_document *doc, int sources, int offset,
                  struct wj_menu *menu) {
    struct wj_menu next = {0};
    int first = 0;
    if (!sources) {
        int received_offset;
        if (!doc->count || doc->rows[0].count != 3 ||
            strcmp(doc->rows[0].field[0], "page") ||
            wj_number(doc->rows[0].field[1], 0, INT_MAX, &received_offset) ||
            received_offset != offset ||
            wj_number(doc->rows[0].field[2], 0, INT_MAX, &next.total)) return -1;
        first = 1;
    }
    for (int i = first; i < doc->count; i++) {
        const struct wj_row *row = &doc->rows[i];
        /* Protocol v1 emits one blank line for an empty sources response. */
        if (sources && doc->count == 1 && row->count == 1 && !row->field[0][0]) break;
        if (row->count != (sources ? 4 : 5) ||
            strcmp(row->field[0], sources ? "source" : "item") ||
            next.count == WJ_PAGE_SIZE) return -1;
        struct wj_item *item = &next.items[next.count];
        const char *ref = row->field[1];
        if (!*ref || strlen(ref) >= sizeof(item->ref) ||
            strspn(ref, "abcdefghijklmnopqrstuvwxyz0123456789-") != strlen(ref)) return -1;
        const char *type = sources ? "source" : row->field[2];
        if (!*type || strlen(type) >= sizeof(item->type)) return -1;
        for (int j = 0; j < next.count; j++) {
            if (!strcmp(next.items[j].ref, ref)) return -1;
        }
        snprintf(item->ref, sizeof(item->ref), "%s", ref);
        snprintf(item->type, sizeof(item->type), "%s", type);
        wj_utf8_copy(item->title, sizeof(item->title), row->field[sources ? 2 : 3]);
        if (!sources) wj_utf8_copy(item->subtitle, sizeof(item->subtitle), row->field[4]);
        next.count++;
    }
    if (sources) next.total = next.count;
    else if (next.count > (offset < next.total ? next.total - offset : 0) ||
             (!next.count && offset < next.total)) return -1;
    *menu = next;
    return 0;
}
