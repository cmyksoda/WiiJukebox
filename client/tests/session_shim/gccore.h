// SPDX-License-Identifier: GPL-3.0-only
// Host stand-ins for the slice of libogc that session.c uses, backed by pthreads; see session_test.c.
#pragma once
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int32_t s32; typedef int64_t s64;
#define ATTRIBUTE_ALIGN(n) __attribute__((aligned(n)))
typedef pthread_t lwp_t;
typedef pthread_mutex_t *mutex_t;
s32 LWP_MutexInit(mutex_t *mutex, bool recursive);
s32 LWP_MutexLock(mutex_t mutex);
s32 LWP_MutexUnlock(mutex_t mutex);
s32 LWP_MutexDestroy(mutex_t mutex);
s32 LWP_CreateThread(lwp_t *thread, void *(*entry)(void *), void *argument, void *stack, u32 size, u8 priority);
s32 LWP_JoinThread(lwp_t thread, void **value);
