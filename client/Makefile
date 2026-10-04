DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
export DEVKITPRO DEVKITPPC
ifneq ($(MAKECMDGOALS),host-test)
include $(DEVKITPPC)/wii_rules
endif
.DEFAULT_GOAL := all
CC := $(DEVKITPPC)/bin/powerpc-eabi-gcc
CFLAGS := -O2 -g -std=gnu11 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -MMD -MP
LIBS := -lfat -lwiiuse -lbte -lmad -lasnd -logc -lm
OBJECTS := $(patsubst source/%.c,build/%.o,$(wildcard source/*.c))
.PHONY: all clean host-test package
all: dist/apps/wiijukebox/boot.dol
build:
	mkdir -p $@
build/%.o: source/%.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/wiijukebox.elf: $(OBJECTS)
	$(CC) $^ $(MACHDEP) -L$(LIBOGC_LIB) $(LIBS) -Wl,-Map,build/wiijukebox.map -o $@
dist/apps/wiijukebox/boot.dol: build/wiijukebox.elf
	$(DEVKITPRO)/tools/bin/elf2dol $< $@
HOST_CC ?= cc
HOST_CFLAGS ?= -O2 -g
host-test: | build
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/wire.c tests/wire_test.c -o build/wire_test
	./build/wire_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/wire.c source/net.c tests/network_probe.c -o build/network_probe
package: all
	python3 ../tools/package-client.py
clean:
	rm -rf build dist/apps/wiijukebox/boot.dol
-include $(OBJECTS:.o=.d)
