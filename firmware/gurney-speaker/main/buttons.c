#include "buttons.h"
#include "config.h"
#include "ws_client.h"
#include "audio_in.h"
#include "audio_out.h"
#include "nvs_store.h"
#include "ui.h"

#include <string.h>

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
    // True while the button is currently considered "held" (post-debounce
    // press, pre-debounce release). Used to drive PTT and to suppress
    // duplicate press events from a single hold.
    bool held;
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
    ESP_LOGI(TAG, "button press: %s", name);
    gs_ws_send_button(name);
    if (!strcmp(name, "vol_up"))    apply_volume(s_volume + 0.1f);
    else if (!strcmp(name, "vol_down")) apply_volume(s_volume - 0.1f);
    else if (!strcmp(name, "mute"))     apply_mute(!s_muted);
    else if (!strcmp(name, "spare"))    gs_audio_in_set_ptt(true);
}

static void handle_release(const char *name) {
    // Only the PTT button cares about release. Logged at debug to avoid
    // doubling the noise from every press in normal logs.
    if (!strcmp(name, "spare")) {
        ESP_LOGI(TAG, "button release: spare (PTT)");
        gs_audio_in_set_ptt(false);
    }
}

static void buttons_task(void *arg) {
    (void)arg;
    btn_t btns[] = {
        { GS_PIN_BTN_VOL_UP,   "vol_up",   true, 0, false },
        { GS_PIN_BTN_VOL_DOWN, "vol_down", true, 0, false },
        { GS_PIN_BTN_MUTE,     "mute",     true, 0, false },
        { GS_PIN_BTN_SPARE,    "spare",    true, 0, false },
    };
    for (size_t i = 0; i < sizeof(btns) / sizeof(btns[0]); i++) {
        gpio_config_t cfg = {
            .pin_bit_mask = 1ULL << btns[i].pin,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&cfg);
        // Read once at boot. With pull-up enabled and nothing pressed, every
        // pin should be HIGH (1). A 0 here means either a wiring fault or the
        // pin's pull-up isn't taking (some pins are RTC/strapping and behave
        // differently).
        bool level0 = gpio_get_level(btns[i].pin) != 0;
        btns[i].last_level = level0;
        ESP_LOGI(TAG, "init %s on GPIO%d: err=%d initial_level=%d",
                 btns[i].name, btns[i].pin, (int)err, (int)level0);
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
            if (!level && !btns[i].held && btns[i].stable_ms >= GS_BUTTON_DEBOUNCE_MS) {
                btns[i].held = true;
                handle_press(btns[i].name);
            }
            // Rising edge stable past the debounce window = release.
            if (level && btns[i].held && btns[i].stable_ms >= GS_BUTTON_DEBOUNCE_MS) {
                btns[i].held = false;
                handle_release(btns[i].name);
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
