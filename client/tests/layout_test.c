// SPDX-License-Identifier: GPL-3.0-only
#include "layout.h"
#include "utf8.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Every code point is 10 units wide, so widths are easy to reason about. */
static float measure(void *context, const char *text, int bytes) {
    (void)context;
    float width = 0;
    for (const char *end = text + bytes; text < end;) { wj_utf8_next(&text); width += 10; }
    return width;
}

int main(void) {
    const char *text = "A\xc3\xa9\xe3\x81\x82\xf0\x9f\x8e\xb5";
    assert(wj_utf8_next(&text) == 'A' && wj_utf8_next(&text) == 0xE9);
    assert(wj_utf8_next(&text) == 0x3042 && wj_utf8_next(&text) == 0x1F3B5 && !*text);
    const char *bad[] = { "\x80", "\xc0\xaf", "\xe0\x80\xaf", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xe3\x81", "\xff" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        const char *cursor = bad[i];
        assert(wj_utf8_next(&cursor) == WJ_REPLACEMENT && cursor == bad[i] + 1);
    }

    /* A copy that runs out of room drops the whole character it would have cut. */
    char small[8];
    wj_utf8_copy(small, sizeof(small), "ab\xe3\x81\x82\xe3\x81\x84");
    assert(!strcmp(small, "ab\xe3\x81\x82"));
    wj_utf8_copy(small, sizeof(small), "abcd\xe3\x81\x82");
    assert(!strcmp(small, "abcd\xe3\x81\x82"));
    wj_utf8_copy(small, sizeof(small), "abcde\xe3\x81\x82");
    assert(!strcmp(small, "abcde"));
    wj_utf8_copy(small, sizeof(small), "abcdefghij");
    assert(!strcmp(small, "abcdefg"));
    wj_utf8_copy(small, 1, "abc");
    assert(!small[0]);

    int truncated;
    assert(wj_fit_text("Short", 50, 10, measure, NULL, &truncated) == 5 && !truncated);
    assert(wj_fit_text("Longer title", 60, 10, measure, NULL, &truncated) == 5 && truncated);
    const char *japanese = "\xe3\x81\x82\xe3\x81\x84\xe3\x81\x86\xe3\x81\x88";
    assert(wj_fit_text(japanese, 30, 10, measure, NULL, &truncated) == 6 && truncated);
    assert(wj_fit_text(japanese, 5, 10, measure, NULL, &truncated) == 0 && truncated);

    char time[16];
    wj_format_time(time, sizeof(time), 83999); assert(!strcmp(time, "1:23"));
    wj_format_time(time, sizeof(time), 3723000); assert(!strcmp(time, "1:02:03"));
    wj_format_time(time, sizeof(time), -1); assert(!strcmp(time, "--:--"));

    assert(wj_seek_at(150, 100, 200, 200000) == 50000);
    assert(wj_seek_at(0, 100, 200, 200000) == 0);
    assert(wj_seek_at(999, 100, 200, 200000) == 199000);
    assert(wj_seek_at(150, 100, 200, 0) == 0);
    assert(wj_seek_fraction(50000, 200000) == 0.25f && wj_seek_fraction(5, 0) == 0);
    assert(wj_seek_fraction(300000, 200000) == 1);

    assert(wj_wrap(0, 5, -1) == 4 && wj_wrap(4, 5, 1) == 0 && wj_wrap(3, 0, 1) == 0);
    assert(wj_grid_move(0, 5, 3, 1, 0) == 1 && wj_grid_move(2, 5, 3, 1, 0) == 2);
    assert(wj_grid_move(2, 5, 3, 0, 1) == 4 && wj_grid_move(4, 5, 3, 0, 1) == 4);
    assert(wj_grid_move(1, 5, 3, 0, -1) == 1 && wj_grid_move(3, 4, 3, 1, 0) == 3);
    puts("layout: UTF-8, safe copies, ellipsis fitting, times, seek mapping, wrapping and grid moves passed");
    return 0;
}
