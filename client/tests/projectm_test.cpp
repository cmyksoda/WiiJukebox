// SPDX-License-Identifier: GPL-3.0-only
// The first-preset check needs the engine's active preset, which has no accessor.
#define private public
#include <projectM.hpp>
#undef private
#include <MilkdropPresetFactory/MilkdropPreset.hpp>
#include <TimeKeeper.hpp>
#include "presets.h"
#include <cassert>
#include <cmath>
#include <cstdio>
int main() {
    Settings settings = {};
    settings.meshX = 30; settings.meshY = 20;
    settings.fps = 100000; // No artificial sleeps in this CPU-only test.
    settings.textureSize = 256;
    settings.windowWidth = 640; settings.windowHeight = 480;
    settings.smoothPresetDuration = 5; settings.presetDuration = 25;
    settings.presetDIR = "builtin:"; settings.presetURL = "Aderrasi - Agitator.milk";
    settings.shuffleEnabled = true;
    projectM engine(settings, projectM::FLAG_DISABLE_PLAYLIST_LOAD);
    RatingList ratings(2, 3);
    for (unsigned i = 0; i < wj_preset_count; i++)
        engine.addPresetURL(std::string("builtin:/") + wj_presets[i].name, wj_presets[i].name, ratings);
    engine.setPresetLock(true);
    const char agitator[] = "Aderrasi - Agitator.milk";
    MilkdropPreset *initial = dynamic_cast<MilkdropPreset *>(engine.m_activePreset.get());
    assert(initial && initial->absoluteFilePath() == std::string("builtin:/") + agitator);
    int first = wj_preset_index(agitator);
    assert(first >= 0 && engine.getPresetName(first) == agitator);
    short pcm[1024];
    for (unsigned i = 0; i < 512; i++) pcm[2*i] = pcm[2*i+1] = std::sin(i * 0.15) * 12000;
    for (unsigned i = 0; i < wj_preset_count; i++) {
        engine.selectPreset(i, true);
        unsigned selected;
        assert(engine.selectedPresetIndex(selected) && selected == i);
        engine.pcm()->addPCM16Data(pcm, 512);
        engine.renderFrame();
    }
    engine.selectRandom(false);
    for (unsigned i = 0; i < 10; i++) {
        engine.pcm()->addPCM16Data(pcm, 512);
        engine.renderFrame();
    }
    assert(engine.timeKeeper->IsSmoothing());
    engine.timeKeeper->startTime.tv_sec -= 6;
    engine.renderFrame();
    assert(!engine.timeKeeper->IsSmoothing());
    engine.selectRandom(false);
    engine.renderFrame();
    // Each visualizer entry hard-cuts to a random preset, as the app does.
    unsigned picks[8];
    bool varied = false;
    for (unsigned i = 0; i < 8; i++) {
        engine.selectRandom(true);
        assert(engine.selectedPresetIndex(picks[i]) && picks[i] < wj_preset_count);
        assert(!engine.timeKeeper->IsSmoothing());
        engine.renderFrame();
        varied = varied || picks[i] != picks[0];
    }
    assert(varied);
    std::printf("Loaded/evaluated %u upstream presets, completed a blend, booted on %s and "
                "opened on random presets (GX stubbed; no pixel verification)\n", wj_preset_count, agitator);
}
