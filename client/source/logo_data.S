/* SPDX-License-Identifier: GPL-3.0-only */
/* The jukebox mark is linked into the DOL so wiiload needs no SD files. */
    .section .rodata
    .balign 32
    .global wj_logo_mark
wj_logo_mark:
    .incbin LOGO_MARK
