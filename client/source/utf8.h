// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_UTF8_H
#define WJ_UTF8_H
#include <stddef.h>
#define WJ_REPLACEMENT 0xFFFDu
/* Decodes one code point and advances *text. Invalid, overlong, surrogate or
   truncated sequences yield U+FFFD and advance by one byte. */
unsigned wj_utf8_next(const char **text);
/* snprintf("%s") that never cuts a character in half: the longest whole-character prefix fits. */
void wj_utf8_copy(char *out, size_t size, const char *in);
#endif
