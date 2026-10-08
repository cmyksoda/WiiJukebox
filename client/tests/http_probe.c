// SPDX-License-Identifier: GPL-3.0-only
#include "net.h"
#include "wire.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    struct wj_server server = { .ip = "127.0.0.1" };
    server.port = atoi(argv[1]);
    char body[WJ_BODY];
    int status = wj_request(&server, "GET", "/test", body, sizeof(body));
    if (status != 200) return 1;
    return fwrite(body, 1, strlen(body), stdout) == strlen(body) ? 0 : 1;
}
