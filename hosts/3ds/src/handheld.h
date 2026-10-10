#pragma once
#include <stdbool.h>
#include <stdint.h>

bool handheld_init(void);
void handheld_bottom(void);
void handheld_capture_bottom(void);
void handheld_audio_pump(void);
void handheld_status(uint32_t tick, uint32_t buttons, const char *state);
void handheld_shutdown(void);
