// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_UTF8_H
#define WJ_UTF8_H
#define WJ_REPLACEMENT 0xFFFDu
/* Decodes one code point and advances *text. Invalid, overlong, surrogate or
   truncated sequences yield U+FFFD and advance by one byte. */
unsigned wj_utf8_next(const char **text);
#endif
