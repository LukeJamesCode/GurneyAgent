#include "nvs_store.h"
#include "config.h"

#include <string.h>

#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"

static const char *TAG = "gs_nvs";
static const char *NS  = "gurney_spk";

esp_err_t gs_nvs_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs partition needs erase, reformatting");
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    return err;
}

static void read_str(nvs_handle_t h, const char *key, char *out, size_t out_len, const char *def) {
    size_t len = out_len;
    esp_err_t e = nvs_get_str(h, key, out, &len);
    if (e != ESP_OK) {
        strncpy(out, def ? def : "", out_len - 1);
        out[out_len - 1] = '\0';
    }
}

esp_err_t gs_nvs_load(gs_nvs_settings_t *out) {
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "no nvs namespace yet; using defaults — provision before first boot");
        out->last_volume = GS_DEFAULT_VOLUME;
        out->last_muted = false;
        strcpy(out->wake_model, GS_DEFAULT_WAKE_MODEL);
        return ESP_OK;
    }
    if (err != ESP_OK) return err;

    read_str(h, "dev.id", out->device_id, sizeof(out->device_id), "puck-unset");
    read_str(h, "dev.secret", out->secret, sizeof(out->secret), "");
    read_str(h, "srv.url", out->server_url, sizeof(out->server_url), "");
    read_str(h, "wifi.ssid", out->wifi_ssid, sizeof(out->wifi_ssid), "");
    read_str(h, "wifi.psk", out->wifi_psk, sizeof(out->wifi_psk), "");
    read_str(h, "wake.model_id", out->wake_model, sizeof(out->wake_model), GS_DEFAULT_WAKE_MODEL);

    uint32_t v_raw = 0;
    if (nvs_get_u32(h, "vol.last", &v_raw) == ESP_OK) {
        memcpy(&out->last_volume, &v_raw, sizeof(float));
    } else {
        out->last_volume = GS_DEFAULT_VOLUME;
    }
    uint8_t m = 0;
    if (nvs_get_u8(h, "mute.last", &m) == ESP_OK) {
        out->last_muted = (m != 0);
    }

    nvs_close(h);
    return ESP_OK;
}

esp_err_t gs_nvs_save_volume(float volume) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    uint32_t v_raw;
    memcpy(&v_raw, &volume, sizeof(float));
    err = nvs_set_u32(h, "vol.last", v_raw);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t gs_nvs_save_muted(bool muted) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, "mute.last", muted ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}
