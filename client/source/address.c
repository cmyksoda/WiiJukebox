// SPDX-License-Identifier: GPL-3.0-only
#include "address.h"
#include <stdio.h>
#include <string.h>

#define MAX_OCTET_DIGITS 3
#define MAX_PORT_DIGITS 5

static int is_digit(char c) { return c >= '0' && c <= '9'; }

int wj_address_append(char *text, size_t size, char key) {
    size_t length = strlen(text);
    if (length + 2 > size) return 0;
    const char *colon = strchr(text, ':');
    int dots = 0;
    for (const char *p = text; *p; p++) dots += *p == '.';
    const char *segment = colon ? colon + 1 : strrchr(text, '.') ? strrchr(text, '.') + 1 : text;
    int after_digit = length && is_digit(text[length - 1]);
    if (is_digit(key)) {
        if (strlen(segment) >= (colon ? MAX_PORT_DIGITS : MAX_OCTET_DIGITS)) return 0;
    } else if (key == '.') {
        if (colon || dots >= 3 || !after_digit) return 0;
    } else if (key == ':') {
        if (colon || dots != 3 || !after_digit) return 0;
    } else return 0;
    text[length] = key;
    text[length + 1] = 0;
    return 1;
}

int wj_address_backspace(char *text) {
    size_t length = strlen(text);
    if (!length) return 0;
    text[length - 1] = 0;
    return 1;
}

int wj_address_clear(char *text) {
    int had_text = text[0] != 0;
    text[0] = 0;
    return had_text;
}

/* Reads 1 to max_digits decimal digits between start and end; anything else fails. */
static int number(const char *start, const char *end, int max_digits, int *value) {
    if (end == start || end - start > max_digits) return -1;
    int total = 0;
    for (const char *p = start; p < end; p++) {
        if (!is_digit(*p)) return -1;
        total = total * 10 + (*p - '0');
    }
    *value = total;
    return 0;
}

enum wj_address_error wj_address_parse(const char *text, struct wj_address *address) {
    if (!*text) return WJ_ADDRESS_EMPTY;
    const char *colon = strchr(text, ':');
    const char *end = colon ? colon : text + strlen(text);
    int octets[4];
    const char *start = text;
    for (int i = 0; i < 4; i++) {
        const char *stop = start;
        while (stop < end && *stop != '.') stop++;
        if (number(start, stop, MAX_OCTET_DIGITS, &octets[i])) return WJ_ADDRESS_INCOMPLETE;
        if (i < 3 && stop == end) return WJ_ADDRESS_INCOMPLETE;
        start = stop + 1;
    }
    if (start - 1 != end) return WJ_ADDRESS_INCOMPLETE;
    for (int i = 0; i < 4; i++)
        if (octets[i] > 255) return WJ_ADDRESS_OCTET;
    int port = WJ_DEFAULT_PORT;
    if (colon && (number(colon + 1, colon + 1 + strlen(colon + 1), MAX_PORT_DIGITS, &port) ||
                  port < 1 || port > 65535)) return WJ_ADDRESS_PORT;
    if (address) {
        for (int i = 0; i < 4; i++) address->octet[i] = (unsigned char)octets[i];
        address->port = port;
    }
    return WJ_ADDRESS_OK;
}

const char *wj_address_error_text(enum wj_address_error error) {
    switch (error) {
    case WJ_ADDRESS_OK: return "";
    case WJ_ADDRESS_EMPTY: return "Type the server's address first.";
    case WJ_ADDRESS_INCOMPLETE: return "An address has four numbers, like 192.168.0.3";
    case WJ_ADDRESS_OCTET: return "Each number must be from 0 to 255.";
    case WJ_ADDRESS_PORT: return "The port must be from 1 to 65535.";
    }
    return "";
}

void wj_address_format(const struct wj_address *address, char *out, size_t size) {
    snprintf(out, size, "%u.%u.%u.%u:%d", address->octet[0], address->octet[1], address->octet[2],
             address->octet[3], address->port);
}

void wj_address_prefix(const char *wii_ip, char *out, size_t size) {
    struct wj_address ip;
    out[0] = 0;
    if (strchr(wii_ip, ':') || wj_address_parse(wii_ip, &ip)) return;
    if (!(ip.octet[0] | ip.octet[1] | ip.octet[2] | ip.octet[3])) return;
    snprintf(out, size, "%u.%u.%u.", ip.octet[0], ip.octet[1], ip.octet[2]);
}

void wj_address_file_text(const struct wj_address *address, char *out, size_t size) {
    char line[WJ_ADDRESS_TEXT];
    wj_address_format(address, line, sizeof(line));
    snprintf(out, size, "%s\n", line);
}

int wj_address_from_file(const char *text, struct wj_address *address) {
    while (*text == ' ' || *text == '\t') text++;
    size_t length = strcspn(text, "\r\n");
    const char *rest = text + length;
    while (*rest == '\r' || *rest == '\n' || *rest == ' ' || *rest == '\t') rest++;
    if (*rest) return -1;
    while (length && (text[length - 1] == ' ' || text[length - 1] == '\t')) length--;
    char line[WJ_ADDRESS_TEXT];
    if (length >= sizeof(line)) return -1;
    memcpy(line, text, length);
    line[length] = 0;
    return wj_address_parse(line, address) != WJ_ADDRESS_OK;
}

const struct wj_key wj_keypad[WJ_KEY_COUNT] = {
    { WJ_KEY_CHAR, '1', 0, 0, 1 }, { WJ_KEY_CHAR, '2', 1, 0, 1 }, { WJ_KEY_CHAR, '3', 2, 0, 1 },
    { WJ_KEY_BACKSPACE, 0, 3, 0, 1 },
    { WJ_KEY_CHAR, '4', 0, 1, 1 }, { WJ_KEY_CHAR, '5', 1, 1, 1 }, { WJ_KEY_CHAR, '6', 2, 1, 1 },
    { WJ_KEY_CLEAR, 0, 3, 1, 1 },
    { WJ_KEY_CHAR, '7', 0, 2, 1 }, { WJ_KEY_CHAR, '8', 1, 2, 1 }, { WJ_KEY_CHAR, '9', 2, 2, 1 },
    { WJ_KEY_CONNECT, 0, 3, 2, 2 },
    { WJ_KEY_CHAR, '.', 0, 3, 1 }, { WJ_KEY_CHAR, '0', 1, 3, 1 }, { WJ_KEY_CHAR, ':', 2, 3, 1 },
};

int wj_keypad_at(int column, int row) {
    for (int i = 0; i < WJ_KEY_COUNT; i++) {
        const struct wj_key *key = &wj_keypad[i];
        if (key->column == column && row >= key->row && row < key->row + key->rows) return i;
    }
    return -1;
}

void wj_keypad_move(int *column, int *row, int dx, int dy) {
    int c = *column + dx, r = *row + dy;
    *column = c < 0 ? 0 : c >= WJ_KEYPAD_COLUMNS ? WJ_KEYPAD_COLUMNS - 1 : c;
    *row = r < 0 ? 0 : r >= WJ_KEYPAD_ROWS ? WJ_KEYPAD_ROWS - 1 : r;
}
