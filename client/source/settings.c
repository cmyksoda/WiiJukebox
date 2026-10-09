// SPDX-License-Identifier: GPL-3.0-only
#include "settings.h"
#include <stdio.h>
#include <string.h>

static int blank(char c) { return c == ' ' || c == '\t' || c == '\r'; }

void wj_settings_parse(const char *text, struct wj_settings *settings) {
    while (*text) {
        size_t length = strcspn(text, "\n");
        const char *line = text, *end = text + length;
        text = *end ? end + 1 : end;
        while (line < end && blank(*line)) line++;
        while (end > line && blank(end[-1])) end--;
        const char *equals = memchr(line, '=', (size_t)(end - line));
        if (line == end || *line == '#' || !equals) continue;
        const char *key_end = equals;
        while (key_end > line && blank(key_end[-1])) key_end--;
        const char *value = equals + 1;
        while (value < end && blank(*value)) value++;
        size_t key_length = (size_t)(key_end - line), value_length = (size_t)(end - value);
        if (key_length == 5 && !strncmp(line, "theme", 5)) {
            if (value_length == 4 && !strncmp(value, "dark", 4)) settings->dark = 1;
            else if (value_length == 5 && !strncmp(value, "light", 5)) settings->dark = 0;
        }
    }
}

void wj_settings_format(const struct wj_settings *settings, char *out, size_t size) {
    snprintf(out, size, "theme=%s\n", settings->dark ? "dark" : "light");
}
