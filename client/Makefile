DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
export DEVKITPRO DEVKITPPC
ifneq ($(MAKECMDGOALS),host-test)
include $(DEVKITPPC)/wii_rules
endif
.DEFAULT_GOAL := all
CC := $(DEVKITPPC)/bin/powerpc-eabi-gcc
CXX := $(DEVKITPPC)/bin/powerpc-eabi-g++
CFLAGS := -O2 -g -std=gnu11 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -Ibuild -MMD -MP
DISCOVERY_PORT ?= 4001
LIBS := -lfat -lwiiuse -lbte -lmad -lasnd -logc -lm
OBJECTS := $(patsubst source/%.c,build/%.o,$(wildcard source/*.c)) build/visualizer.o build/presets.o build/mp3player.o
include projectm.mk
.PHONY: all clean host-test package FORCE
all: dist/apps/wiijukebox/boot.dol
build:
	mkdir -p $@
build/discovery_port.h: FORCE | build
	@printf '#define WJ_DISCOVERY_PORT %s\n' '$(DISCOVERY_PORT)' > $@.tmp
	@cmp -s $@.tmp $@ && rm $@.tmp || mv $@.tmp $@
build/main.o: build/discovery_port.h
build/%.o: source/%.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/wiijukebox.elf: $(OBJECTS) build/libprojectM.a
	$(CXX) $^ $(MACHDEP) -L$(LIBOGC_LIB) $(LIBS) -Wl,-Map,build/wiijukebox.map -o $@
dist/apps/wiijukebox/boot.dol: build/wiijukebox.elf
	$(DEVKITPRO)/tools/bin/elf2dol $< $@
HOST_CC ?= cc
HOST_CFLAGS ?= -O2 -g
host-test: | build
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/playback_clock.c tests/playback_clock_test.c -o build/playback_clock_test
	./build/playback_clock_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/progress.c tests/progress_test.c -o build/progress_test
	./build/progress_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -pthread -Isource source/pcm_snapshot.c tests/pcm_snapshot_test.c -o build/pcm_snapshot_test
	./build/pcm_snapshot_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/wire.c source/menu.c tests/menu_test.c -o build/menu_test
	./build/menu_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/init_wait.c tests/init_wait_test.c -o build/init_wait_test
	./build/init_wait_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -DGEKKO -Itests/ios_shim -Isource source/wire.c source/net.c tests/ios_shim.c tests/http_probe.c -o build/ios_http_probe
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/wire.c tests/wire_test.c -o build/wire_test
	./build/wire_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -pthread -Isource source/wire.c source/net.c source/audio_buffer.c tests/audio_buffer_test.c -o build/audio_buffer_test
	./build/audio_buffer_test
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -Isource source/wire.c source/net.c tests/http_probe.c -o build/http_probe
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -pthread -Isource source/wire.c source/net.c source/audio_buffer.c tests/network_probe.c -o build/network_probe
	$(HOST_CC) $(HOST_CFLAGS) -std=gnu11 -Wall -Wextra -Werror -pthread -Isource source/wire.c source/net.c source/audio_buffer.c tests/resume_probe.c -o build/resume_probe
package: all
	python3 ../tools/package-client.py
clean:
	rm -rf build dist/apps/wiijukebox/boot.dol
-include $(OBJECTS:.o=.d)
