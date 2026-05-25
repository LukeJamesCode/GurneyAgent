// LVGL bring-up is board-specific (panel driver, backlight, brightness PWM).
// This file leaves the panel init as a TODO and focuses on:
//   - One LVGL task running the tick + handler loop
//   - A screen-swap dispatch the rest of the firmware can call
//   - Placeholder draw funcs per state (label + icon) — replace with the
//     pulsing-orb or animated-eyes design once the panel is talking back
//
// Bench bring-up TODOs are marked inline.

#include "ui.h"
#include "config.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "lvgl.h"

static const char *TAG = "gs_ui";

static gs_display_style_t s_style = GS_DISPLAY_MINIMAL;
static lv_obj_t *s_screens[6] = {0};
static gs_device_state_t s_current_state = GS_STATE_IDLE;

static lv_obj_t *make_minimal_screen(const char *label, uint32_t color) {
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, label);
    lv_obj_set_style_text_color(lbl, lv_color_hex(color), 0);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
    lv_obj_center(lbl);
    return scr;
}

static lv_obj_t *make_orb_screen(const char *label, uint32_t color) {
    // TODO(bench): replace with a pulsing arc whose width tracks an audio
    // level value. For now the orb mode reuses the minimal screen so the
    // device boots cleanly while the visual is being designed.
    return make_minimal_screen(label, color);
}

static lv_obj_t *build_screen(gs_device_state_t state) {
    switch (state) {
        case GS_STATE_IDLE:      return s_style == GS_DISPLAY_ORB
            ? make_orb_screen("Gurney", 0x5099FF)
            : make_minimal_screen("idle", 0x666666);
        case GS_STATE_LISTENING: return s_style == GS_DISPLAY_ORB
            ? make_orb_screen("...",      0x33CCFF)
            : make_minimal_screen("listening", 0x33CCFF);
        case GS_STATE_THINKING:  return s_style == GS_DISPLAY_ORB
            ? make_orb_screen("...",      0xFFCC33)
            : make_minimal_screen("thinking", 0xFFCC33);
        case GS_STATE_SPEAKING:  return s_style == GS_DISPLAY_ORB
            ? make_orb_screen("",         0x33FF66)
            : make_minimal_screen("speaking", 0x33FF66);
        case GS_STATE_MUTED:     return make_minimal_screen("muted", 0xFF3333);
        default:                 return make_minimal_screen("?", 0x888888);
    }
}

static void ui_task(void *arg) {
    (void)arg;
    // TODO(bench): wire the GC9A01 panel driver via esp_lcd_panel here.
    // Typical sequence:
    //   esp_lcd_panel_io_handle_t io_handle;
    //   esp_lcd_panel_handle_t panel_handle;
    //   esp_lcd_new_panel_io_spi(...);
    //   esp_lcd_new_panel_gc9a01(io_handle, ..., &panel_handle);
    //   lv_init();
    //   lv_disp_drv_register(&disp_drv);
    lv_init();

    for (int s = 0; s <= GS_STATE_UNKNOWN; s++) {
        s_screens[s] = build_screen((gs_device_state_t)s);
    }
    if (s_screens[s_current_state]) lv_scr_load(s_screens[s_current_state]);

    for (;;) {
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

int gs_ui_start(gs_display_style_t style) {
    s_style = style;
    return xTaskCreatePinnedToCore(ui_task, "gs_ui", GS_TASK_STACK_UI, NULL, 4, NULL, 0) == pdPASS
               ? 0
               : -1;
}

void gs_ui_set_state(gs_device_state_t state) {
    if (state == s_current_state) return;
    s_current_state = state;
    if (s_screens[state]) lv_scr_load(s_screens[state]);
    ESP_LOGI(TAG, "state -> %d", (int)state);
}

void gs_ui_set_volume(float volume_0_1) {
    (void)volume_0_1;
    // TODO(bench): briefly overlay a volume arc on the active screen.
}
