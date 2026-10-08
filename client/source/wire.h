// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_WIRE_H
#define WJ_WIRE_H
#include <stddef.h>
#define WJ_ROWS 16
#define WJ_FIELDS 7
#define WJ_FIELD 1025
#define WJ_BODY 80000
struct wj_row { char *field[WJ_FIELDS]; int count; };
struct wj_document { struct wj_row rows[WJ_ROWS]; int count; };
int wj_fields(char *line, struct wj_row *row);
int wj_document(char *body, struct wj_document *doc);
int wj_number(const char *text, int minimum, int maximum, int *value);
#endif
