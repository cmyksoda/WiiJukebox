// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_ADDRESS_H
#define WJ_ADDRESS_H
#include <stddef.h>

#define WJ_DEFAULT_PORT 4005
/* "255.255.255.255:65535" and its terminator. */
#define WJ_ADDRESS_TEXT 22

struct wj_address { unsigned char octet[4]; int port; };

enum wj_address_error {
    WJ_ADDRESS_OK, WJ_ADDRESS_EMPTY, WJ_ADDRESS_INCOMPLETE, WJ_ADDRESS_OCTET, WJ_ADDRESS_PORT
};

/* Typing. Append refuses text no address could become: past four numbers of three digits,
   a second colon, or a port over five digits. Each returns 1 when the text changed. */
int wj_address_append(char *text, size_t size, char key);
int wj_address_backspace(char *text);
int wj_address_clear(char *text);

/* Accepts a.b.c.d or a.b.c.d:port; the port defaults to WJ_DEFAULT_PORT. */
enum wj_address_error wj_address_parse(const char *text, struct wj_address *address);
const char *wj_address_error_text(enum wj_address_error error);
/* Always "a.b.c.d:port", with leading zeros dropped. */
void wj_address_format(const struct wj_address *address, char *out, size_t size);
/* The Wii's own network prefix, "192.168.0." for 192.168.0.8; empty if the IP is unusable. */
void wj_address_prefix(const char *wii_ip, char *out, size_t size);

/* The remembered address file holds one "a.b.c.d:port" line. */
void wj_address_file_text(const struct wj_address *address, char *out, size_t size);
int wj_address_from_file(const char *text, struct wj_address *address);

/* The numpad: three columns of digits and punctuation, and an action column whose
   Connect key is two rows tall. A focus is a cell, so moving off a tall key keeps its row. */
#define WJ_KEYPAD_COLUMNS 4
#define WJ_KEYPAD_ROWS 4
#define WJ_KEY_COUNT 15

enum wj_key_kind { WJ_KEY_CHAR, WJ_KEY_BACKSPACE, WJ_KEY_CLEAR, WJ_KEY_CONNECT };
struct wj_key { enum wj_key_kind kind; char character; int column, row, rows; };

extern const struct wj_key wj_keypad[WJ_KEY_COUNT];
/* Index of the key covering a cell, or -1 outside the pad. */
int wj_keypad_at(int column, int row);
/* Steps a focus cell, stopping at the edges. */
void wj_keypad_move(int *column, int *row, int dx, int dy);
#endif
