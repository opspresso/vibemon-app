/*
 * VibeMon
 * ESP32-C6 LCD (172x320 / 170x320, ST7789V2)
 * Supports: ESP32-C6-LCD-1.47 and ESP32-C6-LCD-1.9 (selected via BOARD_TYPE)
 *
 * Pixel art character (128x128) with animated states
 * USB Serial + HTTP support
 */

// =============================================================================
// External Libraries
// =============================================================================

// Use LovyanGFX instead of TFT_eSPI for ESP32-C6 compatibility
#include "TFT_Compat.h"
#include <ArduinoJson.h>
#include <Preferences.h>

// WiFi configuration (create credentials.h from credentials.h.example)
#if __has_include("credentials.h")
#include "credentials.h"
#endif

// WiFi (HTTP fallback, optional)
#ifdef USE_WIFI
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>

// WebSocket client (optional, requires USE_WIFI)
#ifdef USE_WEBSOCKET
#include <WebSocketsClient.h>
#endif
#endif

// =============================================================================
// App Modules (order matters: dependency chain)
// =============================================================================

#include "config.h"
#include "sprites.h"
#include "ui_elements.h"
#include "state.h"
#include "display.h"
#include "project_lock.h"
#include "input.h"

#ifdef USE_WIFI
#include "wifi_portal.h"
#include "wifi_manager.h"
#endif

// =============================================================================
// Backlight
// =============================================================================

// Initialize backlight based on board type (set at compile time via BOARD_TYPE).
// BOARD_1_47: LovyanGFX PWM on GPIO22 (setBrightness).
// BOARD_1_9:  Direct GPIO15 (active-low: LOW=on, HIGH=off) — matches Waveshare demo.
void initBacklight(int boardType) {
  if (boardType == BOARD_1_9) {
    pinMode(BACKLIGHT_PIN_1_9, OUTPUT);
    digitalWrite(BACKLIGHT_PIN_1_9, LOW);
  } else {
    tft.setBrightness(BACKLIGHT_NORMAL);
  }
}

// =============================================================================
// setup() & loop()
// =============================================================================

void setup() {
  Serial.begin(115200);

  // Reduce CPU frequency to 80MHz (sufficient for animation/WiFi, reduces heat)
  setCpuFrequencyMhz(80);

#ifdef ALERT_PIN
  pinMode(ALERT_PIN, OUTPUT);
  digitalWrite(ALERT_PIN, LOW);
#endif

  // Load settings from persistent storage
  preferences.begin("vibemon", true);  // Read-only mode
  lockMode = preferences.getInt("lockMode", LOCK_MODE_ON_THINKING);
  preferences.end();

  // Validate loaded lockMode (flash corruption safety)
  if (lockMode != LOCK_MODE_FIRST_PROJECT && lockMode != LOCK_MODE_ON_THINKING) {
    lockMode = LOCK_MODE_ON_THINKING;
    preferences.begin("vibemon", false);
    preferences.putInt("lockMode", lockMode);
    preferences.end();
  }

  // Board type from compile-time BOARD_TYPE (set in credentials.h)
  g_boardType = BOARD_TYPE;
  Serial.printf("{\"board\":\"%s\",\"version\":\"%s\"}\n",
    g_boardType == BOARD_1_9 ? "1.9" : "1.47", VERSION);

  tft.configure(g_boardType);
  tft.init();
  tft.setRotation(0);   // Portrait mode
  tft.setSwapBytes(true);  // Swap bytes for pushImage (ESP32 little-endian)
  initBacklight(g_boardType);
  tft.fillScreen(TFT_BLACK);

  // Initialize sprite buffer for character (128x128)
  charSprite.setColorDepth(16);
  charSprite.setSwapBytes(true);  // Swap bytes for sprite pushImage
  if (charSprite.createSprite(CHAR_WIDTH, CHAR_HEIGHT)) {
    spriteInitialized = true;
    Serial.println("{\"sprite\":\"initialized\",\"size\":\"128x128\"}");
  } else {
    Serial.println("{\"sprite\":\"failed\",\"error\":\"memory\"}");
  }

  // Start screen
  drawStartScreen();

  // Initialize sleep timer
  lastActivityTime = millis();

#ifdef USE_WIFI
  setupWiFi();
#ifdef USE_WEBSOCKET
  setupWebSocket();
#endif
#endif
}

void loop() {
  // === INPUT PROCESSING ===

  // USB Serial check (using char buffer instead of String)
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (serialOverflow) {
        Serial.println("{\"error\":\"input too long\"}");
        serialOverflow = false;
      } else {
        serialBuffer[serialBufferPos] = '\0';
        if (serialBufferPos > 0) {
          processInput(serialBuffer);
        }
      }
      serialBufferPos = 0;
    } else if (serialBufferPos >= (int)sizeof(serialBuffer) - 1) {
      serialOverflow = true;
    } else {
      serialBuffer[serialBufferPos++] = c;
    }
  }

#ifdef USE_WIFI
  if (provisioningMode) {
    dnsServer.processNextRequest();
  }
  checkWiFiConnection();
  server.handleClient();
#ifdef USE_WEBSOCKET
  webSocket.loop();
#endif
#endif

  // === STATE MANAGEMENT ===

  // Check sleep timer (may set dirty flags via transitionToState)
  checkSleepTimer();

  // === RENDERING ===

  // Full screen redraw if state/info changed (centralized rendering)
  if (needsRedraw || dirtyCharacter || dirtyStatus || dirtyInfo) {
    drawStatus();
  }

  // Animation update (100ms interval)
  if (millis() - lastUpdate > 100) {
    lastUpdate = millis();
    animFrame = (animFrame + 1) % ANIM_FRAME_WRAP;
    updateAnimation();
  }

  // Idle blink (non-blocking state machine)
  updateBlink();

  // Yield to FreeRTOS: state-based delay reduces CPU usage and heat.
  // Active states: 10ms, idle/done: 30ms, sleep: 100ms.
  delay(getLoopDelay());
}
