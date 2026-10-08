// SPDX-License-Identifier: GPL-3.0-only
#include "visualizer.h"
#include "pcm_snapshot.h"
#include "presets.h"
extern "C" {
#include "net.h"
}
#include <projectM.hpp>
#include <malloc.h>
#include <cstring>
#include <cstdio>
#include <exception>

static projectM *engine;
static void *fifo, *frames[2];
static unsigned frame;
static char error[160];
static bool gx_started;
static long long next_preset;

extern "C" const char *wj_visualizer_error(void) { return error; }

static void setup_gx(GXRModeObj *mode) {
    GX_Init(fifo, 256 * 1024);
    gx_started = true;
    GX_SetCopyClear((GXColor){0, 0, 0, 255}, 0x00ffffff);
    GX_SetDispCopySrc(0, 0, mode->fbWidth, mode->efbHeight);
    GX_SetDispCopyDst(mode->fbWidth, mode->xfbHeight);
    GX_SetDispCopyYScale(GX_GetYScaleFactor(mode->efbHeight, mode->xfbHeight));
    GX_SetCopyFilter(mode->aa, mode->sample_pattern, GX_TRUE, mode->vfilter);
    GX_SetFieldMode(mode->field_rendering,
                    mode->viHeight == 2 * mode->xfbHeight ? GX_ENABLE : GX_DISABLE);
    GX_SetViewport(0, 0, mode->fbWidth, mode->efbHeight, 0, 1);
    GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
    GX_SetDispCopyGamma(GX_GM_1_0);
    GX_SetNumTevStages(1);
    GX_SetNumIndStages(0);
}

extern "C" int wj_visualizer_enter(GXRModeObj *mode) {
    error[0] = 0;
    if (engine) { wj_pcm_enable(1); next_preset = wj_milliseconds() + 25000; return 0; }
    try {
        if (!fifo) fifo = memalign(32, 256 * 1024);
        for (unsigned i = 0; i < 2; i++) {
            if (!frames[i]) {
                void *allocated = SYS_AllocateFramebuffer(mode);
                if (allocated) frames[i] = MEM_K0_TO_K1(allocated);
            }
        }
        if (!fifo || !frames[0] || !frames[1]) {
            std::snprintf(error, sizeof(error), "Not enough memory for projectM");
            return -1;
        }
        for (unsigned i = 0; i < 2; i++) VIDEO_ClearFrameBuffer(mode, frames[i], COLOR_BLACK);
        setup_gx(mode);
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
        settings.presetURL = "Aderrasi - Agitator.milk";
        engine = new projectM(settings, projectM::FLAG_DISABLE_PLAYLIST_LOAD);
        RatingList ratings(2, 3);
        for (unsigned i = 0; i < wj_preset_count; i++) {
            engine->addPresetURL(std::string("builtin:/") + wj_presets[i].name, wj_presets[i].name, ratings);
        }
        engine->setPresetLock(true); // The app schedules exact 25-second changes.
        next_preset = wj_milliseconds() + 25000;
        wj_pcm_enable(1);
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
        frame ^= 1;
        GX_CopyDisp(frames[frame], GX_TRUE);
        GX_DrawDone();
        VIDEO_SetNextFramebuffer(frames[frame]);
        VIDEO_Flush();
        return 0;
    } catch (...) {
        std::snprintf(error, sizeof(error), "projectM preset failed; returned to browser");
        return -1;
    }
}

extern "C" void wj_visualizer_leave(void *console_framebuffer) {
    wj_pcm_enable(0);
    if (gx_started) GX_DrawDone();
    VIDEO_SetNextFramebuffer(console_framebuffer);
    VIDEO_Flush();
    VIDEO_WaitVSync();
}

extern "C" void wj_visualizer_shutdown(void) {
    if (gx_started) GX_DrawDone();
    delete engine;
    engine = NULL;
    for (unsigned i = 0; i < 2; i++) {
        if (frames[i]) free(MEM_K1_TO_K0(frames[i]));
        frames[i] = NULL;
    }
    // Keep GX's registered FIFO alive until libogc shuts graphics down on exit.
}
