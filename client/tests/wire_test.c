// SPDX-License-Identifier: GPL-3.0-only
#include "wire.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
int main(void) {
    char good[] = "WIIJUKEBOX\t1\nitem\tabc\ttrack\tA%09B%0AC%25%F0%9F%8E%B5\t\n";
    struct wj_document doc;
    assert(!wj_document(good, &doc));
    assert(doc.count == 1 && doc.rows[0].count == 5);
    assert(!strcmp(doc.rows[0].field[3], "A\tB\nC%\xf0\x9f\x8e\xb5"));
    const char *bad[] = { "", "WIIJUKEBOX\t2\n", "WIIJUKEBOX\t1\ntruncated",
        "WIIJUKEBOX\t1\na\t%\n", "WIIJUKEBOX\t1\na\t%00\n", "WIIJUKEBOX\t1\na\t%z1\n",
        "WIIJUKEBOX\t1\na\tb\tc\td\te\tf\tg\th\n" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        char buffer[200]; strcpy(buffer, bad[i]); assert(wj_document(buffer, &doc));
    }
    int n;
    assert(!wj_number("65535", 1, 65535, &n) && n == 65535);
    assert(wj_number("65536", 1, 65535, &n));
    assert(wj_number("999999999999999999999999", 1, 65535, &n));
    /* Controls: shuffle and repeat are listed like the rest; unknown or truncated names count for nothing. */
    assert(wj_capabilities("") == 0);
    assert(wj_capabilities("play,pause,stop,queue,next,previous,shuffle,repeat,seek") ==
           (WJ_CAN_PLAY | WJ_CAN_PAUSE | WJ_CAN_STOP | WJ_CAN_NEXT | WJ_CAN_PREVIOUS | WJ_CAN_SHUFFLE |
            WJ_CAN_REPEAT | WJ_CAN_SEEK));
    assert(wj_capabilities("shuffle") == WJ_CAN_SHUFFLE && wj_capabilities("repeat,volume") == WJ_CAN_REPEAT);
    assert(wj_capabilities("shuffled,repeating,shuf,,") == 0);
    /* The modes row: shuffle 0 or 1, then off, all or one. */
    char modes_reply[] = "WIIJUKEBOX\t1\nstatus\tSong\tArtist\tplaying\tNavidrome\tshuffle%2Crepeat\n"
                         "progress\t0\t0\ncommand\t\t0\tidle\nart\t\nmodes\t1\tone\njump\t3\t4\t5\n";
    assert(!wj_document(modes_reply, &doc) && doc.count == 6);
    int shuffle = 0;
    enum wj_repeat repeat = WJ_REPEAT_OFF;
    assert(!wj_modes(&doc.rows[4], &shuffle, &repeat) && shuffle == 1 && repeat == WJ_REPEAT_ONE);
    assert(wj_modes(&doc.rows[0], &shuffle, &repeat) && wj_modes(&doc.rows[5], &shuffle, &repeat));
    assert(wj_capabilities(doc.rows[0].field[5]) == (WJ_CAN_SHUFFLE | WJ_CAN_REPEAT));
    const char *modes[] = { "modes\t0\toff", "modes\t0\tall", "modes\t1\toff", "modes\t1\tall" };
    const enum wj_repeat expected[] = { WJ_REPEAT_OFF, WJ_REPEAT_ALL, WJ_REPEAT_OFF, WJ_REPEAT_ALL };
    for (int i = 0; i < 4; i++) {
        char line[64]; struct wj_row row;
        strcpy(line, modes[i]);
        assert(!wj_fields(line, &row) && !wj_modes(&row, &shuffle, &repeat));
        assert(shuffle == i / 2 && repeat == expected[i]);
    }
    /* Anything else is refused and leaves the last good values alone. */
    const char *bad_modes[] = { "modes\t2\toff", "modes\t-1\toff", "modes\t\toff", "modes\ttrue\toff",
        "modes\t1\ttwice", "modes\t1\tALL", "modes\t1\t", "modes\t1", "modes\t1\tone\textra", "mode\t1\tone",
        "modes\t01x\tone" };
    shuffle = 1;
    repeat = WJ_REPEAT_ALL;
    for (size_t i = 0; i < sizeof(bad_modes) / sizeof(bad_modes[0]); i++) {
        char line[64]; struct wj_row row;
        strcpy(line, bad_modes[i]);
        assert(!wj_fields(line, &row) && wj_modes(&row, &shuffle, &repeat));
        assert(shuffle == 1 && repeat == WJ_REPEAT_ALL);
    }
    uint32_t random = 17;
    for (int trial = 0; trial < 20000; trial++) {
        char fuzz[400]; strcpy(fuzz, "WIIJUKEBOX\t1\n");
        for (int i = 13; i < 399; i++) {
            random = random * 1664525 + 1013904223;
            fuzz[i] = (char)(1 + random % 127);
        }
        fuzz[399] = 0;
        (void)wj_document(fuzz, &doc);
    }
    puts("wire parser passed, including controls, the modes row and 20000 mutation inputs");
    return 0;
}
