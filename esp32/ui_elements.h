/*
 * VibeMon UI Elements
 * Status text functions and UI icon drawing
 *
 * Dependencies (must be included before this file):
 *   - TFT_Compat.h (TFT_eSPI type)
 *   - sprites.h (AppState enum)
 */

#ifndef UI_ELEMENTS_H
#define UI_ELEMENTS_H

// =============================================================================
// Status Text Functions
// =============================================================================

// Get working text based on tool (matches Desktop TOOL_TEXTS)
void getWorkingText(const char* tool, char* buf, size_t bufSize) {
  if (strlen(tool) == 0) {
    strncpy(buf, "Working", bufSize - 1);
  } else if (strcasecmp(tool, "bash") == 0) {
    strncpy(buf, "Running", bufSize - 1);
  } else if (strcasecmp(tool, "read") == 0) {
    strncpy(buf, "Reading", bufSize - 1);
  } else if (strcasecmp(tool, "edit") == 0) {
    strncpy(buf, "Editing", bufSize - 1);
  } else if (strcasecmp(tool, "write") == 0) {
    strncpy(buf, "Writing", bufSize - 1);
  } else if (strcasecmp(tool, "grep") == 0 || strcasecmp(tool, "websearch") == 0) {
    strncpy(buf, "Searching", bufSize - 1);
  } else if (strcasecmp(tool, "glob") == 0) {
    strncpy(buf, "Scanning", bufSize - 1);
  } else if (strcasecmp(tool, "webfetch") == 0) {
    strncpy(buf, "Fetching", bufSize - 1);
  } else if (strcasecmp(tool, "task") == 0) {
    strncpy(buf, "Tasking", bufSize - 1);
  } else {
    strncpy(buf, "Working", bufSize - 1);
  }
  buf[bufSize - 1] = '\0';
}

// Get status text for state (writes to buffer)
void getStatusTextEnum(AppState state, char* buf, size_t bufSize) {
  switch (state) {
    case STATE_START:
      strncpy(buf, "Hello!", bufSize - 1);
      break;
    case STATE_IDLE:
      strncpy(buf, "Ready", bufSize - 1);
      break;
    case STATE_THINKING:
      strncpy(buf, "Thinking", bufSize - 1);
      break;
    case STATE_PLANNING:
      strncpy(buf, "Planning", bufSize - 1);
      break;
    case STATE_WORKING:
      strncpy(buf, "Working", bufSize - 1);
      break;
    case STATE_PACKING:
      strncpy(buf, "Packing", bufSize - 1);
      break;
    case STATE_NOTIFICATION:
      strncpy(buf, "Input?", bufSize - 1);
      break;
    case STATE_DONE:
      strncpy(buf, "Done!", bufSize - 1);
      break;
    case STATE_SLEEP:
      strncpy(buf, "Zzz...", bufSize - 1);
      break;
    case STATE_ALERT:
      strncpy(buf, "Alert", bufSize - 1);
      break;
    default:
      strncpy(buf, "Ready", bufSize - 1);
      break;
  }
  buf[bufSize - 1] = '\0';
}

// =============================================================================
// UI Icon Functions
// =============================================================================

// Draw folder icon - s=1: 10x10, s=2: 20x20 pixels
void drawFolderIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  // Folder tab (top-left)
  tft.fillRect(x, y, 4*s, 2*s, color);
  // Folder body
  tft.fillRect(x, y + 2*s, 10*s, 8*s, color);
  // Inner fold line (cut through with background color)
  tft.fillRect(x + s, y + 4*s, 8*s, s, bg);
}

// Draw tool/wrench icon - s=1: 10x10, s=2: 20x20 pixels
void drawToolIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  // Wrench head (top)
  tft.fillRect(x + 2*s, y, 6*s, 4*s, color);
  tft.fillRect(x + 4*s, y, 2*s, s, bg);  // Notch
  // Handle
  tft.fillRect(x + 4*s, y + 4*s, 2*s, 6*s, color);
}

// Draw robot icon - s=1: 10x10, s=2: 20x20 pixels
void drawRobotIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  // Antenna
  tft.fillRect(x + 4*s, y, 2*s, 2*s, color);
  // Head
  tft.fillRect(x + s, y + 2*s, 8*s, 6*s, color);
  // Eyes (cut through with background color)
  tft.fillRect(x + 3*s, y + 4*s, s, 2*s, bg);
  tft.fillRect(x + 6*s, y + 4*s, s, 2*s, bg);
  // Mouth
  tft.fillRect(x + 3*s, y + 7*s, 4*s, s, bg);
  // Ears
  tft.fillRect(x, y + 3*s, s, 3*s, color);
  tft.fillRect(x + 9*s, y + 3*s, s, 3*s, color);
}

// Draw brain icon - s=1: 10x10, s=2: 20x20 pixels
void drawBrainIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  // Brain shape
  tft.fillRect(x + s, y, 8*s, 10*s, color);
  tft.fillRect(x, y + 2*s, 10*s, 6*s, color);
  // Brain folds (cut through with background color)
  tft.fillRect(x + 5*s, y + s, s, 8*s, bg);
  // Left fold
  tft.fillRect(x + 3*s, y + 3*s, s, 3*s, bg);
  // Right fold
  tft.fillRect(x + 7*s, y + 4*s, s, 3*s, bg);
  // Top bumps
  tft.fillRect(x + 3*s, y, s, s, bg);
  tft.fillRect(x + 7*s, y, s, s, bg);
}

// Draw clock icon (5-hour usage window) - s=1: 10x10 pixels
void drawClockIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  int cx = x + 5*s;
  int cy = y + 5*s;
  int r = 5*s;
  // Hollow ring
  tft.fillCircle(cx, cy, r, color);
  tft.fillCircle(cx, cy, r - s, bg);
  // Hands (hour up, minute right) from center
  tft.fillRect(cx, cy - 3*s, s, 3*s, color);
  tft.fillRect(cx, cy, 3*s, s, color);
}

// Draw calendar icon (weekly usage window) - s=1: 10x10 pixels
void drawCalendarIcon(TFT_eSPI &tft, int x, int y, uint16_t color, int s = 1, uint16_t bg = 0x0000) {
  // Binding tabs
  tft.fillRect(x + 2*s, y, s, 2*s, color);
  tft.fillRect(x + 7*s, y, s, 2*s, color);
  // Body
  tft.fillRect(x, y + s, 10*s, 9*s, color);
  // Header separator (cut through with background color)
  tft.fillRect(x + s, y + 4*s, 8*s, s, bg);
  // Day cells (cut through with background color)
  tft.fillRect(x + 2*s, y + 6*s, s, s, bg);
  tft.fillRect(x + 5*s, y + 6*s, s, s, bg);
  tft.fillRect(x + 8*s, y + 6*s, s, s, bg);
  tft.fillRect(x + 2*s, y + 8*s, s, s, bg);
  tft.fillRect(x + 5*s, y + 8*s, s, s, bg);
}

#endif // UI_ELEMENTS_H
