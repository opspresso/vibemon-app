/*
 * VibeMon Input Processing
 * JSON parsing, command handling, and status data processing
 */

#ifndef INPUT_H
#define INPUT_H

// =============================================================================
// Status JSON Builder
// =============================================================================

// Build status JSON into buffer (shared by Serial command handler and HTTP handler)
void buildStatusJson(char* buf, size_t size) {
  if (strlen(lockedProject) > 0) {
    snprintf(buf, size,
      "{\"state\":\"%s\",\"project\":\"%s\",\"lockedProject\":\"%s\",\"lockMode\":\"%s\",\"projectCount\":%d}",
      getStateString(currentState), currentProject, lockedProject, getLockModeString(), projectCount);
  } else {
    snprintf(buf, size,
      "{\"state\":\"%s\",\"project\":\"%s\",\"lockedProject\":null,\"lockMode\":\"%s\",\"projectCount\":%d}",
      getStateString(currentState), currentProject, getLockModeString(), projectCount);
  }
}

// =============================================================================
// Command Handler
// =============================================================================

// Handle command-type input (lock/unlock/reboot/status/lock-mode)
// Returns true if the command was handled
bool handleCommand(const char* command, JsonObject doc) {
  if (strcmp(command, "lock") == 0) {
    const char* projectToLock = doc["project"] | currentProject;
    if (strlen(projectToLock) > 0) {
      lockProject(projectToLock);
    } else {
      Serial.println("{\"error\":\"No project to lock\"}");
    }
    return true;
  }
  if (strcmp(command, "unlock") == 0) {
    unlockProject();
    return true;
  }
  if (strcmp(command, "reboot") == 0) {
    Serial.println("{\"success\":true,\"rebooting\":true}");
    delay(100);  // Allow serial output to complete
    ESP.restart();
    return true;
  }
  if (strcmp(command, "status") == 0) {
    char buf[256];
    buildStatusJson(buf, sizeof(buf));
    Serial.println(buf);
    return true;
  }
  if (strcmp(command, "lock-mode") == 0) {
    const char* modeStr = doc["mode"] | "";
    if (strlen(modeStr) > 0) {
      int newMode = parseLockMode(modeStr);
      if (newMode >= 0) {
        setLockMode(newMode);
      } else {
        Serial.println("{\"error\":\"Invalid mode. Valid modes: first-project, on-thinking\"}");
      }
    } else {
      Serial.print("{\"mode\":\"");
      Serial.print(getLockModeString());
      Serial.println("\"}");
    }
    return true;
  }
  return false;
}

// =============================================================================
// Status Data Processing
// =============================================================================

// Forward declaration
bool processStatusData(JsonObject doc);

// Handle WebSocket message-type input (authenticated/error/status)
// Returns true if the message was handled
bool handleWebSocketMessage(const char* msgType, JsonObject doc) {
  if (strcmp(msgType, "authenticated") == 0) {
    Serial.println("{\"websocket\":\"authenticated\"}");
    return true;
  }
  if (strcmp(msgType, "error") == 0) {
    const char* errMsg = doc["message"] | "unknown";
    Serial.print("{\"websocket\":\"error\",\"message\":\"");
    Serial.print(errMsg);
    Serial.println("\"}");
    return true;
  }
  if (strcmp(msgType, "status") == 0 && doc.containsKey("data")) {
    JsonObject data = doc["data"];
    if (data.isNull()) {
      Serial.println("{\"error\":\"Invalid status data\"}");
      return true;
    }
    (void)processStatusData(data);  // Return value intentionally ignored (WebSocket has no response channel)
    return true;
  }
  // Server emits {type:'delete', data:{project}} when DELETE /api/status removes
  // a project. Keep the local project list, current display, and lock state
  // consistent with the server. Do NOT treat this as user activity (no state
  // transition) so a sleeping device is not woken up by a server-side cleanup.
  if (strcmp(msgType, "delete") == 0 && doc.containsKey("data")) {
    JsonObject data = doc["data"];
    const char* deletedProject = data["project"] | "";
    if (strlen(deletedProject) == 0) {
      return true;
    }
    removeProjectFromList(deletedProject);
    if (strcmp(currentProject, deletedProject) == 0) {
      currentProject[0] = '\0';
      currentTool[0] = '\0';
      currentModel[0] = '\0';
      currentMemory = 0;
      dirtyInfo = true;
      dirtyStatus = true;
      needsRedraw = true;
    }
    if (strcmp(lockedProject, deletedProject) == 0) {
      lockedProject[0] = '\0';
    }
    return true;
  }
  return false;
}

// =============================================================================
// Main Input Processing
// =============================================================================

bool processInput(const char* input) {
  StaticJsonDocument<JSON_BUFFER_SIZE> doc;
  DeserializationError error = deserializeJson(doc, input);

  if (error) {
    Serial.println("{\"error\":\"JSON parse error\"}");
    return false;
  }

  JsonObject obj = doc.as<JsonObject>();

  // Handle command (lock/unlock/reboot/status/lock-mode)
  const char* command = doc["command"] | "";
  if (strlen(command) > 0 && handleCommand(command, obj)) return true;

  // Handle WebSocket message types (server sends {type: "status", data: {...}})
  const char* msgType = doc["type"] | "";
  if (strlen(msgType) > 0 && handleWebSocketMessage(msgType, obj)) return true;

  // Direct format: {state: "...", project: "...", ...}
  return processStatusData(obj);
}

bool processStatusData(JsonObject doc) {
  // Get incoming project
  const char* incomingProject = doc["project"] | "";

  // Add incoming project to list
  if (strlen(incomingProject) > 0) {
    addProjectToList(incomingProject);
  }

  // Auto-lock based on lockMode
  if (lockMode == LOCK_MODE_FIRST_PROJECT) {
    // First project gets locked automatically
    if (strlen(incomingProject) > 0 && projectCount == 1 && strlen(lockedProject) == 0) {
      safeCopyStr(lockedProject, incomingProject);
    }
  } else if (lockMode == LOCK_MODE_ON_THINKING) {
    // Lock on thinking state
    const char* stateStr = doc["state"] | "";
    if (strcmp(stateStr, "thinking") == 0 && strlen(incomingProject) > 0) {
      safeCopyStr(lockedProject, incomingProject);
    }
  }

  // Check if update should be blocked due to project lock
  if (isLockedToDifferentProject(incomingProject)) {
    // Silently ignore update from different project
    Serial.println("{\"success\":false,\"blocked\":true}");
    return false;
  }

  previousState = currentState;

  // Track if info fields changed (for redraw when state is same)
  // IMPORTANT: Must be declared BEFORE processing any fields
  bool infoChanged = false;

  // Parse state
  const char* stateStr = doc["state"] | "";
  if (strlen(stateStr) > 0) {
    AppState newState = parseState(stateStr);
    // Clear tool when state changes (tool is only relevant for working state)
    if (newState != currentState) {
      currentTool[0] = '\0';
    }
    currentState = newState;
  }

  // Parse project - check for change and clear dependent fields
  const char* newProject = doc["project"] | "";
  if (strlen(newProject) > 0 && strcmp(newProject, currentProject) != 0) {
    // Project changed - clear model/memory and trigger redraw
    currentModel[0] = '\0';
    currentMemory = 0;
    currentTool[0] = '\0';
    infoChanged = true;
    safeCopyStr(currentProject, newProject);
  }

  // Parse tool
  const char* toolStr = doc["tool"] | "";
  if (strlen(toolStr) > 0 && strcmp(toolStr, currentTool) != 0) {
    safeCopyStr(currentTool, toolStr);
    infoChanged = true;
    // Tool change affects status text in working state
    if (currentState == STATE_WORKING) {
      dirtyStatus = true;
    }
  }

  // Parse model
  const char* modelStr = doc["model"] | "";
  if (strlen(modelStr) > 0 && strcmp(modelStr, currentModel) != 0) {
    safeCopyStr(currentModel, modelStr);
    infoChanged = true;
  }

  // Parse memory (number 0-100, clamped to valid range)
  int memoryVal = doc["memory"] | -1;
  if (memoryVal >= 0 && memoryVal <= 100 && memoryVal != currentMemory) {
    currentMemory = memoryVal;
    infoChanged = true;
  }

  // Parse plan usage (5-hour + weekly, 0-100). Account-global: NOT cleared on
  // project change, so usage persists across projects.
  int usage5hVal = doc["usage5h"] | -1;
  if (usage5hVal >= 0 && usage5hVal <= 100 && usage5hVal != currentUsage5h) {
    currentUsage5h = usage5hVal;
    infoChanged = true;
  }

  int usageWeekVal = doc["usageWeek"] | -1;
  if (usageWeekVal >= 0 && usageWeekVal <= 100 && usageWeekVal != currentUsageWeek) {
    currentUsageWeek = usageWeekVal;
    infoChanged = true;
  }

  // Parse character (use isValidCharacter() for dynamic validation)
  const char* charInput = doc["character"] | "";
  if (strlen(charInput) > 0 && isValidCharacter(charInput) && strcmp(charInput, currentCharacter) != 0) {
    safeCopyStr(currentCharacter, charInput);
    infoChanged = true;
  }

  // Reset activity timer on any input
  lastActivityTime = millis();

  // Set dirty flags for rendering (actual drawStatus() is called in loop())
  if (currentState != previousState) {
    needsRedraw = true;
    dirtyCharacter = true;
    dirtyStatus = true;
    dirtyInfo = true;
  } else if (infoChanged) {
    // Same state but info changed - only redraw info section
    dirtyInfo = true;
  }
  return true;
}

#endif // INPUT_H
