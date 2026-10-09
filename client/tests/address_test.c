// SPDX-License-Identifier: GPL-3.0-only
#include "address.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Types every character of `keys`, returning how many the editor accepted. */
static int type(char *text, const char *keys) {
    int accepted = 0;
    for (; *keys; keys++) accepted += wj_address_append(text, WJ_ADDRESS_TEXT, *keys);
    return accepted;
}

static void typing(void) {
    char text[WJ_ADDRESS_TEXT] = "";
    assert(type(text, "192.168.0.3") == 11 && !strcmp(text, "192.168.0.3"));
    assert(type(text, ":4005") == 5 && !strcmp(text, "192.168.0.3:4005"));

    /* A number is at most three digits, a port at most five. */
    strcpy(text, "");
    assert(type(text, "1234") == 3 && !strcmp(text, "123"));
    strcpy(text, "1.2.3.4:");
    assert(type(text, "1234567") == 5 && !strcmp(text, "1.2.3.4:12345"));

    /* Dots need a digit before them, and there are only three. */
    strcpy(text, "");
    assert(!wj_address_append(text, sizeof(text), '.'));
    strcpy(text, "1.");
    assert(!wj_address_append(text, sizeof(text), '.'));
    strcpy(text, "1.2.3.");
    assert(!wj_address_append(text, sizeof(text), '.'));
    strcpy(text, "1.2.3.4");
    assert(!wj_address_append(text, sizeof(text), '.'));

    /* A colon needs four numbers, comes once, and nothing but digits follow it. */
    strcpy(text, "1.2.3.");
    assert(!wj_address_append(text, sizeof(text), ':'));
    strcpy(text, "1.2.3");
    assert(!wj_address_append(text, sizeof(text), ':'));
    strcpy(text, "1.2.3.4:5");
    assert(!wj_address_append(text, sizeof(text), ':') && !wj_address_append(text, sizeof(text), '.'));
    strcpy(text, "1.2.3.4:");
    assert(!wj_address_append(text, sizeof(text), ':') && !wj_address_append(text, sizeof(text), '.'));

    /* Nothing else is a key, and the longest address still fits. */
    strcpy(text, "");
    assert(!wj_address_append(text, sizeof(text), 'a') && !wj_address_append(text, sizeof(text), ' '));
    assert(type(text, "255.255.255.255:65535") == 21 && strlen(text) == WJ_ADDRESS_TEXT - 1);
    assert(!wj_address_append(text, sizeof(text), '1'));
    char small[4] = "12";
    assert(wj_address_append(small, sizeof(small), '3') && !wj_address_append(small, sizeof(small), '4'));

    strcpy(text, "192.");
    assert(wj_address_backspace(text) && !strcmp(text, "192"));
    assert(wj_address_clear(text) && !text[0]);
    assert(!wj_address_backspace(text) && !wj_address_clear(text));
}

static void parsing(void) {
    struct wj_address a;
    assert(wj_address_parse("192.168.0.3:4280", &a) == WJ_ADDRESS_OK);
    assert(a.octet[0] == 192 && a.octet[1] == 168 && a.octet[2] == 0 && a.octet[3] == 3 && a.port == 4280);
    assert(wj_address_parse("10.0.0.7", &a) == WJ_ADDRESS_OK && a.port == WJ_DEFAULT_PORT && WJ_DEFAULT_PORT == 4005);
    assert(wj_address_parse("0.0.0.0:1", &a) == WJ_ADDRESS_OK && a.port == 1);
    assert(wj_address_parse("255.255.255.255:65535", &a) == WJ_ADDRESS_OK && a.octet[3] == 255 && a.port == 65535);
    assert(wj_address_parse("010.001.000.009", &a) == WJ_ADDRESS_OK && a.octet[0] == 10 && a.octet[3] == 9);
    assert(wj_address_parse("1.2.3.4", NULL) == WJ_ADDRESS_OK);

    assert(wj_address_parse("", &a) == WJ_ADDRESS_EMPTY);
    const char *incomplete[] = {
        "192", "192.168.0", "192.168.0.", "192.168.0.3.", "1.2.3.4.5", ".1.2.3", "1..2.3", "1.2.3.4 ",
        "a.b.c.d", "1.2.3.-4", "1.2.3.4444", ":4005", "192.168.0:4005", "192.168.0.:4005", "1,2,3,4",
    };
    for (size_t i = 0; i < sizeof(incomplete) / sizeof(incomplete[0]); i++)
        assert(wj_address_parse(incomplete[i], &a) == WJ_ADDRESS_INCOMPLETE);
    const char *octets[] = { "256.1.1.1", "1.1.1.300", "1.999.1.1:4005", "192.168.0.256" };
    for (size_t i = 0; i < sizeof(octets) / sizeof(octets[0]); i++)
        assert(wj_address_parse(octets[i], &a) == WJ_ADDRESS_OCTET);
    const char *ports[] = { "1.2.3.4:", "1.2.3.4:0", "1.2.3.4:65536", "1.2.3.4:99999", "1.2.3.4:123456",
                            "1.2.3.4:80:80", "1.2.3.4:x" };
    for (size_t i = 0; i < sizeof(ports) / sizeof(ports[0]); i++)
        assert(wj_address_parse(ports[i], &a) == WJ_ADDRESS_PORT);
    for (int e = WJ_ADDRESS_EMPTY; e <= WJ_ADDRESS_PORT; e++) assert(*wj_address_error_text(e));
    assert(!*wj_address_error_text(WJ_ADDRESS_OK));
}

static void formatting(void) {
    struct wj_address a;
    char out[WJ_ADDRESS_TEXT];
    assert(wj_address_parse("010.001.000.009:04005", &a) == WJ_ADDRESS_OK);
    wj_address_format(&a, out, sizeof(out));
    assert(!strcmp(out, "10.1.0.9:4005"));
    assert(wj_address_parse("255.255.255.255:65535", &a) == WJ_ADDRESS_OK);
    wj_address_format(&a, out, sizeof(out));
    assert(!strcmp(out, "255.255.255.255:65535") && strlen(out) == WJ_ADDRESS_TEXT - 1);

    wj_address_prefix("192.168.0.8", out, sizeof(out)); assert(!strcmp(out, "192.168.0."));
    wj_address_prefix("10.20.30.40", out, sizeof(out)); assert(!strcmp(out, "10.20.30."));
    wj_address_prefix("172.016.1.2", out, sizeof(out)); assert(!strcmp(out, "172.16.1."));
    const char *unusable[] = { "", "0.0.0.0", "not an ip", "192.168.0", "999.1.1.1", "192.168.0.8:80" };
    for (size_t i = 0; i < sizeof(unusable) / sizeof(unusable[0]); i++) {
        strcpy(out, "stale");
        wj_address_prefix(unusable[i], out, sizeof(out));
        assert(!out[0]);
    }
    /* A prefix is something the editor can continue. */
    char text[WJ_ADDRESS_TEXT];
    wj_address_prefix("192.168.0.8", text, sizeof(text));
    assert(type(text, "3") == 1 && wj_address_parse(text, &a) == WJ_ADDRESS_OK && a.octet[3] == 3);
}

static void saved_file(void) {
    struct wj_address a;
    char text[64];
    assert(wj_address_parse("192.168.0.3:4280", &a) == WJ_ADDRESS_OK);
    wj_address_file_text(&a, text, sizeof(text));
    assert(!strcmp(text, "192.168.0.3:4280\n"));

    struct wj_address back;
    assert(!wj_address_from_file(text, &back) && !memcmp(&a, &back, sizeof(a)));
    assert(!wj_address_from_file("192.168.0.3:4280\r\n", &back) && back.port == 4280);
    assert(!wj_address_from_file("  192.168.0.3  \n\n", &back) && back.port == WJ_DEFAULT_PORT);
    assert(!wj_address_from_file("10.0.0.1:1", &back) && back.octet[0] == 10);

    const char *bad[] = {
        "", "\n", "garbage\n", "192.168.0.3:0\n", "192.168.0.300:4005\n", "192.168.0\n",
        "192.168.0.3:4005 trailing\n", "192.168.0.3:4005\n10.0.0.1:4005\n", "192.168.0.3:4005:1\n",
        "0000000000000000000000000000000000000000\n",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        struct wj_address untouched = { { 9, 9, 9, 9 }, 9 };
        assert(wj_address_from_file(bad[i], &untouched) && untouched.port == 9);
    }
}

static void keypad(void) {
    int cells[WJ_KEYPAD_COLUMNS][WJ_KEYPAD_ROWS] = {{0}};
    for (int i = 0; i < WJ_KEY_COUNT; i++) {
        const struct wj_key *key = &wj_keypad[i];
        assert(key->rows >= 1 && key->column + 1 <= WJ_KEYPAD_COLUMNS && key->row + key->rows <= WJ_KEYPAD_ROWS);
        for (int r = key->row; r < key->row + key->rows; r++) cells[key->column][r]++;
        assert(wj_keypad_at(key->column, key->row) == i);
        if (key->kind == WJ_KEY_CHAR) assert(strchr("0123456789.:", key->character));
    }
    for (int c = 0; c < WJ_KEYPAD_COLUMNS; c++)
        for (int r = 0; r < WJ_KEYPAD_ROWS; r++) assert(cells[c][r] == 1 && wj_keypad_at(c, r) >= 0);
    assert(wj_keypad_at(-1, 0) < 0 && wj_keypad_at(0, 4) < 0 && wj_keypad_at(4, 0) < 0);

    /* Phone layout, and every digit, dot and colon is present exactly once. */
    assert(wj_keypad[wj_keypad_at(0, 0)].character == '1' && wj_keypad[wj_keypad_at(2, 2)].character == '9');
    assert(wj_keypad[wj_keypad_at(0, 3)].character == '.' && wj_keypad[wj_keypad_at(1, 3)].character == '0');
    assert(wj_keypad[wj_keypad_at(2, 3)].character == ':');
    int seen[256] = {0};
    for (int i = 0; i < WJ_KEY_COUNT; i++)
        if (wj_keypad[i].kind == WJ_KEY_CHAR) seen[(unsigned char)wj_keypad[i].character]++;
    for (const char *p = "0123456789.:"; *p; p++) assert(seen[(unsigned char)*p] == 1);

    /* Connect is two rows tall, and a focus keeps the row it entered on. */
    int connect = wj_keypad_at(3, 2);
    assert(wj_keypad[connect].kind == WJ_KEY_CONNECT && wj_keypad_at(3, 3) == connect);
    assert(wj_keypad[wj_keypad_at(3, 0)].kind == WJ_KEY_BACKSPACE && wj_keypad[wj_keypad_at(3, 1)].kind == WJ_KEY_CLEAR);
    int column = 2, row = 3;
    wj_keypad_move(&column, &row, 1, 0);
    assert(wj_keypad_at(column, row) == connect && row == 3);
    wj_keypad_move(&column, &row, -1, 0);
    assert(wj_keypad[wj_keypad_at(column, row)].character == ':');
    column = 3; row = 2;
    wj_keypad_move(&column, &row, -1, 0);
    assert(wj_keypad[wj_keypad_at(column, row)].character == '9');

    /* Moves stop at the edges rather than wrapping. */
    column = row = 0;
    wj_keypad_move(&column, &row, -1, -1);
    assert(column == 0 && row == 0);
    wj_keypad_move(&column, &row, 1, 0);
    assert(column == 1 && row == 0);
    wj_keypad_move(&column, &row, 9, 0);
    assert(column == 3 && row == 0);
    column = 0;
    for (int i = 0; i < 6; i++) wj_keypad_move(&column, &row, 1, 1);
    assert(column == 3 && row == 3);
}

int main(void) {
    typing();
    parsing();
    formatting();
    saved_file();
    keypad();
    puts("address: typing limits, parsing and errors, formatting, prefix, saved file and numpad moves passed");
    return 0;
}
