# The projectM 2.0.1 GX port, built from the preserved source snapshot.
PM := vendor/projectm
PM_DIRS := $(PM) $(PM)/Renderer $(PM)/MilkdropPresetFactory
PM_CPP := $(foreach dir,$(PM_DIRS),$(wildcard $(dir)/*.cpp))
PM_C := $(foreach dir,$(PM_DIRS),$(wildcard $(dir)/*.c)) $(PM)/Renderer/SOIL/stb_image_aug.c
PM_OBJECTS := $(patsubst $(PM)/%.cpp,build/projectm/%.o,$(PM_CPP)) $(patsubst $(PM)/%.c,build/projectm/%.o,$(PM_C))
PM_INCLUDES := -I$(PM) -I$(PM)/Renderer -I$(PM)/MilkdropPresetFactory -I$(PM)/Renderer/SOIL -I$(PM)/omptl -I$(PORTLIBS_PATH)/wii/include -I$(PORTLIBS_PATH)/ppc/include
PM_FLAGS := -O2 -g -fsigned-char $(MACHDEP) -D_WII_ -DPROJECTM_PREFIX=\"\" -DDATADIR_PATH=\"\" -DDISABLE_NATIVE_PRESETS $(PM_INCLUDES) -I$(LIBOGC_INC) -I$(LIBOGC_INC)/ogc -I$(LIBOGC_INC)/ogc/machine -MMD -MP
build/projectm/%.o: $(PM)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) -std=gnu++98 -Wno-deprecated-declarations -Wno-write-strings $(PM_FLAGS) -c $< -o $@
build/projectm/%.o: $(PM)/%.c
	@mkdir -p $(dir $@)
	$(CC) -std=gnu11 $(PM_FLAGS) -c $< -o $@
build/libprojectM.a: $(PM_OBJECTS)
	$(DEVKITPPC)/bin/powerpc-eabi-ar rcs $@ $^
build/presets.cpp: FORCE ../tools/embed-presets.py | build
	python3 ../tools/embed-presets.py
build/presets.o: build/presets.cpp source/presets.h
	$(CXX) -std=gnu++11 -O2 $(MACHDEP) -Isource -c $< -o $@
build/visualizer.o: source/visualizer.cpp build/tour.h
	$(CXX) -std=gnu++11 -Wall -Wextra -Werror -Wno-deprecated-declarations -Wno-unused-parameter $(PM_FLAGS) -Isource -Ibuild -c $< -o $@
build/mp3player.o: vendor/libogc/mp3player.c source/pcm_snapshot.h source/playback_clock.h
	$(CC) -O2 $(MACHDEP) -I$(LIBOGC_INC) -I$(LIBOGC_INC)/ogc -I$(LIBOGC_INC)/ogc/machine -Isource -c $< -o $@
-include $(PM_OBJECTS:.o=.d) build/visualizer.d

build/embedded-MilkdropPreset.cpp: $(PM)/MilkdropPresetFactory/MilkdropPreset.cpp ../tools/projectm-embedded-loader.py | build
	python3 ../tools/projectm-embedded-loader.py
build/projectm/MilkdropPresetFactory/MilkdropPreset.o: build/embedded-MilkdropPreset.cpp
	@mkdir -p $(dir $@)
	$(CXX) -std=gnu++98 -Wno-deprecated-declarations -Wno-write-strings $(PM_FLAGS) -c $< -o $@
