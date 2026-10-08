// SPDX-License-Identifier: GPL-3.0-only
#include "font.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int quads;
static void count(void *context, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1) {
    (void)context;
    assert(x1 > x0 && y1 > y0 && u0 >= 0 && v0 >= 0 && u1 <= 1 && v1 <= 1 && u1 > u0 && v1 > v0);
    quads++;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    FILE *file = fopen(argv[1], "rb");
    assert(file);
    static unsigned char data[2 * 1024 * 1024];
    long size = (long)fread(data, 1, sizeof(data), file);
    fclose(file);
    assert(!wj_font_init(data, size, 1, 1));
    int rendered, resets, changed;
    float hello = wj_font_measure("Hello", 5, 20, 0);
    assert(hello > 30 && hello < 80);
    assert(wj_font_measure("Hello", 5, 20, 1) > hello);
    assert(wj_font_measure("Hello", 5, 40, 0) > hello * 1.8f);
    wj_font_stats(&rendered, &resets);
    int before = rendered;
    wj_font_measure("Hello", 5, 20, 0);
    wj_font_stats(&rendered, &resets);
    assert(rendered == before && !resets);
    wj_font_atlas(&changed);
    assert(changed);
    wj_font_atlas(&changed);
    assert(!changed);

    const char *mixed = "Caf\xc3\xa9 \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e \xe3\x81\x82\xce\xa9\xd0\x96";
    quads = 0;
    float end = wj_font_run(mixed, (int)strlen(mixed), 20, 0, 10, 30, count, NULL);
    assert(quads == 10 && end > 10 + 10 * 8);
    const char *controls = "a\x01\x1b" "b\xc2\x85";
    quads = 0;
    wj_font_run(controls, (int)strlen(controls), 20, 0, 0, 30, count, NULL);
    assert(quads == 2);
    const char *hangul = "\xed\x95\x9c";
    quads = 0;
    assert(wj_font_run(hangul, 3, 20, 0, 0, 30, count, NULL) > 5 && quads == 1);

    /* Enough large glyphs to overflow the atlas: it resets and keeps working. */
    char text[8];
    for (unsigned code = 0x4E00; code < 0x9FA0; code += 3) {
        text[0] = (char)(0xE0 | code >> 12);
        text[1] = (char)(0x80 | (code >> 6 & 0x3F));
        text[2] = (char)(0x80 | (code & 0x3F));
        wj_font_measure(text, 3, 48, 0);
    }
    wj_font_stats(&rendered, &resets);
    assert(resets > 0);
    assert(wj_font_measure("Hello", 5, 20, 0) == hello);

    float wide;
    wj_font_shutdown();
    assert(!wj_font_init(data, size, 0.75f, 1));
    wide = wj_font_measure("Hello", 5, 20, 0);
    assert(wide > hello * 0.95f && wide < hello * 1.05f);
    wj_font_shutdown();
    printf("font: metrics, cache, bold, CJK, missing glyphs, controls, atlas reset and widescreen passed (%d glyphs, %d resets)\n",
           rendered, resets);
    return 0;
}
