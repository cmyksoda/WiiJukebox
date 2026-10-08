// SPDX-License-Identifier: GPL-3.0-only
#include "utf8.h"

unsigned wj_utf8_next(const char **text) {
    const unsigned char *s = (const unsigned char *)*text;
    unsigned c = s[0];
    int length = c < 0x80 ? 1 : c >= 0xC2 && c < 0xE0 ? 2 : c >= 0xE0 && c < 0xF0 ? 3 : c >= 0xF0 && c < 0xF5 ? 4 : 0;
    if (!length) { *text += 1; return WJ_REPLACEMENT; }
    unsigned code = length == 1 ? c : c & (0x7F >> length);
    for (int i = 1; i < length; i++) {
        if ((s[i] & 0xC0) != 0x80) { *text += 1; return WJ_REPLACEMENT; }
        code = code << 6 | (s[i] & 0x3F);
    }
    static const unsigned minimum[] = { 0, 0, 0x80, 0x800, 0x10000 };
    if (code < minimum[length] || code > 0x10FFFF || (code >= 0xD800 && code < 0xE000)) {
        *text += 1;
        return WJ_REPLACEMENT;
    }
    *text += length;
    return code;
}
