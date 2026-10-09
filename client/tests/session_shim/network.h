// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include "gccore.h"
s32 net_init_async(void *callback, void *data);
s32 net_get_status(void);
void net_deinit(void);
s32 if_config(char *local_ip, char *netmask, char *gateway, bool use_dhcp, int max_retries);
