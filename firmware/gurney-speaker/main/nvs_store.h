// NVS-backed persistence for things that must survive a reboot:
// device identity, server connection, last volume, mute, WiFi creds.
//
// Namespace `gurney_spk`. Keys are short to fit NVS's 15-char limit.

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "esp_err.h"

typedef struct {
    char device_id[40];
    char secret[64];
    char server_url[96];
    char wifi_ssid[33];
    char wifi_psk[65];
    char wake_model[24];
    float last_volume;
    bool last_muted;
} gs_nvs_settings_t;

esp_err_t gs_nvs_init(void);
esp_err_t gs_nvs_load(gs_nvs_settings_t *out);
esp_err_t gs_nvs_save_volume(float volume);
esp_err_t gs_nvs_save_muted(bool muted);
