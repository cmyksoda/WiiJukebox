// SPDX-License-Identifier: GPL-3.0-only
#ifndef WJ_PCM_SNAPSHOT_H
#define WJ_PCM_SNAPSHOT_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
int wj_pcm_init(void);
void wj_pcm_enable(int enabled);
/* libmad Q28 samples; a NULL right channel means mono. */
void wj_pcm_publish(const int32_t *left, const int32_t *right, unsigned frames);
void wj_pcm_snapshot(short output[1024]);
#ifdef __cplusplus
}
#endif
#endif
