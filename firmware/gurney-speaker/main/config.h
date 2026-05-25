// Compile-time configuration: pin map, buffer sizes, defaults.
//
// PIN ASSIGNMENTS ARE PLACEHOLDERS. They were chosen to avoid the ESP32-S3's
// strapping pins (0, 3, 45, 46) and USB pins (19, 20), but real wiring must
// be cross-checked against the dev board's silkscreen + the actual schematic
// before flashing.

#pragma once

#include "driver/gpio.h"

// ---- I2S0: microphone input (stereo INMP441 / ICS-43434) ------------------

#define GS_MIC_I2S_PORT       0
#define GS_MIC_SAMPLE_RATE_HZ 16000  // whisper.cpp's required rate
#define GS_MIC_CHANNELS       2      // stereo so ESP-SR has a reference channel for AEC
#define GS_MIC_BITS_PER_SAMPLE 32    // INMP441/ICS-43434 output 24-bit-in-32-bit slots

#define GS_PIN_MIC_BCLK       GPIO_NUM_4
#define GS_PIN_MIC_WS         GPIO_NUM_5
#define GS_PIN_MIC_DIN        GPIO_NUM_6

// ---- I2S1: amp output (MAX98357A) -----------------------------------------

#define GS_AMP_I2S_PORT       1
// Server-side ffmpeg encodes Opus at 48 kHz mono (gurney-voice/synth.ts:93);
// Opus has no native 22.05 kHz rate so we play out at the codec's rate rather
// than resampling on the device.
#define GS_AMP_SAMPLE_RATE_HZ 48000
#define GS_AMP_CHANNELS       1
#define GS_AMP_BITS_PER_SAMPLE 16

#define GS_PIN_AMP_BCLK       GPIO_NUM_7
#define GS_PIN_AMP_WS         GPIO_NUM_8
#define GS_PIN_AMP_DOUT       GPIO_NUM_9

// ---- SPI display: 1.28" GC9A01 round 240x240 ------------------------------

#define GS_LCD_WIDTH          240
#define GS_LCD_HEIGHT         240
#define GS_PIN_LCD_SCK        GPIO_NUM_12
#define GS_PIN_LCD_MOSI       GPIO_NUM_11
#define GS_PIN_LCD_DC         GPIO_NUM_10
#define GS_PIN_LCD_CS         GPIO_NUM_13
#define GS_PIN_LCD_RST        GPIO_NUM_14
// No BL pin on this LCD module — backlight is hardwired to VCC on the
// breakout. GPIO 15 is reused below for vol_up.

// ---- Buttons --------------------------------------------------------------

#define GS_PIN_BTN_VOL_UP     GPIO_NUM_15
#define GS_PIN_BTN_VOL_DOWN   GPIO_NUM_16
#define GS_PIN_BTN_MUTE       GPIO_NUM_17
#define GS_PIN_BTN_SPARE      GPIO_NUM_39   // reserved for pairing — not wired in v0.1
#define GS_BUTTON_DEBOUNCE_MS 30
#define GS_BUTTON_POLL_MS     20

// ---- Audio buffers --------------------------------------------------------

// 20 ms of 16 kHz mono int16 PCM — matches what we ship per WS frame.
#define GS_PCM_FRAME_SAMPLES  (GS_MIC_SAMPLE_RATE_HZ / 50)
#define GS_PCM_FRAME_BYTES    (GS_PCM_FRAME_SAMPLES * 2)

// Max single WS frame we'll accept inbound. The largest legitimate frame is
// a TTS audio chunk (4 KB on the server side); double it for headroom.
#define GS_MAX_WS_FRAME_BYTES 8192

// ---- Defaults persisted to NVS --------------------------------------------

#define GS_DEFAULT_VOLUME     0.6f
#define GS_DEFAULT_WAKE_MODEL "wakenet9_hiesp"

// ---- Task config ----------------------------------------------------------

#define GS_TASK_STACK_WS      8192
#define GS_TASK_STACK_AUDIO   8192
#define GS_TASK_STACK_UI      8192
#define GS_TASK_STACK_BUTTONS 3072
