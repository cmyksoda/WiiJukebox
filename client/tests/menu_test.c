// SPDX-License-Identifier: GPL-3.0-only
#include "menu.h"
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

int main(void) {
    struct wj_menu menu = {0};
    assert(!parse("source\tradio\tInternet Radio\tidle\n"
                  "source\tsubsonic\tNavidrome / Subsonic\tready\n"
                  "source\tytdlp\tYouTube / SoundCloud\tready\n"
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
    assert(!parse("page\t0\t0\n", 0, 0, &menu) && menu.count == 0);
    assert(!parse("\n", 1, 0, &menu) && menu.count == 0);
    puts("menu parser: sources, browse, wrong responses and failed refresh retention passed");
}
