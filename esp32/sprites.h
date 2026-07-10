/*
 * Vibe Monitor Character Sprites
 * 128x128 pixel art for ESP32-C6-LCD-1.47
 * (Doubled from 64x64 original design)
 */

#ifndef SPRITES_H
#define SPRITES_H

#include <Arduino.h>

// =============================================================================
// SECTION 1: State Enum
// =============================================================================

enum AppState {
  STATE_START,
  STATE_IDLE,
  STATE_THINKING,
  STATE_PLANNING,
  STATE_WORKING,
  STATE_PACKING,
  STATE_NOTIFICATION,
  STATE_DONE,
  STATE_SLEEP,
  STATE_ALERT
};

// =============================================================================
// SECTION 2: Color Constants
// =============================================================================

// Character colors (RGB565)
#define COLOR_CLAUDE      0xDBAA  // #D97757 Claude orange (217,119,87)
#define COLOR_KIRO        0xFFFF  // #FFFFFF White ghost
#define COLOR_CLAW        0xDA28  // #DD4444 Claw red (221,68,68)
#define COLOR_CODEX       0x0D0F  // #10A37F Codex green (16,163,127)
#define COLOR_EYE         0x0000  // #000000 Black
#define COLOR_EFFECT_ALT  0xFD20  // #FFA500 Orange for white character effects

// Transparent color marker for pushImage (magenta 0xF81F is common convention)
#define COLOR_TRANSPARENT_MARKER 0xF81F

// Background colors by state (RGB565)
#define COLOR_BG_SESSION  0x0679  // #00CCCC Cyan
#define COLOR_BG_IDLE     0x0540  // #00AA00 Green
#define COLOR_BG_THINKING 0x999F  // #9933FF Purple (matches Desktop)
#define COLOR_BG_PLANNING 0x0451  // #008888 Teal
#define COLOR_BG_WORKING  0x0339  // #0066CC Blue
#define COLOR_BG_PACKING  0xAD55  // #AAAAAA Gray
#define COLOR_BG_NOTIFY   0xFE60  // #FFCC00 Yellow
#define COLOR_BG_DONE     0x0540  // #00AA00 Green
#define COLOR_BG_SLEEP    0x1088  // #111144 Navy blue
#define COLOR_BG_ALERT    0xD800  // #DD0000 Red

// Text colors
#define COLOR_TEXT_WHITE  0xFFFF
#define COLOR_TEXT_DIM    0x7BEF

// Sunglasses colors
#define COLOR_SUNGLASSES_FRAME 0x0841  // #111111
#define COLOR_SUNGLASSES_LENS  0x0080  // #001100
#define COLOR_SUNGLASSES_SHINE 0x0180  // #003300

// RGB565 color constants for memory bar gradient (matches Desktop/statusline.py)
#define COLOR_MEM_GREEN  0x0540  // #00AA00
#define COLOR_MEM_YELLOW 0xFE60  // #FFCC00
#define COLOR_MEM_RED    0xFA28  // #FF4444

// =============================================================================
// SECTION 3: Dimension Constants & Visual Enums
// =============================================================================

// Character dimensions (128x128, doubled from 64x64)
#define CHAR_WIDTH  128
#define CHAR_HEIGHT 128
#define SCALE       2    // Scale factor from original design

// Eye types (visual appearance of eyes)
enum EyeType {
  EYE_NORMAL,      // Normal square eyes (default)
  EYE_BLINK,       // Closed eyes (horizontal lines)
  EYE_HAPPY,       // Happy eyes (> <)
  EYE_FOCUSED,     // Sunglasses (Matrix style)
  EYE_GLASSES      // Glasses (frame only, eyes stay visible)
};

// Effect types (visual effects around character)
enum EffectType {
  EFFECT_NONE,        // No effect
  EFFECT_SPARKLE,     // Sparkle effect (start/working state)
  EFFECT_THINKING,    // Thought bubble (thinking/planning state)
  EFFECT_QUESTION,    // Question mark (notification state)
  EFFECT_ZZZ,         // Zzz animation (sleep state)
  EFFECT_EXCLAMATION  // Exclamation mark (alert state)
};

// Animation frame counter (defined in .ino)
extern int animFrame;

// =============================================================================
// SECTION 4: Character Image Draw Functions
// =============================================================================

// Character image data (RGB565 format)
#include "img_clawd.h"
#include "img_kiro.h"
#include "img_claw.h"
#include "img_codex.h"

// Helper: Draw PROGMEM image with transparency to TFT
// Optimized: Uses pushImage instead of pixel-by-pixel drawing (100x faster)
void drawImageToTFT(TFT_eSPI &tft, int offsetX, int offsetY, const uint16_t* img, int width, int height, uint16_t transparentColor) {
  tft.pushImage(offsetX, offsetY, width, height, img, transparentColor);
}

// TFT draw functions for each character
void drawClawdImage(TFT_eSPI &tft, int x, int y) {
  drawImageToTFT(tft, x, y, IMG_CLAWD, IMG_CLAWD_WIDTH, IMG_CLAWD_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawKiroImage(TFT_eSPI &tft, int x, int y) {
  drawImageToTFT(tft, x, y, IMG_KIRO, IMG_KIRO_WIDTH, IMG_KIRO_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawClawImage(TFT_eSPI &tft, int x, int y) {
  drawImageToTFT(tft, x, y, IMG_CLAW, IMG_CLAW_WIDTH, IMG_CLAW_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawCodexImage(TFT_eSPI &tft, int x, int y) {
  drawImageToTFT(tft, x, y, IMG_CODEX, IMG_CODEX_WIDTH, IMG_CODEX_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

// Helper: Draw PROGMEM image with transparency to sprite
// Optimized: Uses pushImage instead of pixel-by-pixel drawing (100x faster)
void drawImageWithTransparency(TFT_eSprite &sprite, const uint16_t* img, int width, int height, uint16_t transparentColor) {
  sprite.pushImage(0, 0, width, height, img, transparentColor);
}

// Sprite draw functions for each character
void drawClawdImageToSprite(TFT_eSprite &sprite) {
  drawImageWithTransparency(sprite, IMG_CLAWD, IMG_CLAWD_WIDTH, IMG_CLAWD_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawKiroImageToSprite(TFT_eSprite &sprite) {
  drawImageWithTransparency(sprite, IMG_KIRO, IMG_KIRO_WIDTH, IMG_KIRO_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawClawImageToSprite(TFT_eSprite &sprite) {
  drawImageWithTransparency(sprite, IMG_CLAW, IMG_CLAW_WIDTH, IMG_CLAW_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

void drawCodexImageToSprite(TFT_eSprite &sprite) {
  drawImageWithTransparency(sprite, IMG_CODEX, IMG_CODEX_WIDTH, IMG_CODEX_HEIGHT, COLOR_TRANSPARENT_MARKER);
}

// =============================================================================
// SECTION 5: CharacterGeometry Struct & Definitions
// =============================================================================

// Character geometry structure
typedef struct {
  const char* name;
  uint16_t color;
  // Eyes
  int eyeLeftX, eyeRightX, eyeY, eyeW, eyeH;
  // Effect position (sparkle, thought bubble, zzz, etc.)
  int effectX, effectY;
  // Character image draw functions (eliminates if/else dispatch chains)
  void (*drawToTFT)(TFT_eSPI&, int, int);
  void (*drawToSprite)(TFT_eSprite&);
} CharacterGeometry;

// Character definitions
const CharacterGeometry CHAR_CLAWD = {
  "clawd",
  COLOR_CLAUDE,
  // Eyes (leftX, rightX, y, w, h)
  14, 44, 22, 6, 6,
  // Effect position (effectX, effectY)
  52, 4,
  // Draw functions
  drawClawdImage, drawClawdImageToSprite
};

const CharacterGeometry CHAR_KIRO = {
  "kiro",
  COLOR_KIRO,
  // Eyes (leftX, rightX, y, w, h) - tall vertical eyes
  30, 39, 21, 5, 8,
  // Effect position (effectX, effectY)
  50, 3,
  // Draw functions
  drawKiroImage, drawKiroImageToSprite
};

const CharacterGeometry CHAR_CLAW = {
  "claw",
  COLOR_CLAW,
  // Eyes (leftX, rightX, y, w, h)
  21, 38, 16, 6, 6,
  // Effect position (effectX, effectY)
  49, 4,
  // Draw functions
  drawClawImage, drawClawImageToSprite
};

const CharacterGeometry CHAR_CODEX = {
  "codex",
  COLOR_CODEX,
  // Eyes (leftX, rightX, y, w, h)
  23, 38, 22, 4, 4,
  // Effect position (effectX, effectY)
  47, 3,
  // Draw functions
  drawCodexImage, drawCodexImageToSprite
};

// Character array for dynamic lookup
// To add a new character, add to this array and define the CharacterGeometry above
const CharacterGeometry* ALL_CHARACTERS[] = {
  &CHAR_CLAWD,
  &CHAR_KIRO,
  &CHAR_CLAW,
  &CHAR_CODEX
};
const int CHARACTER_COUNT = sizeof(ALL_CHARACTERS) / sizeof(ALL_CHARACTERS[0]);
const CharacterGeometry* DEFAULT_CHARACTER = &CHAR_CLAWD;

// Get character geometry by name (const char* version - no String allocation)
const CharacterGeometry* getCharacterByName(const char* name) {
  for (int i = 0; i < CHARACTER_COUNT; i++) {
    if (strcmp(name, ALL_CHARACTERS[i]->name) == 0) {
      return ALL_CHARACTERS[i];
    }
  }
  return DEFAULT_CHARACTER;
}

// Check if character name is valid (const char* version)
bool isValidCharacter(const char* name) {
  for (int i = 0; i < CHARACTER_COUNT; i++) {
    if (strcmp(name, ALL_CHARACTERS[i]->name) == 0) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// SECTION 6: State → Visual Mapping Functions
// =============================================================================

// Get background color for state
uint16_t getBackgroundColorEnum(AppState state) {
  switch (state) {
    case STATE_START: return COLOR_BG_SESSION;
    case STATE_IDLE: return COLOR_BG_IDLE;
    case STATE_THINKING: return COLOR_BG_THINKING;
    case STATE_PLANNING: return COLOR_BG_PLANNING;
    case STATE_WORKING: return COLOR_BG_WORKING;
    case STATE_PACKING: return COLOR_BG_PACKING;
    case STATE_NOTIFICATION: return COLOR_BG_NOTIFY;
    case STATE_DONE: return COLOR_BG_DONE;
    case STATE_SLEEP: return COLOR_BG_SLEEP;
    case STATE_ALERT: return COLOR_BG_ALERT;
    default: return COLOR_BG_IDLE;
  }
}

// Get eye type for state
EyeType getEyeTypeEnum(AppState state) {
  switch (state) {
    case STATE_WORKING: return EYE_GLASSES;
    case STATE_DONE: return EYE_HAPPY;
    case STATE_SLEEP: return EYE_BLINK;
    default: return EYE_NORMAL;
  }
}

// Get effect type for state
EffectType getEffectTypeEnum(AppState state) {
  switch (state) {
    case STATE_START: return EFFECT_SPARKLE;
    case STATE_THINKING: return EFFECT_THINKING;
    case STATE_PLANNING: return EFFECT_THINKING;
    case STATE_PACKING: return EFFECT_THINKING;
    case STATE_WORKING: return EFFECT_SPARKLE;
    case STATE_NOTIFICATION: return EFFECT_QUESTION;
    case STATE_SLEEP: return EFFECT_ZZZ;
    case STATE_ALERT: return EFFECT_EXCLAMATION;
    default: return EFFECT_NONE;
  }
}

// Get text color for state
uint16_t getTextColorEnum(AppState state) {
  switch (state) {
    case STATE_START: return TFT_BLACK;
    case STATE_PACKING: return TFT_BLACK;
    case STATE_NOTIFICATION: return TFT_BLACK;
    default: return COLOR_TEXT_WHITE;
  }
}

// =============================================================================
// SECTION 7: Eye Drawing Helper Functions (template versions)
// =============================================================================

// Get eye cover position (used by sunglasses and sleep eyes)
void getEyeCoverPosition(int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, bool isKiro,
                         int &lensW, int &lensH, int &lensY, int &leftLensX, int &rightLensX) {
  lensW = ew + (4 * SCALE);
  lensH = eh + (2 * SCALE);
  // Kiro: shift up 2px
  lensY = eyeY - SCALE - (isKiro ? (2 * SCALE) : 0);
  // Kiro: left lens 2px right, right lens 5px right
  leftLensX = leftEyeX - (2 * SCALE) + (isKiro ? (2 * SCALE) : 0);
  rightLensX = rightEyeX - (2 * SCALE) + (isKiro ? (5 * SCALE) : 0);
}

// Draw sleep/blink eyes (closed eyes with body color background)
template<typename T>
void drawSleepEyesT(T &canvas, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, uint16_t bodyColor, bool isKiro = false) {
  int lensW, lensH, lensY, leftLensX, rightLensX;
  getEyeCoverPosition(leftEyeX, rightEyeX, eyeY, ew, eh, isKiro, lensW, lensH, lensY, leftLensX, rightLensX);

  // Cover original eyes with body color (same area as sunglasses)
  canvas.fillRect(leftLensX, lensY, lensW, lensH, bodyColor);
  canvas.fillRect(rightLensX, lensY, lensW, lensH, bodyColor);

  // Draw closed eyes (horizontal lines in the middle)
  int closedEyeY = lensY + lensH / 2;
  int closedEyeH = 2 * SCALE;  // 2px thick line (scaled)
  canvas.fillRect(leftLensX + SCALE, closedEyeY, lensW - (2 * SCALE), closedEyeH, COLOR_EYE);
  canvas.fillRect(rightLensX + SCALE, closedEyeY, lensW - (2 * SCALE), closedEyeH, COLOR_EYE);
}

inline void drawSleepEyes(TFT_eSPI &tft, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, uint16_t bodyColor, bool isKiro = false) {
  drawSleepEyesT(tft, leftEyeX, rightEyeX, eyeY, ew, eh, bodyColor, isKiro);
}

// Draw happy eyes (> < style for done state)
template<typename T>
void drawHappyEyesT(T &canvas, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, uint16_t bodyColor, bool isKiro = false) {
  int lensW, lensH, lensY, leftLensX, rightLensX;
  getEyeCoverPosition(leftEyeX, rightEyeX, eyeY, ew, eh, isKiro, lensW, lensH, lensY, leftLensX, rightLensX);

  // Cover original eyes with body color
  canvas.fillRect(leftLensX, lensY, lensW, lensH, bodyColor);
  canvas.fillRect(rightLensX, lensY, lensW, lensH, bodyColor);

  // Center position for drawing > <
  int centerY = lensY + lensH / 2;
  int leftCenterX = leftLensX + lensW / 2;
  int rightCenterX = rightLensX + lensW / 2;

  // Draw > for left eye (pointing right)
  canvas.fillRect(leftCenterX - (2 * SCALE), centerY - (2 * SCALE), 2 * SCALE, 2 * SCALE, COLOR_EYE);
  canvas.fillRect(leftCenterX, centerY, 2 * SCALE, 2 * SCALE, COLOR_EYE);
  canvas.fillRect(leftCenterX - (2 * SCALE), centerY + (2 * SCALE), 2 * SCALE, 2 * SCALE, COLOR_EYE);

  // Draw < for right eye (pointing left)
  canvas.fillRect(rightCenterX + SCALE, centerY - (2 * SCALE), 2 * SCALE, 2 * SCALE, COLOR_EYE);
  canvas.fillRect(rightCenterX - SCALE, centerY, 2 * SCALE, 2 * SCALE, COLOR_EYE);
  canvas.fillRect(rightCenterX + SCALE, centerY + (2 * SCALE), 2 * SCALE, 2 * SCALE, COLOR_EYE);
}

inline void drawHappyEyes(TFT_eSPI &tft, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, uint16_t bodyColor, bool isKiro = false) {
  drawHappyEyesT(tft, leftEyeX, rightEyeX, eyeY, ew, eh, bodyColor, isKiro);
}

// Draw sunglasses (Matrix style)
template<typename T>
void drawSunglassesT(T &canvas, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, bool isKiro = false) {
  int lensW, lensH, lensY, leftLensX, rightLensX;
  getEyeCoverPosition(leftEyeX, rightEyeX, eyeY, ew, eh, isKiro, lensW, lensH, lensY, leftLensX, rightLensX);

  // Left lens (dark green tint)
  canvas.fillRect(leftLensX, lensY, lensW, lensH, COLOR_SUNGLASSES_LENS);
  // Left lens shine
  canvas.fillRect(leftLensX + SCALE, lensY + SCALE, 2 * SCALE, SCALE, COLOR_SUNGLASSES_SHINE);

  // Right lens (dark green tint)
  canvas.fillRect(rightLensX, lensY, lensW, lensH, COLOR_SUNGLASSES_LENS);
  // Right lens shine
  canvas.fillRect(rightLensX + SCALE, lensY + SCALE, 2 * SCALE, SCALE, COLOR_SUNGLASSES_SHINE);

  // Frame - top
  canvas.fillRect(leftLensX - SCALE, lensY - SCALE, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY - SCALE, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);

  // Frame - bottom
  canvas.fillRect(leftLensX - SCALE, lensY + lensH, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY + lensH, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);

  // Frame - sides
  canvas.fillRect(leftLensX - SCALE, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(leftLensX + lensW, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX + lensW, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);

  // Bridge (connects two lenses)
  int bridgeY = lensY + lensH / 2;
  canvas.fillRect(leftLensX + lensW, bridgeY, rightLensX - leftLensX - lensW, SCALE, COLOR_SUNGLASSES_FRAME);
}

inline void drawSunglasses(TFT_eSPI &tft, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, bool isKiro = false) {
  drawSunglassesT(tft, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
}

// Draw glasses (frame only - lenses stay clear so the eyes underneath remain visible)
template<typename T>
void drawGlassesT(T &canvas, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, bool isKiro = false) {
  int lensW, lensH, lensY, leftLensX, rightLensX;
  getEyeCoverPosition(leftEyeX, rightEyeX, eyeY, ew, eh, isKiro, lensW, lensH, lensY, leftLensX, rightLensX);

  // Frame - top
  canvas.fillRect(leftLensX - SCALE, lensY - SCALE, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY - SCALE, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);

  // Frame - bottom
  canvas.fillRect(leftLensX - SCALE, lensY + lensH, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY + lensH, lensW + (2 * SCALE), SCALE, COLOR_SUNGLASSES_FRAME);

  // Frame - sides
  canvas.fillRect(leftLensX - SCALE, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(leftLensX + lensW, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX - SCALE, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);
  canvas.fillRect(rightLensX + lensW, lensY, SCALE, lensH, COLOR_SUNGLASSES_FRAME);

  // Bridge (connects two lenses)
  int bridgeY = lensY + lensH / 2 - (2 * SCALE);
  canvas.fillRect(leftLensX + lensW, bridgeY, rightLensX - leftLensX - lensW, SCALE, COLOR_SUNGLASSES_FRAME);
}

inline void drawGlasses(TFT_eSPI &tft, int leftEyeX, int rightEyeX, int eyeY, int ew, int eh, bool isKiro = false) {
  drawGlassesT(tft, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
}

// =============================================================================
// SECTION 8: Animation Effect Functions (template versions)
// =============================================================================

// Draw sparkle effect (scaled 2x) — 4-point star
template<typename T>
void drawSparkleT(T &canvas, int x, int y, uint16_t sparkleColor = COLOR_TEXT_WHITE) {
  int frame = animFrame % ANIM_SPARKLE_PERIOD;

  // Center dot (2x2 -> 4x4)
  canvas.fillRect(x + (2 * SCALE), y + (2 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);

  // Rays (rotating based on frame)
  if (frame == 0 || frame == 2) {
    // Vertical and horizontal
    canvas.fillRect(x + (2 * SCALE), y, 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x + (2 * SCALE), y + (4 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x, y + (2 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x + (4 * SCALE), y + (2 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);
  } else {
    // Diagonal
    canvas.fillRect(x, y, 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x + (4 * SCALE), y, 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x, y + (4 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);
    canvas.fillRect(x + (4 * SCALE), y + (4 * SCALE), 2 * SCALE, 2 * SCALE, sparkleColor);
  }
}

inline void drawSparkle(TFT_eSPI &tft, int x, int y, uint16_t sparkleColor = COLOR_TEXT_WHITE) {
  drawSparkleT(tft, x, y, sparkleColor);
}

// Draw question mark effect (scaled 2x)
template<typename T>
void drawQuestionMarkT(T &canvas, int x, int y) {
  uint16_t color = TFT_BLACK;  // Dark on yellow background
  canvas.fillRect(x + (1 * SCALE), y, 4 * SCALE, 2 * SCALE, color);              // Top curve
  canvas.fillRect(x + (4 * SCALE), y + (2 * SCALE), 2 * SCALE, 2 * SCALE, color); // Right side
  canvas.fillRect(x + (2 * SCALE), y + (4 * SCALE), 2 * SCALE, 2 * SCALE, color); // Middle
  canvas.fillRect(x + (2 * SCALE), y + (6 * SCALE), 2 * SCALE, 2 * SCALE, color); // Lower middle
  canvas.fillRect(x + (2 * SCALE), y + (10 * SCALE), 2 * SCALE, 2 * SCALE, color); // Dot
}

inline void drawQuestionMark(TFT_eSPI &tft, int x, int y) {
  drawQuestionMarkT(tft, x, y);
}

// Draw Zzz animation for sleep state (scaled 2x)
template<typename T>
void drawZzzT(T &canvas, int x, int y, int frame, uint16_t color = COLOR_TEXT_WHITE) {
  // Blink effect: show Z for half period, hide for half period (2 second cycle)
  if ((frame % ANIM_ZZZ_PERIOD) < (ANIM_ZZZ_PERIOD / 2)) {
    canvas.fillRect(x, y, 6 * SCALE, 1 * SCALE, color);              // Top
    canvas.fillRect(x + (4 * SCALE), y + (1 * SCALE), 2 * SCALE, 1 * SCALE, color); // Upper diagonal 1
    canvas.fillRect(x + (3 * SCALE), y + (2 * SCALE), 2 * SCALE, 1 * SCALE, color); // Upper diagonal 2
    canvas.fillRect(x + (2 * SCALE), y + (3 * SCALE), 2 * SCALE, 1 * SCALE, color); // Lower diagonal 1
    canvas.fillRect(x + (1 * SCALE), y + (4 * SCALE), 2 * SCALE, 1 * SCALE, color); // Lower diagonal 2
    canvas.fillRect(x, y + (5 * SCALE), 6 * SCALE, 1 * SCALE, color); // Bottom
  }
}

inline void drawZzz(TFT_eSPI &tft, int x, int y, int frame, uint16_t color = COLOR_TEXT_WHITE) {
  drawZzzT(tft, x, y, frame, color);
}

// Draw thought bubble animation for thinking state (scaled 2x)
template<typename T>
void drawThoughtBubbleT(T &canvas, int x, int y, int frame, uint16_t color = COLOR_TEXT_WHITE) {
  // Small dots leading to bubble (always visible)
  canvas.fillRect(x, y + (6 * SCALE), 2 * SCALE, 2 * SCALE, color);
  canvas.fillRect(x + (2 * SCALE), y + (3 * SCALE), 2 * SCALE, 2 * SCALE, color);

  // Main bubble (animated size)
  if ((frame % ANIM_THOUGHT_PERIOD) < (ANIM_THOUGHT_PERIOD / 2)) {
    // Larger bubble
    canvas.fillRect(x + (3 * SCALE), y - (2 * SCALE), 6 * SCALE, 2 * SCALE, color);
    canvas.fillRect(x + (2 * SCALE), y, 8 * SCALE, 3 * SCALE, color);
    canvas.fillRect(x + (3 * SCALE), y + (3 * SCALE), 6 * SCALE, 1 * SCALE, color);
  } else {
    // Smaller bubble
    canvas.fillRect(x + (4 * SCALE), y - (1 * SCALE), 4 * SCALE, 2 * SCALE, color);
    canvas.fillRect(x + (3 * SCALE), y + (1 * SCALE), 6 * SCALE, 2 * SCALE, color);
  }
}

inline void drawThoughtBubble(TFT_eSPI &tft, int x, int y, int frame, uint16_t color = COLOR_TEXT_WHITE) {
  drawThoughtBubbleT(tft, x, y, frame, color);
}

// Draw exclamation mark effect (alert state) - template version
template<typename T>
void drawExclamationMarkT(T &canvas, int x, int y, int frame, uint16_t bgColor) {
  int shakeOffset = ((frame / 2) % 4 < 2) ? (2 * SCALE) : (-2 * SCALE);
  int markY = y + shakeOffset;
  uint16_t white = TFT_WHITE;
  uint16_t red = COLOR_BG_ALERT;
  canvas.fillRect(x + 6*SCALE, markY, 4*SCALE, 20*SCALE, white);
  canvas.drawRect(x + 5*SCALE, markY - SCALE, 6*SCALE, 22*SCALE, red);
  canvas.fillRect(x + 6*SCALE, markY + 24*SCALE, 4*SCALE, 4*SCALE, white);
  canvas.drawRect(x + 5*SCALE, markY + 23*SCALE, 6*SCALE, 6*SCALE, red);
}

inline void drawExclamationMark(TFT_eSPI &tft, int x, int y, int frame, uint16_t bgColor) {
  drawExclamationMarkT(tft, x, y, frame, bgColor);
}

// =============================================================================
// SECTION 9: Eye & Effect Dispatch Functions
// =============================================================================

/*
 * Character structure (128x128, scaled 2x from 64x64):
 *
 *         20    88    20
 *        +----+------+----+
 *        |    |██████|    |  16   (top padding)
 *        |    |██████|    |
 *        |    |█ ■■ █|    |  24  (eyes area)
 *   +----+----+██████+----+----+
 *   |████|    |██████|    |████|  24  (arms)
 *   +----+----+██████+----+----+
 *        |    |██████|    |  16
 *        |    +--++--+    |
 *        |      |██|      |  32  (legs)
 *        |      |██|      |
 *        +------+--+------+
 */

// Draw eye type to TFT (normal, blink, happy, focused)
void drawEyeType(TFT_eSPI &tft, int x, int y, EyeType eyeType, const CharacterGeometry* character = &CHAR_CLAWD) {
  int leftEyeX = x + (character->eyeLeftX * SCALE);
  int rightEyeX = x + (character->eyeRightX * SCALE);
  int eyeY = y + (character->eyeY * SCALE);
  int ew = character->eyeW * SCALE;
  int eh = character->eyeH * SCALE;
  bool isKiro = (character == &CHAR_KIRO);

  switch (eyeType) {
    case EYE_FOCUSED:
      drawSunglasses(tft, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
      break;
    case EYE_GLASSES:
      drawGlasses(tft, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
      break;
    case EYE_BLINK:
      drawSleepEyes(tft, leftEyeX, rightEyeX, eyeY, ew, eh, character->color, isKiro);
      break;
    case EYE_HAPPY:
      drawHappyEyes(tft, leftEyeX, rightEyeX, eyeY, ew, eh, character->color, isKiro);
      break;
    case EYE_NORMAL:
    default:
      // Normal eyes - already in character image, no additional drawing needed
      break;
  }
}

// Draw effect type to TFT (sparkle, thinking, alert, zzz)
void drawEffectType(TFT_eSPI &tft, int x, int y, EffectType effectType, uint16_t bgColor, const CharacterGeometry* character = &CHAR_CLAWD) {
  bool isKiro = (character == &CHAR_KIRO);
  uint16_t effectColor = isKiro ? COLOR_EFFECT_ALT : COLOR_TEXT_WHITE;

  int effectX = x + (character->effectX * SCALE);
  int effectY = y + (character->effectY * SCALE);

  switch (effectType) {
    case EFFECT_SPARKLE:
      drawSparkle(tft, effectX, effectY + (2 * SCALE), effectColor);
      break;
    case EFFECT_THINKING:
      drawThoughtBubble(tft, effectX, effectY, animFrame, effectColor);
      break;
    case EFFECT_QUESTION:
      drawQuestionMark(tft, effectX, effectY);
      break;
    case EFFECT_ZZZ:
      drawZzz(tft, effectX, effectY, animFrame, effectColor);
      break;
    case EFFECT_EXCLAMATION:
      drawExclamationMark(tft, effectX, effectY, animFrame, bgColor);
      break;
    case EFFECT_NONE:
    default:
      break;
  }
}

// Draw eye type to sprite (normal, blink, happy, focused)
void drawEyeTypeToSprite(TFT_eSprite &sprite, EyeType eyeType, const CharacterGeometry* character = &CHAR_CLAWD) {
  int leftEyeX = character->eyeLeftX * SCALE;
  int rightEyeX = character->eyeRightX * SCALE;
  int eyeY = character->eyeY * SCALE;
  int ew = character->eyeW * SCALE;
  int eh = character->eyeH * SCALE;
  bool isKiro = (character == &CHAR_KIRO);

  switch (eyeType) {
    case EYE_FOCUSED:
      drawSunglassesT(sprite, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
      break;
    case EYE_GLASSES:
      drawGlassesT(sprite, leftEyeX, rightEyeX, eyeY, ew, eh, isKiro);
      break;
    case EYE_BLINK:
      drawSleepEyesT(sprite, leftEyeX, rightEyeX, eyeY, ew, eh, character->color, isKiro);
      break;
    case EYE_HAPPY:
      drawHappyEyesT(sprite, leftEyeX, rightEyeX, eyeY, ew, eh, character->color, isKiro);
      break;
    case EYE_NORMAL:
    default:
      // Normal eyes - already in character image
      break;
  }
}

// Draw effect type to sprite (sparkle, thinking, alert, zzz, exclamation)
void drawEffectTypeToSprite(TFT_eSprite &sprite, EffectType effectType, uint16_t bgColor = 0, const CharacterGeometry* character = &CHAR_CLAWD) {
  bool isKiro = (character == &CHAR_KIRO);
  uint16_t effectColor = isKiro ? COLOR_EFFECT_ALT : COLOR_TEXT_WHITE;

  int effectX = character->effectX * SCALE;
  int effectY = character->effectY * SCALE;

  switch (effectType) {
    case EFFECT_SPARKLE:
      drawSparkleT(sprite, effectX, effectY + (2 * SCALE), effectColor);
      break;
    case EFFECT_THINKING:
      drawThoughtBubbleT(sprite, effectX, effectY, animFrame, effectColor);
      break;
    case EFFECT_QUESTION:
      drawQuestionMarkT(sprite, effectX, effectY);
      break;
    case EFFECT_ZZZ:
      drawZzzT(sprite, effectX, effectY, animFrame, effectColor);
      break;
    case EFFECT_EXCLAMATION:
      drawExclamationMarkT(sprite, effectX, effectY, animFrame, bgColor);
      break;
    case EFFECT_NONE:
    default:
      break;
  }
}

// =============================================================================
// SECTION 10: Character Composite Draw Functions
// =============================================================================

// Draw character to sprite buffer (128x128) — no flickering
void drawCharacterToSprite(TFT_eSprite &sprite, EyeType eyeType, EffectType effectType, uint16_t bgColor, const CharacterGeometry* character = &CHAR_CLAWD) {
  sprite.fillSprite(bgColor);
  character->drawToSprite(sprite);
  drawEyeTypeToSprite(sprite, eyeType, character);
  drawEffectTypeToSprite(sprite, effectType, bgColor, character);
}

// Draw character directly to TFT at specified position (128x128)
void drawCharacter(TFT_eSPI &tft, int x, int y, EyeType eyeType, EffectType effectType, uint16_t bgColor, const CharacterGeometry* character = &CHAR_CLAWD) {
  tft.fillRect(x, y, CHAR_WIDTH, CHAR_HEIGHT, bgColor);
  character->drawToTFT(tft, x, y);
  drawEyeType(tft, x, y, eyeType, character);
  drawEffectType(tft, x, y, effectType, bgColor, character);
}

// =============================================================================
// SECTION 11: Loading Dots & Memory Bar
// =============================================================================

// Draw loading dots animation (slow = true for thinking state)
void drawLoadingDots(TFT_eSPI &tft, int centerX, int y, int frame, bool slow = false) {
  int dotRadius = 4;
  int dotSpacing = 16;
  // Use integer arithmetic: 1.5 * 16 = 24
  int startX = centerX - 24;
  int adjustedFrame = slow ? (frame / 3) : frame;

  for (int i = 0; i < 4; i++) {
    int dotX = startX + (i * dotSpacing);
    uint16_t color = (i == (adjustedFrame % 4)) ? COLOR_TEXT_WHITE : COLOR_TEXT_DIM;
    tft.fillCircle(dotX, y, dotRadius, color);
  }
}

// Interpolate between two RGB565 colors
uint16_t lerpColor565(uint16_t color1, uint16_t color2, int ratio, int maxRatio) {
  int r1 = (color1 >> 11) & 0x1F;
  int g1 = (color1 >> 5) & 0x3F;
  int b1 = color1 & 0x1F;

  int r2 = (color2 >> 11) & 0x1F;
  int g2 = (color2 >> 5) & 0x3F;
  int b2 = color2 & 0x1F;

  int r = r1 + ((r2 - r1) * ratio) / maxRatio;
  int g = g1 + ((g2 - g1) * ratio) / maxRatio;
  int b = b1 + ((b2 - b1) * ratio) / maxRatio;

  r = min(31, max(0, r));
  g = min(63, max(0, g));
  b = min(31, max(0, b));

  return (r << 11) | (g << 5) | b;
}

// Get gradient color for a specific position in the memory bar
// Thresholds: 0-74% Green, 75-89% Yellow, 90%+ Red (matches statusline.py)
uint16_t getGradientColor(int pos, int width, int percent) {
  uint16_t baseStart, baseEnd;
  int baseRatio;

  if (percent < 75) {
    // Green to Yellow range (0-74%)
    baseStart = COLOR_MEM_GREEN;
    baseEnd = COLOR_MEM_YELLOW;
    baseRatio = (percent * 100) / 75;
  } else if (percent < 90) {
    // Yellow to Orange range (75-89%)
    baseStart = COLOR_MEM_YELLOW;
    baseEnd = COLOR_MEM_RED;
    baseRatio = ((percent - 75) * 100) / 15;
  } else {
    // Orange to Red range (90-100%)
    baseStart = COLOR_MEM_YELLOW;
    baseEnd = COLOR_MEM_RED;
    baseRatio = 50 + ((percent - 90) * 50) / 10;
  }

  // Apply position-based gradient within the bar
  int posRatio = (pos * 30) / width;  // 0-30% variation across bar
  int totalRatio = min(100, max(0, baseRatio + posRatio));

  return lerpColor565(baseStart, baseEnd, totalRatio, 100);
}

// Draw memory bar with gradient
// Optimized: Uses segment-based rendering (8px segments) instead of per-pixel
void drawMemoryBar(TFT_eSPI &tft, int x, int y, int width, int height, int percent, uint16_t bgColor) {
  int clampedPercent = min(100, max(0, percent));
  int fillWidth = (width * clampedPercent) / 100;

  // Determine border/bg colors based on background brightness
  bool isDarkBg = (bgColor == COLOR_BG_WORKING || bgColor == COLOR_BG_SLEEP);
  uint16_t borderColor = isDarkBg ? 0xAD75 : 0x4208;  // Light gray or dark gray
  uint16_t containerBg = isDarkBg ? 0x3186 : 0x2104;  // Lighter or darker

  // Border (1px)
  tft.drawRect(x, y, width, height, borderColor);

  // Background - inside border
  tft.fillRect(x + 1, y + 1, width - 2, height - 2, containerBg);

  // Fill bar with gradient using segments (8px each for ~8x speedup)
  if (fillWidth > 2) {
    int barHeight = height - 2;
    int innerWidth = fillWidth - 2;
    int segmentSize = 8;

    for (int i = 0; i < innerWidth; i += segmentSize) {
      int segWidth = min(segmentSize, innerWidth - i);
      uint16_t color = getGradientColor(i, innerWidth, clampedPercent);
      tft.fillRect(x + 1 + i, y + 1, segWidth, barHeight, color);
    }
  }
}

#endif // SPRITES_H
