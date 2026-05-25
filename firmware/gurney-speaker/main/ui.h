// LVGL UI for the round LCD. One screen per device state; the active screen
// is swapped when a 0x20 STATE frame arrives.

#pragma once

#include "protocol.h"

int gs_ui_start(gs_display_style_t style);
void gs_ui_set_state(gs_device_state_t state);
void gs_ui_set_volume(float volume_0_1);
