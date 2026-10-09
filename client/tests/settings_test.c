// SPDX-License-Identifier: GPL-3.0-only
#include "settings.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int dark_after(const char *text, int start) {
    struct wj_settings settings = { start };
    wj_settings_parse(text, &settings);
    return settings.dark;
}

int main(void) {
    char out[64];
    struct wj_settings settings = { 0 };
    wj_settings_format(&settings, out, sizeof(out));
    assert(!strcmp(out, "theme=light\n"));
    settings.dark = 1;
    wj_settings_format(&settings, out, sizeof(out));
    assert(!strcmp(out, "theme=dark\n"));

    /* What the app writes comes back as written. */
    struct wj_settings back = { 0 };
    wj_settings_parse(out, &back);
    assert(back.dark == 1);
    wj_settings_format(&back, out, sizeof(out));
    settings.dark = 0;
    wj_settings_parse(out, &settings);
    assert(settings.dark == 1);

    assert(dark_after("theme=dark", 0) == 1 && dark_after("theme=light\n", 1) == 0);
    assert(dark_after("  theme = dark \r\n", 0) == 1);
    assert(dark_after("# theme=dark\n", 0) == 0);
    assert(dark_after("volume=3\ntheme=dark\nother=1\n", 0) == 1);
    assert(dark_after("theme=dark\ntheme=light\n", 0) == 0);
    /* Missing, unknown or malformed settings keep the starting value. */
    assert(dark_after("", 0) == 0 && dark_after("", 1) == 1);
    assert(dark_after("theme=blue\n", 1) == 1 && dark_after("theme=\n", 1) == 1);
    assert(dark_after("theme\n", 1) == 1 && dark_after("=dark\n", 0) == 0);
    assert(dark_after("themes=dark\n", 0) == 0 && dark_after("theme=darker\n", 0) == 0);
    assert(dark_after("theme=Dark\n", 0) == 0);
    assert(dark_after("\xff\xfe\x00theme=dark", 0) == 0);
    char small[8];
    wj_settings_format(&settings, small, sizeof(small));
    assert(strlen(small) < sizeof(small));
    puts("settings: format, round trip, whitespace, comments and malformed lines passed");
    return 0;
}
