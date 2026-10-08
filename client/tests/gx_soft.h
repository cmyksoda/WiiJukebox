// SPDX-License-Identifier: GPL-3.0-only
#pragma once
void gx_soft_set_aspect(int widescreen);
int gx_soft_frames(void);
/* The last frame copied out of the EFB, as 640x480 RGB. */
void gx_soft_frame(unsigned char *rgb);
