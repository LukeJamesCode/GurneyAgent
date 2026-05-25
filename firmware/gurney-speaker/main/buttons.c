#include "buttons.h"
#include "config.h"
#include "ws_client.h"
#include "audio_in.h"
#include "audio_out.h"
#include "nvs_store.h"
#include "ui.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "gs_btn";

static float s_volume = GS_DEFAULT_VOLUME;
static bool s_muted = false;

typedef struct {
    gpio_num_t pin;
    const char *name;
    bool last_level;
    int stable_ms;
} btn_t;

static void apply_volume(float new_vol) {
    if (new_vol < 0) new_vol = 0;
    if (new_vol > 1) new_vol = 1;
    s_volume = new_vol;
    gs_audio_out_set_volume(s_volume);
    gs_ui_set_volume(s_volume);
    gs_nvs_save_volume(s_volume);
    gs_ws_send_state_sync(s_volume, true, false, false);
}

static void apply_mute(bool muted) {
    s_muted = muted;
    gs_audio_in_set_muted(muted);
    gs_audio_out_set_muted(muted);
    gs_nvs_save_muted(muted);
    gs_ws_send_state_sync(0.f, false, muted, true);
}

static void handle_press(const char *name) {
    ESP_LOGI(TAG, "button: %s", name);
    gs_ws_send_button(name);
    if (!strcmp(name, "vol_up"))    apply_volume(s_volume + 0.1f);
    else if (!strcmp(name, "vol_down")) apply_volume(s_volume - 0.1f);
    else if (!strcmp(name, "mute"))     apply_mute(!s_muted);
    // "spare" is wired but unused in v0.1.
}

static void buttons_task(void *arg) {
    (void)arg;
    btn_t btns[] = {
        { GS_PIN_BTN_VOL_UP,   "vol_up",   true, 0 },
        { GS_PIN_BTN_VOL_DOWN, "vol_down", true, 0 },
        { GS_PIN_BTN_MUTE,     "mute",     true, 0 },
        { GS_PIN_BTN_SPARE,    "spare",    true, 0 },
    };
    for (size_t i = 0; i < sizeof(btns) / sizeof(btns[0]); i++) {
        gpio_config_t cfg = {
            .pin_bit_mask = 1ULL << btns[i].pin,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&cfg);
    }

    for (;;) {
        for (size_t i = 0; i < sizeof(btns) / sizeof(btns[0]); i++) {
            bool level = gpio_get_level(btns[i].pin) != 0;
            if (level != btns[i].last_level) {
                btns[i].stable_ms = 0;
                btns[i].last_level = level;
            } else {
                btns[i].stable_ms += GS_BUTTON_POLL_MS;
            }
            // Falling edge held past the debounce window = press.
            if (!level && btns[i].stable_ms == GS_BUTTON_DEBOUNCE_MS) {
                handle_press(btns[i].name);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(GS_BUTTON_POLL_MS));
    }
}

int gs_buttons_start(void) {
    return xTaskCreate(buttons_task, "gs_btn", GS_TASK_STACK_BUTTONS, NULL, 3, NULL) == pdPASS
               ? 0
               : -1;
}
