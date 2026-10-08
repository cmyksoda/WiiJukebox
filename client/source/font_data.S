/* SPDX-License-Identifier: GPL-3.0-only */
/* The UI fonts are linked into the DOL so wiiload needs no SD files. */
    .section .rodata
    .balign 32
    .global wj_font_latin, wj_font_latin_end
wj_font_latin:
    .incbin FONT_LATIN
wj_font_latin_end:
    .balign 32
    .global wj_font_cjk, wj_font_cjk_end
wj_font_cjk:
    .incbin FONT_CJK
wj_font_cjk_end:
