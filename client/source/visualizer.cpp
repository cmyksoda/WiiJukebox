// SPDX-License-Identifier: GPL-3.0-only
#include "visualizer.h"
#include "pcm_snapshot.h"
#include "presets.h"
#include "tour.h"
extern "C" {
#include "gfx.h"
#include "font.h"
#include "net.h"
}
#include <projectM.hpp>
#include <cstdio>
#include <cstring>
#include <exception>

static projectM *engine;
static char error[160];
static long long next_preset;

extern "C" const char *wj_visualizer_error(void) { return error; }

#if WJ_PRESET_TOUR
static int tour_index;
static long long flagged_until;

static void tour_show(void) { engine->selectPreset((unsigned)tour_index, true); }

extern "C" void wj_visualizer_step(int delta) {
    if (!engine) return;
    int count = (int)wj_preset_count;
    tour_index = ((tour_index + delta) % count + count) % count;
    tour_show();
}

extern "C" void wj_visualizer_flag(void) {
    FILE *file = std::fopen("sd:/apps/wiijukebox/flagged-presets.txt", "a");
    if (!file) return;
    std::fprintf(file, "%d/%u\t%s\n", tour_index + 1, wj_preset_count, wj_presets[tour_index].name);
    std::fclose(file);
    flagged_until = wj_milliseconds() + 2000;
}

static void tour_overlay(void) {
    char text[200];
    const char *name = wj_presets[tour_index].name;
    int length = (int)std::strlen(name) - 5;
    int bytes = std::snprintf(text, sizeof(text), "%d/%u  %.*s%s", tour_index + 1, wj_preset_count, length, name,
                              wj_milliseconds() < flagged_until ? "  \xc2\xb7  flagged" : "");
    const int size = 16;
    float limit = wj_gfx_width() - 48;
    while (bytes > 0 && wj_font_measure(text, bytes, size, 1) > limit) bytes--;
    float w = wj_font_measure(text, bytes, size, 1) + 28, x = (wj_gfx_width() - w) / 2, y = WJ_GFX_HEIGHT - 52;
    wj_gfx_begin_overlay();
    wj_gfx_round(x, y, w, 30, 15, WJ_RGBA(0, 0, 0, 0xb0), WJ_RGBA(0, 0, 0, 0xb0));
    wj_gfx_text(text, bytes, x + 14, y + 21, size, 1, WJ_RGBA(0xff, 0xff, 0xff, 0xff));
}
#endif

/* Every entry cuts straight to a random preset, then the rotation continues. */
static void start_rotation(void) {
#if WJ_PRESET_TOUR
    tour_show();
#else
    engine->selectRandom(true);
#endif
    next_preset = wj_milliseconds() + 25000;
    wj_pcm_enable(1);
}

extern "C" int wj_visualizer_enter(void) {
    error[0] = 0;
    wj_gfx_prepare_visualizer();
    if (engine) { start_rotation(); return 0; }
    GXRModeObj *mode = wj_gfx_mode();
    try {
        Settings settings = {};
        settings.meshX = 30;
        settings.meshY = 20;
        settings.fps = 60; // VI paces presentation; no extra 30 fps sleep in projectM.
        settings.textureSize = 256;
        settings.windowWidth = mode->fbWidth;
        settings.windowHeight = mode->efbHeight;
        settings.smoothPresetDuration = 5;
        settings.presetDuration = 25;
        settings.beatSensitivity = 20;
        settings.aspectCorrection = true;
        settings.shuffleEnabled = true;
        settings.easterEgg = 0;
        settings.softCutRatingsEnabled = false;
        settings.presetDIR = "builtin:";
        // The engine boots on WiiRadio's first preset; it is replaced before anything is shown.
        settings.presetURL = "Aderrasi - Agitator.milk";
        engine = new projectM(settings, projectM::FLAG_DISABLE_PLAYLIST_LOAD);
        RatingList ratings(2, 3);
        for (unsigned i = 0; i < wj_preset_count; i++) {
            engine->addPresetURL(std::string("builtin:/") + wj_presets[i].name, wj_presets[i].name, ratings);
        }
        engine->setPresetLock(true); // The app schedules exact 25-second changes.
        start_rotation();
        return 0;
    } catch (const std::exception &e) {
        std::snprintf(error, sizeof(error), "projectM: %.140s", e.what());
    } catch (...) {
        std::snprintf(error, sizeof(error), "projectM could not load its presets");
    }
    return -1;
}

extern "C" int wj_visualizer_render(void) {
    if (!engine) return -1;
    try {
#if WJ_PRESET_TOUR
        // The overlay leaves UI state behind, so projectM gets its own back each frame.
        wj_gfx_prepare_visualizer();
#else
        if (wj_milliseconds() >= next_preset) {
            engine->selectRandom(false);
            next_preset = wj_milliseconds() + 25000;
        }
#endif
        short samples[1024];
        wj_pcm_snapshot(samples);
        engine->pcm()->addPCM16Data(samples, 512);
        engine->renderFrame();
#if WJ_PRESET_TOUR
        tour_overlay();
#endif
        GX_SetCopyClear((GXColor){0, 0, 0, 255}, 0x00ffffff);
        GX_SetAlphaUpdate(GX_TRUE);
        GX_SetColorUpdate(GX_TRUE);
        wj_gfx_present();
        return 0;
    } catch (...) {
        std::snprintf(error, sizeof(error), "projectM preset failed; returned to browser");
        return -1;
    }
}

extern "C" void wj_visualizer_leave(void) {
    wj_pcm_enable(0);
    GX_DrawDone();
}

extern "C" void wj_visualizer_shutdown(void) {
    GX_DrawDone();
    delete engine;
    engine = NULL;
}
