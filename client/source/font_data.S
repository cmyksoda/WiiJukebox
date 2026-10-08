/* SPDX-License-Identifier: GPL-3.0-only */
/* The UI font is linked into the DOL so wiiload needs no SD files. */
    .section .rodata
    .balign 32
    .global wj_font_data
wj_font_data:
    .incbin FONT_PATH
    .global wj_font_end
wj_font_end:
