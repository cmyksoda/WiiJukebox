// SPDX-License-Identifier: GPL-3.0-only
#include "theme.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static double channel(u32 color, int shift) {
    double c = ((color >> shift) & 0xff) / 255.0;
    return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
static double luminance(u32 c) { return 0.2126 * channel(c, 24) + 0.7152 * channel(c, 16) + 0.0722 * channel(c, 8); }

/* WCAG contrast ratio of two opaque colors. */
static double contrast(u32 a, u32 b) {
    double x = luminance(a), y = luminance(b);
    return (fmax(x, y) + 0.05) / (fmin(x, y) + 0.05);
}

static void check(const struct wj_theme *t, const char *name, int dark) {
    /* Text on the surfaces it is drawn over; fainter type is held to a lower bar. */
    u32 surfaces[] = { t->panel_top, t->panel_bottom, t->tile_top, t->tile_bottom, t->select_top, t->select_bottom };
    for (size_t i = 0; i < sizeof(surfaces) / sizeof(surfaces[0]); i++) {
        double ink = contrast(t->ink, surfaces[i]);
        if (ink < 7) { fprintf(stderr, "%s: ink on surface %zu is %.2f\n", name, i, ink); assert(0); }
        if (dark) {
            double muted = contrast(t->muted, surfaces[i]);
            if (muted < 4.5) { fprintf(stderr, "%s: muted on surface %zu is %.2f\n", name, i, muted); assert(0); }
        }
    }
    assert(contrast(t->ink, t->bg_top) >= 7 && contrast(t->ink, t->bg_bottom) >= 7);
    assert(contrast(t->toast_text, t->toast_top) >= 7 && contrast(t->toast_text, t->toast_bottom) >= 7);
    if (dark) {
        assert(contrast(t->ink, t->dock_top) >= 7 && contrast(t->ink, t->dock_bottom) >= 7);
        /* Type on blue fills, and blue type on the dark surfaces. */
        assert(contrast(t->on_blue, t->blue) >= 7 && contrast(t->on_blue, t->deep_blue) >= 4.5);
        assert(contrast(t->accent, t->panel_top) >= 4.5 && contrast(t->accent, t->select_top) >= 4.5);
        assert(contrast(t->faint, t->panel_bottom) >= 3 && contrast(t->clock, t->dock_top) >= 4.5);
        assert(contrast(t->blue, t->panel_top) >= 3 && contrast(t->blue, t->bg_top) >= 3);
        assert(contrast(t->icon_gray, t->tile_top) >= 3);
        /* A dark gray, not black: every large surface is readable as a surface on a TV. */
        u32 large[] = { t->bg_top, t->bg_bottom, t->panel_top, t->panel_bottom, t->tile_top, t->dock_bottom };
        for (size_t i = 0; i < sizeof(large) / sizeof(large[0]); i++) {
            assert(luminance(large[i]) > 0.012 && luminance(large[i]) < 0.15);
        }
        /* Panels sit above the background and tiles above panels. */
        assert(luminance(t->panel_bottom) > luminance(t->bg_top) && luminance(t->tile_bottom) > luminance(t->panel_top));
        assert(contrast(t->border, t->panel_top) >= 1.5);
    } else {
        assert(luminance(t->bg_top) > 0.9 && luminance(t->panel_top) > 0.99);
    }
}

int main(void) {
    const struct wj_theme *light = wj_theme(0), *dark = wj_theme(1);
    assert(light != dark && wj_theme(0) == light && wj_theme(2) == dark);
    check(light, "light", 0);
    check(dark, "dark", 1);
    puts("theme: light and dark palettes keep their contrast, and dark stays gray rather than black");
    return 0;
}
