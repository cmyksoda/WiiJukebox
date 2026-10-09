// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include "gccore.h"
void MP3Player_Volume(u32 volume);
void MP3Player_Stop(void);
bool MP3Player_IsPlaying(void);
s32 MP3Player_PlayFile(void *cb_data, s32 (*reader)(void *, void *, s32), void *stat);
