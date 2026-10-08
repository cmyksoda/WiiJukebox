// SPDX-License-Identifier: GPL-3.0-only
#include "visualizer.h"
#include "pcm_snapshot.h"
#include "presets.h"
extern "C" {
#include "gfx.h"
#include "net.h"
}
#include <projectM.hpp>
#include <cstdio>
#include <exception>

static projectM *engine;
static char error[160];
static long long next_preset;
static int first_preset = -1;
static const char first_preset_name[] = "Aderrasi - Agitator.milk";

extern "C" const char *wj_visualizer_error(void) { return error; }

/* WiiRadio opens on Agitator; every entry starts there before the rotation. */
static void start_rotation(void) {
    if (first_preset >= 0) engine->selectPreset((unsigned)first_preset, true);
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
        settings.presetURL = first_preset_name;
        engine = new projectM(settings, projectM::FLAG_DISABLE_PLAYLIST_LOAD);
        RatingList ratings(2, 3);
        for (unsigned i = 0; i < wj_preset_count; i++) {
            engine->addPresetURL(std::string("builtin:/") + wj_presets[i].name, wj_presets[i].name, ratings);
        }
        engine->setPresetLock(true); // The app schedules exact 25-second changes.
        first_preset = wj_preset_index(first_preset_name);
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
        if (wj_milliseconds() >= next_preset) {
            engine->selectRandom(false);
            next_preset = wj_milliseconds() + 25000;
        }
        short samples[1024];
        wj_pcm_snapshot(samples);
        engine->pcm()->addPCM16Data(samples, 512);
        engine->renderFrame();
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
