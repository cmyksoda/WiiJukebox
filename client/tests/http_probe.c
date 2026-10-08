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
    struct wj_http_trace trace;
    int status = wj_request_traced(&server, "GET", "/test", body, sizeof(body), &trace);
    fprintf(stderr, "stage=%s error=%d status=%d received=%d expected=%d elapsed_ms=%lld\n",
            wj_http_stage_name(trace.stage), trace.error, trace.status,
            trace.received, trace.expected, trace.elapsed_ms);
    if (status != 200) return 1;
    return fwrite(body, 1, strlen(body), stdout) == strlen(body) ? 0 : 1;
}
