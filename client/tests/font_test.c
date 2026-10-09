// SPDX-License-Identifier: GPL-3.0-only
#include "font.h"
#include "utf8.h"
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

static int flushes;
static void flush(void) { flushes++; }

static int covered(const char *text) {
    while (*text)
        if (!wj_font_covers(wj_utf8_next(&text))) return 0;
    return 1;
}

static long load(const char *path, unsigned char *data, long capacity) {
    FILE *file = fopen(path, "rb");
    assert(file);
    long size = (long)fread(data, 1, (size_t)capacity, file);
    fclose(file);
    return size;
}

int main(int argc, char **argv) {
    assert(argc == 5);
    static unsigned char latin[1024 * 1024], greek[256 * 1024], cjk[3 * 1024 * 1024], korean[3 * 1024 * 1024];
    const struct wj_font_face faces[] = {
        { latin, load(argv[1], latin, sizeof(latin)) },
        { greek, load(argv[2], greek, sizeof(greek)) },
        { cjk, load(argv[3], cjk, sizeof(cjk)) },
        { korean, load(argv[4], korean, sizeof(korean)) },
    };
    assert(!wj_font_init(faces, 4, 1, 1));
    wj_font_set_reset_hook(flush);
    int rendered, resets, changed;
    float hello = wj_font_measure("Hello", 5, 20, 0);
    assert(hello > 30 && hello < 80);
    assert(wj_font_measure("Hello", 5, 20, 1) > hello);
    assert(wj_font_measure("Hello", 5, 40, 0) > hello * 1.8f);
    // Baked kerning pulls A and V together; unrelated letters keep their plain advances.
    assert(wj_font_measure("AV", 2, 20, 0) < wj_font_measure("A", 1, 20, 0) + wj_font_measure("V", 1, 20, 0) - 0.5f);
    assert(wj_font_measure("HH", 2, 20, 0) == 2 * wj_font_measure("H", 1, 20, 0));
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
    /* Polish, Czech and accented Greek need the primary face; kana the fallback. */
    const char *european = "\xc4\x85\xc5\x99\xcf\x8d\xd1\x97";
    quads = 0;
    wj_font_run(european, (int)strlen(european), 20, 0, 0, 30, count, NULL);
    assert(quads == 4);
    float kana = wj_font_measure("\xe3\x81\x82", 3, 20, 0);
    assert(kana > 17 && kana < 23);
    const char *hangul = "\xed\x95\x9c";
    quads = 0;
    assert(wj_font_run(hangul, 3, 20, 0, 0, 30, count, NULL) > 17 && quads == 1);

    /* Hangul, kana and both kanji levels are covered, so none of them falls back to the box. */
    const char *names[] = {
        "\xeb\xb0\xa9\xed\x83\x84\xec\x86\x8c\xeb\x85\x84\xeb\x8b\xa8",
        "\xeb\xb8\x94\xeb\x9e\x99\xed\x95\x91\xed\x81\xac",
        "\xe3\x85\x8b\xe3\x85\x8b\xe3\x85\x8b",
        "Love Yourself \xe8\xbd\x89 \xe2\x80\x98Tear\xe2\x80\x99",
        "\xe5\x91\xaa\xe8\xa9\x9b",
        "\xe6\xa4\x8e\xe5\x90\x8d\xe6\x9e\x97\xe6\xaa\x8e",
        "\xe5\xae\x87\xe5\xa4\x9a\xe7\x94\xb0\xe3\x83\x92\xe3\x82\xab\xe3\x83\xab",
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) assert(covered(names[i]));
    /* Five Hangul syllables measure five ems, where the box would take half of that. */
    float bts = wj_font_measure(names[0], (int)strlen(names[0]), 20, 0);
    assert(bts > 90 && bts < 110);
    /* Thai is outside every face and still draws one box, never nothing. */
    assert(!wj_font_covers(0x0E01));
    quads = 0;
    assert(wj_font_run("\xe0\xb8\x81", 3, 20, 0, 0, 30, count, NULL) > 5 && quads == 1);

    /* Enough large glyphs to overflow the atlas: it resets and keeps working. */
    char text[8];
    flushes = 0;
    for (unsigned code = 0x4E00; code < 0x9FA0; code += 3) {
        text[0] = (char)(0xE0 | code >> 12);
        text[1] = (char)(0x80 | (code >> 6 & 0x3F));
        text[2] = (char)(0x80 | (code & 0x3F));
        wj_font_measure(text, 3, 48, 0);
    }
    wj_font_stats(&rendered, &resets);
    assert(resets > 0);
    assert(wj_font_measure("Hello", 5, 20, 0) == hello);
    /* The GPU is let finish before every wipe, since queued quads read the atlas when it gets to them. */
    assert(flushes == resets);

    /* A reset partway through a string must leave the draw pass nothing to rasterize. */
    int split = 0;
    for (unsigned code = 0x5000; code < 0x9000 && split < 3; code += 24) {
        char run[3 * 24 + 1];
        int length = 0, before, after, drawn, resets_before, resets_after, resets_drawn;
        for (unsigned i = 0; i < 24; i++, length += 3) {
            run[length] = (char)(0xE0 | (code + i) >> 12);
            run[length + 1] = (char)(0x80 | ((code + i) >> 6 & 0x3F));
            run[length + 2] = (char)(0x80 | ((code + i) & 0x3F));
        }
        wj_font_stats(&before, &resets_before);
        wj_font_prepare(run, length, 48, 0);
        wj_font_stats(&after, &resets_after);
        wj_font_run(run, length, 48, 0, 0, 60, count, NULL);
        wj_font_stats(&drawn, &resets_drawn);
        assert(drawn == after && resets_drawn == resets_after);
        if (resets_after != resets_before) split++;
    }
    assert(split == 3);

    float wide;
    wj_font_shutdown();
    assert(!wj_font_init(faces, 4, 0.75f, 1));
    wide = wj_font_measure("Hello", 5, 20, 0);
    assert(wide > hello * 0.95f && wide < hello * 1.05f);
    wj_font_shutdown();

    /* The Korean face holds no Han, so shared characters keep the Japanese forms; a lone face is enough to read. */
    const struct wj_font_face korean_only[] = { faces[0], faces[3] }, japanese_only[] = { faces[0], faces[2] };
    assert(!wj_font_init(korean_only, 2, 1, 1));
    assert(wj_font_covers(0xBC29) && !wj_font_covers(0x76F4) && !wj_font_covers(0x8F49));
    wj_font_shutdown();
    assert(!wj_font_init(japanese_only, 2, 1, 1));
    assert(wj_font_covers(0x76F4) && wj_font_covers(0x8F49) && wj_font_covers(0x8A5B) && !wj_font_covers(0xBC29));
    wj_font_shutdown();
    /* A fallback that fails to open is counted, and the primary face still works. */
    const struct wj_font_face broken[] = { faces[0], { faces[2].data, 100 }, faces[3] };
    assert(wj_font_init(broken, 3, 1, 1) == 1);
    assert(wj_font_covers(0xBC29) && !wj_font_covers(0x8F49));
    wj_font_shutdown();
    printf("font: metrics, cache, bold, Latin/Greek/Cyrillic with CJK and Hangul fallback, missing glyphs, controls, atlas reset and widescreen passed (%d glyphs, %d resets)\n",
           rendered, resets);
    return 0;
}
