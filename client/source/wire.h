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

enum {
    WJ_CAN_PLAY = 1, WJ_CAN_PAUSE = 2, WJ_CAN_STOP = 4, WJ_CAN_NEXT = 8,
    WJ_CAN_PREVIOUS = 16, WJ_CAN_SEEK = 32, WJ_CAN_SHUFFLE = 64, WJ_CAN_REPEAT = 128
};
enum wj_repeat { WJ_REPEAT_OFF, WJ_REPEAT_ALL, WJ_REPEAT_ONE };
/* The WJ_CAN_ flags for a status reply's comma-separated controls; unknown names are ignored. */
unsigned wj_capabilities(const char *list);
/* Reads a `modes` row (shuffle 0 or 1, repeat off, all or one). Returns -1, leaving the outputs
   alone, for any other row. */
int wj_modes(const struct wj_row *row, int *shuffle, enum wj_repeat *repeat);
#endif
