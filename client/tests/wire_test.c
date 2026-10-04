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
    puts("wire parser passed, including 20000 mutation inputs");
    return 0;
}
