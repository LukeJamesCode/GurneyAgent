// Display state tracking. The GC9A01 panel driver + LVGL display registration
// haven't been wired yet, so this module is intentionally a no-op for v0.1:
// it logs state transitions for diagnostics and exposes the same API the rest
// of the firmware calls. When the panel comes online, add the esp_lcd_panel
// init in gs_ui_start() and re-introduce LVGL screen objects in
// gs_ui_set_state().

#include "ui.h"

#include "esp_log.h"

static const char *TAG = "gs_ui";
static gs_device_state_t s_current_state = GS_STATE_IDLE;
static gs_display_style_t s_style = GS_DISPLAY_MINIMAL;

int gs_ui_start(gs_display_style_t style) {
    s_style = style;
    ESP_LOGI(TAG, "ui module loaded (display driver deferred — no panel init in v0.1)");
    return 0;
}

void gs_ui_set_state(gs_device_state_t state) {
    if (state == s_current_state) return;
    s_current_state = state;
    ESP_LOGI(TAG, "state -> %d (style=%d)", (int)state, (int)s_style);
}

void gs_ui_set_volume(float volume_0_1) {
    // No display yet, so nothing to render. Kept on the API surface so the
    // buttons module doesn't have to special-case "is the UI up?"
    (void)volume_0_1;
}
