// SPDX-License-Identifier: GPL-3.0-only
#include "wire.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>

static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int decode(char *text) {
    char *out = text;
    size_t count = 0;
    while (*text) {
        unsigned char c = (unsigned char)*text++;
        if (c == '%') {
            if (!text[0] || !text[1]) return -1;
            int a = hex(text[0]), b = hex(text[1]);
            if (a < 0 || b < 0) return -1;
            c = (unsigned char)(a * 16 + b);
            text += 2;
        }
        if (!c || ++count >= WJ_FIELD) return -1;
        *out++ = (char)c;
    }
    *out = 0;
    return 0;
}

int wj_fields(char *line, struct wj_row *row) {
    row->count = 0;
    do {
        if (row->count == WJ_FIELDS) return -1;
        char *next = strchr(line, '\t');
        if (next) *next++ = 0;
        if (decode(line)) return -1;
        row->field[row->count++] = line;
        line = next;
    } while (line);
    return 0;
}

int wj_document(char *body, struct wj_document *doc) {
    doc->count = 0;
    const char header[] = "WIIJUKEBOX\t1\n";
    if (strncmp(body, header, sizeof(header) - 1)) return -1;
    char *line = body + sizeof(header) - 1;
    while (*line) {
        char *next = strchr(line, '\n');
        if (!next || doc->count == WJ_ROWS) return -1;
        *next++ = 0;
        if (wj_fields(line, &doc->rows[doc->count++])) return -1;
        line = next;
    }
    return 0;
}

int wj_number(const char *text, int minimum, int maximum, int *value) {
    char *end;
    errno = 0;
    long number = strtol(text, &end, 10);
    if (errno || !*text || *end || number < minimum || number > maximum) return -1;
    *value = (int)number;
    return 0;
}

void wj_display_text(char *text) {
    static const struct { const char *utf8, *ascii; } punctuation[] = {
        { "\xe2\x80\x98", "'" }, { "\xe2\x80\x99", "'" },
        { "\xe2\x80\x9c", "\"" }, { "\xe2\x80\x9d", "\"" },
        { "\xe2\x80\x93", "-" }, { "\xe2\x80\x94", "-" },
        { "\xe2\x80\xa6", "..." }, { "\xc2\xa0", " " },
    };
    char *out = text;
    while (*text) {
        size_t i;
        for (i = 0; i < sizeof(punctuation) / sizeof(punctuation[0]); i++) {
            size_t length = strlen(punctuation[i].utf8);
            if (!strncmp(text, punctuation[i].utf8, length)) {
                text += length;
                const char *replacement = punctuation[i].ascii;
                while (*replacement) *out++ = *replacement++;
                break;
            }
        }
        if (i < sizeof(punctuation) / sizeof(punctuation[0])) continue;
        unsigned char c = (unsigned char)*text++;
        *out++ = c >= 32 && c < 127 ? c : '?';
        if (c >= 0xc2 && c <= 0xf4) {
            int remaining = c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
            while (remaining-- && ((unsigned char)*text & 0xc0) == 0x80) text++;
        }
    }
    *out = 0;
}
