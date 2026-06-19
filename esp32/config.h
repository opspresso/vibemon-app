/*
 * VibeMon Configuration
 * Constants, macros, and compile-time settings
 */

#ifndef CONFIG_H
#define CONFIG_H

// Version string
#define VERSION "v1.10.0"

// Screen size (layout uses 1.47" dimensions; 1.9" board offset handled in LGFX configure())
#define SCREEN_WIDTH  172
#define SCREEN_HEIGHT 320

// Layout positions (adjusted for 128x128 character on 172x320 screen)
#define CHAR_X_BASE   22   // (172 - 128) / 2 = 22
#define CHAR_Y_BASE   10   // Base Y position (float ±5px → 5~15)
#define FLOAT_AMPLITUDE_X 3  // Floating animation amplitude X (pixels)
#define FLOAT_AMPLITUDE_Y 5  // Floating animation amplitude Y (pixels)
#define STATUS_TEXT_Y 150  // size 3 (24px) → bottom 174
#define LOADING_Y     180  // dots after status text (gap 6px) → bottom ~188
#define PROJECT_Y     198  // info rows: 21px spacing (compact to fit metric rows)
#define TOOL_Y        219
#define MODEL_Y       240
// Metric rows (single-line: icon + inline bar + NN%): memory, 5h usage, weekly usage
#define MEMORY_Y      261  // font ~14px → bottom 275
#define USAGE5H_Y     282
#define USAGEWEEK_Y   303  // text bottom ~317
#define METRIC_ICON_X  10  // pixel icon left
#define METRIC_BAR_X   24  // inline bar left
#define METRIC_BAR_W  100  // bar width (24..124)
#define METRIC_TEXT_X 132  // "NN%" text left (after bar)
#define METRIC_TEXT_W  32  // right-aligned "100%" text width
#define METRIC_BAR_H    8  // bar height (centered in row)
#define BRAND_Y       308  // start screen only (size 1, 8px)

// Animation timing
#define BLINK_INTERVAL       3200  // Blink interval in idle state (ms)
#define BLINK_DURATION        100  // Blink closed-eye hold duration (ms)

// Animation periods (in animation frames, each frame = 100ms tick)
#define ANIM_SPARKLE_PERIOD     4  // 4-point star rotation (400ms cycle)
#define ANIM_THOUGHT_PERIOD    12  // Thought bubble size toggle (1.2s cycle)
#define ANIM_ZZZ_PERIOD        20  // Z blink on/off (2s cycle)
#define ANIM_FLOAT_TABLE_SIZE  32  // Floating sine/cosine lookup entries (~3.2s cycle)
#define ANIM_FRAME_WRAP      4800  // LCM(32,12,20,4)=480 × 10 for safety

// State timeouts
#define IDLE_TIMEOUT 60000            // 1 minute (start/done -> idle)
#define SLEEP_TIMEOUT 300000          // 5 minutes (idle -> sleep)

// JSON buffer size for StaticJsonDocument
// Increased to 1024 for WebSocket nested payloads:
// {"type":"status","data":{"state":"...", "project":"...", "model":"...", ...}}
#define JSON_BUFFER_SIZE 1024

// Project lock modes
#define LOCK_MODE_FIRST_PROJECT 0
#define LOCK_MODE_ON_THINKING 1
#define MAX_PROJECTS 10

// Board types (selected at compile time via BOARD_TYPE in credentials.h)
#define BOARD_1_47  0   // ESP32-C6-LCD-1.47  (172x320, GPIO22 PWM backlight)
#define BOARD_1_9   1   // ESP32-C6-LCD-1.9   (170x320, GPIO15 direct backlight, active-low)

// Default board type if not set in credentials.h
#ifndef BOARD_TYPE
#define BOARD_TYPE BOARD_1_47
#endif

// WiFi connection
#define WIFI_CONNECT_ATTEMPTS  20  // Max connection attempts per round
#define WIFI_CONNECT_DELAY_MS 500  // Delay between each attempt (ms)
#define WIFI_CONNECT_RETRIES    3  // Number of full rounds before giving up
#define WIFI_FAIL_RESTART_MS 2000  // Delay before reboot on connection failure (ms)

// Backlight
#define BACKLIGHT_PIN_1_9  15   // 1.9" board: GPIO15 direct (LOW=on, HIGH=off)
#define BACKLIGHT_NORMAL  255   // 1.47" board: PWM brightness (0-255)
#define BACKLIGHT_SLEEP    64

// Loop delays per state category (ms)
#define LOOP_DELAY_ACTIVE   10  // thinking, planning, working, packing, notification, alert
#define LOOP_DELAY_IDLE     30  // start, idle, done
#define LOOP_DELAY_SLEEP   100  // sleep

// Safe string copy: always null-terminates, requires array (not pointer) as dst
#define safeCopyStr(dst, src) do { strncpy(dst, src, sizeof(dst)-1); dst[sizeof(dst)-1]='\0'; } while(0)

#endif // CONFIG_H
