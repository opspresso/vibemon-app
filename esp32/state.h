/*
 * VibeMon State Management
 * Global variables, state helpers, and timer functions
 */

#ifndef STATE_H
#define STATE_H

// =============================================================================
// Global Variables
// =============================================================================

// Persistent storage for settings
Preferences preferences;

// tft instance is defined in TFT_Compat.h

// Sprite buffer for double buffering (prevents flickering)
TFT_eSprite charSprite(&tft);
bool spriteInitialized = false;

// State variables (char arrays instead of String for memory efficiency)
// Note: AppState enum is defined in sprites.h
AppState currentState = STATE_START;
AppState previousState = STATE_START;

// Blink animation state machine (non-blocking)
enum BlinkPhase { BLINK_NONE, BLINK_CLOSED };
BlinkPhase blinkPhase = BLINK_NONE;
unsigned long blinkPhaseStart = 0;
char currentCharacter[16] = "clawd";  // "clawd", "kiro", "claw", or "codex"
char currentProject[32] = "";
char currentTool[32] = "";
char currentModel[32] = "";
int currentMemory = 0;
int currentUsage5h = 0;    // 5-hour session plan-usage % (account-global)
int currentUsageWeek = 0;  // weekly plan-usage % (account-global)
unsigned long lastUpdate = 0;
unsigned long lastBlink = 0;
int animFrame = 0;
bool needsRedraw = true;
int lastCharX = CHAR_X_BASE;  // Track last character X for efficient redraw
int lastCharY = CHAR_Y_BASE;  // Track last character Y for efficient redraw

// Board type (set from BOARD_TYPE in setup(), used throughout)
int g_boardType = BOARD_TYPE;

// Project lock
char projectList[MAX_PROJECTS][32];  // List of incoming projects
int projectCount = 0;
char lockedProject[32] = "";  // Locked project name (empty = unlocked)
int lockMode = LOCK_MODE_ON_THINKING;  // Default: on-thinking

// Dirty rect tracking for efficient redraws
bool dirtyCharacter = true;
bool dirtyStatus = true;
bool dirtyInfo = true;

// State timeouts
unsigned long lastActivityTime = 0;

// Serial input buffer (avoid String allocation)
char serialBuffer[512];
int serialBufferPos = 0;
bool serialOverflow = false;

// WiFi variables (conditional)
#ifdef USE_WIFI
bool provisioningMode = false;
const char* AP_SSID = "VibeMon-Setup";
const char* AP_PASSWORD = "vibemon123";
DNSServer dnsServer;
const byte DNS_PORT = 53;

char wifiSSID[64] = "";
char wifiPassword[64] = "";

// Fallback to credentials.h if defined
#ifdef WIFI_SSID
const char* defaultSSID = WIFI_SSID;
const char* defaultPassword = WIFI_PASSWORD;
#else
const char* defaultSSID = "";
const char* defaultPassword = "";
#endif

WebServer server(80);

const unsigned long WIFI_CHECK_INTERVAL = 10000;  // Check every 10 seconds
unsigned long lastWifiCheck = 0;
bool wifiWasConnected = false;

#ifdef USE_WEBSOCKET
WebSocketsClient webSocket;
bool wsConnected = false;

char wsToken[128] = "";

// Fallback to credentials.h if defined
#ifdef WS_TOKEN
const char* defaultWSToken = WS_TOKEN;
#else
const char* defaultWSToken = "";
#endif

// Exponential backoff for reconnection (server-friendly)
const unsigned long WS_RECONNECT_INITIAL = 5000;   // 5 seconds
const unsigned long WS_RECONNECT_MAX = 15000;       // 15 seconds (reduced from 60s)
const unsigned long WS_RECONNECT_BACKOFF = 300000;  // 5 minutes (after max failures)
const float WS_RECONNECT_MULTIPLIER = 1.5;
unsigned long wsReconnectDelay = WS_RECONNECT_INITIAL;

// Track consecutive failures to distinguish persistent errors (e.g., bad token)
// from transient network issues. After WS_MAX_FAILURES, slow down to 5-minute intervals.
const uint8_t WS_MAX_FAILURES = 10;
uint8_t wsConsecutiveFailures = 0;

// Track when WebSocket last disconnected (for health check)
unsigned long wsDisconnectedSince = 0;
const unsigned long WS_REINIT_TIMEOUT = 120000;  // Force reinit if disconnected >120s

// Heartbeat to detect stale connections (relaxed for modem sleep compatibility)
const unsigned long WS_HEARTBEAT_INTERVAL = 30000;  // Ping every 30s
const unsigned long WS_HEARTBEAT_TIMEOUT = 10000;   // Pong timeout 10s (modem sleep adds 100-300ms)
const uint8_t WS_HEARTBEAT_FAILURES = 2;            // Disconnect after 2 missed
#endif
#endif

// =============================================================================
// State & Utility Helpers
// =============================================================================

// Helper: Parse state string to enum
AppState parseState(const char* stateStr) {
  if (strcmp(stateStr, "start") == 0) return STATE_START;
  if (strcmp(stateStr, "idle") == 0) return STATE_IDLE;
  if (strcmp(stateStr, "thinking") == 0) return STATE_THINKING;
  if (strcmp(stateStr, "planning") == 0) return STATE_PLANNING;
  if (strcmp(stateStr, "working") == 0) return STATE_WORKING;
  if (strcmp(stateStr, "packing") == 0) return STATE_PACKING;
  if (strcmp(stateStr, "notification") == 0) return STATE_NOTIFICATION;
  if (strcmp(stateStr, "done") == 0) return STATE_DONE;
  if (strcmp(stateStr, "sleep") == 0) return STATE_SLEEP;
  if (strcmp(stateStr, "alert") == 0) return STATE_ALERT;
  return STATE_IDLE;  // default
}

// Helper: Get state string from enum
const char* getStateString(AppState state) {
  switch (state) {
    case STATE_START: return "start";
    case STATE_IDLE: return "idle";
    case STATE_THINKING: return "thinking";
    case STATE_PLANNING: return "planning";
    case STATE_WORKING: return "working";
    case STATE_PACKING: return "packing";
    case STATE_NOTIFICATION: return "notification";
    case STATE_DONE: return "done";
    case STATE_SLEEP: return "sleep";
    case STATE_ALERT: return "alert";
    default: return "idle";
  }
}

// Helper: True for states that show slow loading dots (thought bubble)
bool isLoadingState(AppState state) {
  return state == STATE_THINKING || state == STATE_PLANNING || state == STATE_PACKING;
}

// Helper: True for all active states that auto-timeout to idle after 5 minutes
bool isActiveState(AppState state) {
  return state == STATE_THINKING || state == STATE_PLANNING || state == STATE_WORKING ||
         state == STATE_NOTIFICATION || state == STATE_PACKING || state == STATE_ALERT;
}

// Helper: Get loop delay based on current state (reduces CPU usage in low-activity states)
int getLoopDelay() {
  if (currentState == STATE_SLEEP) return LOOP_DELAY_SLEEP;
  if (isActiveState(currentState)) return LOOP_DELAY_ACTIVE;
  return LOOP_DELAY_IDLE;
}

// State transition: updates state variables and sets dirty flags.
// Rendering is handled centrally in loop() via drawStatus().
void transitionToState(AppState newState, bool resetTimer = true) {
  previousState = currentState;
  currentState = newState;
  if (resetTimer) lastActivityTime = millis();
  needsRedraw = true;
  dirtyCharacter = true;
  dirtyStatus = true;

#ifdef ALERT_PIN
  digitalWrite(ALERT_PIN, (newState == STATE_ALERT) ? HIGH : LOW);
#endif
}

// Check state timeouts for auto-transitions
void checkSleepTimer() {
#ifdef USE_WIFI
  if (provisioningMode) return;  // Skip sleep timer during WiFi provisioning
#endif
  unsigned long now = millis();

  // start/done -> idle after 1 minute
  if (currentState == STATE_START || currentState == STATE_DONE) {
    if (now - lastActivityTime >= IDLE_TIMEOUT) {
      transitionToState(STATE_IDLE);
      return;
    }
  }

  // active states -> idle after 5 minutes
  if (isActiveState(currentState)) {
    if (now - lastActivityTime >= SLEEP_TIMEOUT) {
      transitionToState(STATE_IDLE);
      return;
    }
  }

  // idle -> sleep after 5 minutes
  if (currentState == STATE_IDLE) {
    if (now - lastActivityTime >= SLEEP_TIMEOUT) {
      transitionToState(STATE_SLEEP, false);
    }
  }
}

#endif // STATE_H
