// Boot orchestration. Order matters:
//   1. NVS — everything else reads from it
//   2. WiFi — synchronous wait for IP so we don't open the WS too early
//   3. UI — paints "idle" while the rest is coming up
//   4. WS client — opens the connection; hello triggers welcome
//   5. audio_out + audio_in — once the WS is alive, mic and amp tasks start
//   6. buttons — last so a stray boot-time press doesn't fire a state-sync
//      into a half-initialised stack
//
// Welcome callback wires the server's pushed config (display style, volume,
// voice id) into the relevant subsystems.

#include <string.h>

#include "audio_in.h"
#include "audio_out.h"
#include "buttons.h"
#include "config.h"
#include "nvs_store.h"
#include "ui.h"
#include "ws_client.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"

static const char *TAG = "gs_main";
static const char *FW_VERSION = "0.1.0";

#define WIFI_GOT_IP_BIT BIT0
static EventGroupHandle_t s_wifi_evt;
static gs_nvs_settings_t s_nvs;

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "wifi disconnected, retrying");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "got ip");
        xEventGroupSetBits(s_wifi_evt, WIFI_GOT_IP_BIT);
    }
}

static esp_err_t wifi_connect_blocking(const char *ssid, const char *psk) {
    s_wifi_evt = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL, NULL));

    wifi_config_t wifi_cfg = {0};
    strncpy((char *)wifi_cfg.sta.ssid, ssid, sizeof(wifi_cfg.sta.ssid) - 1);
    strncpy((char *)wifi_cfg.sta.password, psk, sizeof(wifi_cfg.sta.password) - 1);
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    // Block up to 30 s for the first IP; after that we fall through and let
    // the WS client see no connection (it'll log & idle).
    EventBits_t bits = xEventGroupWaitBits(s_wifi_evt, WIFI_GOT_IP_BIT, pdFALSE, pdTRUE,
                                           pdMS_TO_TICKS(30000));
    return (bits & WIFI_GOT_IP_BIT) ? ESP_OK : ESP_ERR_TIMEOUT;
}

static void on_welcome(const gs_welcome_t *welcome) {
    if (!welcome->ok) return;
    gs_audio_out_set_volume(welcome->volume);
    // Display style only takes effect at boot in v0.1; logging it lets the
    // user verify the server pushed what they expect.
    ESP_LOGI(TAG, "server welcome: display=%d, voice=%s",
             (int)welcome->display_style, welcome->voice_id);
}

static void on_state(gs_device_state_t state) {
    gs_ui_set_state(state);
    gs_audio_in_on_server_state(state);
}

void app_main(void) {
    ESP_LOGI(TAG, "gurney-speaker firmware v%s booting", FW_VERSION);

    ESP_ERROR_CHECK(gs_nvs_init());
    ESP_ERROR_CHECK(gs_nvs_load(&s_nvs));

    if (!s_nvs.wifi_ssid[0] || !s_nvs.server_url[0] || !s_nvs.secret[0]) {
        ESP_LOGE(TAG, "missing provisioning: wifi.ssid/srv.url/dev.secret. See README.");
        // Keep running so the user can re-flash NVS without re-flashing the
        // firmware. UI shows "idle" indefinitely.
    }

    // UI first so we have something on the screen during WiFi connect.
    // Display style starts at MINIMAL; welcome can push the user's choice.
    ESP_ERROR_CHECK(gs_ui_start(GS_DISPLAY_MINIMAL) == 0 ? ESP_OK : ESP_FAIL);
    gs_ui_set_state(GS_STATE_IDLE);

    if (s_nvs.wifi_ssid[0]) {
        esp_err_t err = wifi_connect_blocking(s_nvs.wifi_ssid, s_nvs.wifi_psk);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "wifi connect timed out — will keep retrying in the background");
        }
    }

    gs_audio_out_set_volume(s_nvs.last_volume);
    ESP_ERROR_CHECK(gs_audio_out_start() == 0 ? ESP_OK : ESP_FAIL);

    if (s_nvs.server_url[0] && s_nvs.secret[0]) {
        gs_ws_config_t ws_cfg = {
            .server_url = s_nvs.server_url,
            .device_id = s_nvs.device_id,
            .secret = s_nvs.secret,
            .fw_version = FW_VERSION,
            .on_welcome = on_welcome,
            .on_state = on_state,
            .on_tts_chunk = gs_audio_out_on_tts_chunk,
        };
        if (gs_ws_start(&ws_cfg) != 0) {
            ESP_LOGE(TAG, "ws client failed to start");
        }
    }

    gs_audio_in_cfg_t ain_cfg = { .wake_model_id = s_nvs.wake_model };
    if (gs_audio_in_start(&ain_cfg) != 0) {
        ESP_LOGE(TAG, "audio_in failed to start");
    }

    if (gs_buttons_start() != 0) {
        ESP_LOGE(TAG, "buttons failed to start");
    }

    if (s_nvs.last_muted) {
        gs_audio_in_set_muted(true);
        gs_audio_out_set_muted(true);
        gs_ui_set_state(GS_STATE_MUTED);
    }

    ESP_LOGI(TAG, "boot complete");
}
