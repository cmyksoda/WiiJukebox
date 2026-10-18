// SPDX-License-Identifier: GPL-3.0-only
#include "menu.h"
#include "utf8.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int parse(const char *text, int sources, int offset, struct wj_menu *menu) {
    char body[8192];
    snprintf(body, sizeof(body), "WIIJUKEBOX\t1\n%s", text);
    struct wj_document doc;
    if (wj_document(body, &doc)) return -1;
    return wj_menu_parse(&doc, sources, offset, menu);
}

/* What the server's encodeURIComponent makes of non-ASCII text: every byte of it as %XX. */
static void encoded(const char *text, char *out) {
    for (; *text; text++) {
        if ((unsigned char)*text >= 0x80) out += sprintf(out, "%%%02X", (unsigned char)*text);
        else *out++ = *text;
    }
    *out = 0;
}

int main(void) {
    struct wj_menu menu = {0};
    assert(!parse("source\tradio\tInternet Radio\tidle\n"
                  "source\tsubsonic\tNavidrome\tready\n"
                  "source\tytdlp\tWeb links\tready\n"
                  "source\tdesktop\tDesktop audio (Linux)\tready\n", 1, 0, &menu));
    assert(menu.count == 4 && menu.total == 4);
    assert(!strcmp(menu.items[1].ref, "subsonic"));
    struct wj_menu saved = menu;
    const char *bad_sources[] = {
        "status\tSong\tArtist\tplaying\tNavidrome\tpause\n",
        "source\tradio\tRadio\tidle\nsource\tbad%26ref\tInvalid\tidle\n",
        "source\tradio\tRadio\tidle\nsource\tradio\tDuplicate\tidle\n",
        "page\t0\t0\n", "source\tradio\tRadio\n", "error\tOops\n"
    };
    for (size_t i = 0; i < sizeof(bad_sources) / sizeof(bad_sources[0]); i++) {
        assert(parse(bad_sources[i], 1, 0, &menu));
        assert(!memcmp(&menu, &saved, sizeof(menu)));
    }
    assert(!parse("page\t12\t13\nitem\tabc123\ttrack\tDon%E2%80%99t stop\tArtist\n", 0, 12, &menu));
    assert(menu.count == 1 && menu.total == 13);
    assert(!strcmp(menu.items[0].subtitle, "Artist") && !strcmp(menu.items[0].title, "Don\xe2\x80\x99t stop"));
    saved = menu;
    const char *bad_pages[] = {
        "page\t0\t13\nitem\tabc\ttrack\tWrong page\t\n",
        "page\t12\t13\n", "page\t12\t0\nitem\tabc\ttrack\tWrong total\t\n",
        "item\tabc\ttrack\tMissing page\t\n", "page\t12\t13\nstatus\tSong\tArtist\tplaying\n"
    };
    for (size_t i = 0; i < sizeof(bad_pages) / sizeof(bad_pages[0]); i++) {
        assert(parse(bad_pages[i], 0, 12, &menu));
        assert(!memcmp(&menu, &saved, sizeof(menu)));
    }
    /* Hangul, kanji and kana arrive byte for byte, and a title past the field size is cut between characters. */
    const char *names[] = { "\xeb\xb0\xa9\xed\x83\x84\xec\x86\x8c\xeb\x85\x84\xeb\x8b\xa8",
                            "Love Yourself \xe8\xbd\x89", "\xe6\xa4\x8e\xe5\x90\x8d\xe6\x9e\x97\xe6\xaa\x8e" };
    char line[2048], text[4096], long_title[1200] = "";
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        char field[512];
        encoded(names[i], field);
        snprintf(text, sizeof(text), "page\t0\t1\nitem\tabc\talbum\t%s\t%s\n", field, field);
        assert(!parse(text, 0, 0, &menu) && menu.count == 1);
        assert(!strcmp(menu.items[0].title, names[i]) && !strcmp(menu.items[0].subtitle, names[i]));
    }
    for (int i = 0; i < 100; i++) strcat(long_title, "\xe3\x81\x82");
    encoded(long_title, line);
    snprintf(text, sizeof(text), "page\t0\t1\nitem\tabc\talbum\t%s\t\n", line);
    assert(!parse(text, 0, 0, &menu) && strlen(menu.items[0].title) == 255);
    for (const char *cursor = menu.items[0].title; *cursor;) assert(wj_utf8_next(&cursor) == 0x3042);
    assert(!parse("page\t0\t0\n", 0, 0, &menu) && menu.count == 0);
    assert(!parse("\n", 1, 0, &menu) && menu.count == 0);
    puts("menu parser: sources, browse, CJK titles, wrong responses and failed refresh retention passed");
}
