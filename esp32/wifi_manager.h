/*
 * VibeMon WiFi
 * WiFi connection, HTTP server, WebSocket client, and provisioning
 */

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#ifdef USE_WIFI

// =============================================================================
// WiFi Credentials
// =============================================================================

// Load WiFi credentials from Preferences
void loadWiFiCredentials() {
  preferences.begin("vibemon", true);  // Read-only
  preferences.getString("wifiSSID", wifiSSID, sizeof(wifiSSID));
  preferences.getString("wifiPassword", wifiPassword, sizeof(wifiPassword));
  preferences.end();

  // If no saved credentials, try using default from credentials.h
  if (strlen(wifiSSID) == 0 && strlen(defaultSSID) > 0) {
    safeCopyStr(wifiSSID, defaultSSID);
    safeCopyStr(wifiPassword, defaultPassword);
  }
}

// Save WiFi credentials to Preferences
void saveWiFiCredentials(const char* ssid, const char* password) {
  preferences.begin("vibemon", false);  // Read-write
  preferences.putString("wifiSSID", ssid);
  preferences.putString("wifiPassword", password);
  preferences.end();

  safeCopyStr(wifiSSID, ssid);
  safeCopyStr(wifiPassword, password);
}

#ifdef USE_WEBSOCKET
// Load WebSocket token from Preferences
void loadWebSocketToken() {
  preferences.begin("vibemon", true);  // Read-only
  preferences.getString("wsToken", wsToken, sizeof(wsToken));
  preferences.end();

  // If no saved token, try using default from credentials.h
  if (strlen(wsToken) == 0 && strlen(defaultWSToken) > 0) {
    safeCopyStr(wsToken, defaultWSToken);
  }
}

// Save WebSocket token to Preferences
void saveWebSocketToken(const char* token) {
  if (strlen(token) >= sizeof(wsToken)) {
    Serial.println("{\"error\":\"Token too long (max 127 chars)\"}");
    return;
  }
  preferences.begin("vibemon", false);  // Read-write
  preferences.putString("wsToken", token);
  preferences.end();

  safeCopyStr(wsToken, token);
}
#endif

// =============================================================================
// Provisioning Mode
// =============================================================================

// Forward declaration
void setupProvisioningServer();

// Start Access Point for WiFi provisioning
void startProvisioningMode() {
  provisioningMode = true;

  // Display setup information starting from Y=230 for better visibility
  int setupY = 230;
  tft.setCursor(10, setupY);
  tft.setTextColor(COLOR_TEXT_DIM);
  tft.setTextSize(1);
  tft.println("Setup Mode");

  // Start Access Point
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  tft.setCursor(10, setupY + 18);
  tft.print("SSID: ");
  tft.println(AP_SSID);
  tft.setCursor(10, setupY + 36);
  tft.print("Password: ");
  tft.println(AP_PASSWORD);
  tft.setCursor(10, setupY + 54);
  tft.print("IP: ");
  tft.println(WiFi.softAPIP());

  // Start DNS server for captive portal
  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  // Setup web server for configuration
  setupProvisioningServer();

  char provMsg[80];
  snprintf(provMsg, sizeof(provMsg), "{\"wifi\":\"provisioning_mode\",\"ssid\":\"%s\"}", AP_SSID);
  Serial.println(provMsg);
}

// Setup web server endpoints for provisioning
void setupProvisioningServer() {
  // Captive portal - serve config page for all requests (from flash, no heap copy)
  server.onNotFound([]() {
    server.send(200, "text/html", CONFIG_PAGE);
  });

  // WiFi scan endpoint
  server.on("/scan", HTTP_GET, []() {
    int n = WiFi.scanNetworks();
    String json;
    json.reserve(20 + n * 80);  // Pre-allocate: ~80 chars per network entry
    json = "{\"networks\":[";
    for (int i = 0; i < n; i++) {
      if (i > 0) json += ",";
      // Escape SSID for JSON safety
      String ssid = WiFi.SSID(i);
      // Remove control characters (0x00-0x1F) that break JSON
      for (int j = ssid.length() - 1; j >= 0; j--) {
        if (ssid[j] < 0x20) ssid.remove(j, 1);
      }
      ssid.replace("\\", "\\\\");  // Escape backslashes first
      ssid.replace("\"", "\\\"");  // Escape quotes
      char entry[96];
      snprintf(entry, sizeof(entry), "{\"ssid\":\"%s\",\"rssi\":%d,\"secure\":%s}",
        ssid.c_str(), WiFi.RSSI(i),
        WiFi.encryptionType(i) != WIFI_AUTH_OPEN ? "true" : "false");
      json += entry;
    }
    json += "]}";
    server.send(200, "application/json", json);
  });

  // Save credentials endpoint
  server.on("/save", HTTP_POST, []() {
    if (server.hasArg("ssid") && server.hasArg("password")) {
      String ssid = server.arg("ssid");
      String password = server.arg("password");

      // Validate input lengths before saving
      if (ssid.length() == 0 || ssid.length() > 32) {
        server.send(400, "application/json", "{\"success\":false,\"message\":\"SSID must be 1-32 characters\"}");
        return;
      }
      if (password.length() > 63) {
        server.send(400, "application/json", "{\"success\":false,\"message\":\"Password max 63 characters\"}");
        return;
      }

      saveWiFiCredentials(ssid.c_str(), password.c_str());

#ifdef USE_WEBSOCKET
      // Also save WebSocket token if provided
      if (server.hasArg("token")) {
        String token = server.arg("token");
        if (token.length() > 127) {
          server.send(400, "application/json", "{\"success\":false,\"message\":\"Token max 127 characters\"}");
          return;
        }
        saveWebSocketToken(token.c_str());
      }
#endif

      server.send(200, "application/json", "{\"success\":true,\"message\":\"Credentials saved. Rebooting...\"}");

      delay(1000);
      ESP.restart();
    } else {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing SSID or password\"}");
    }
  });

  server.begin();
}

// =============================================================================
// HTTP Handlers
// =============================================================================

void handleStatus() {
  if (server.hasArg("plain")) {
    // Use const reference to avoid String copy (heap allocation)
    const String& body = server.arg("plain");
    bool applied = processInput(body.c_str());
    if (applied) {
      server.send(200, "application/json", "{\"success\":true}");
    } else {
      server.send(200, "application/json", "{\"success\":false,\"blocked\":true}");
    }
  } else {
    server.send(400, "application/json", "{\"error\":\"no body\"}");
  }
}

void handleStatusGet() {
  char response[256];
  buildStatusJson(response, sizeof(response));
  server.send(200, "application/json", response);
}

void handleHealth() {
  server.send(200, "application/json", "{\"status\":\"ok\"}");
}

void handleLock() {
  char response[128];
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    // Use const reference to avoid String copy
    const String& body = server.arg("plain");
    DeserializationError error = deserializeJson(doc, body);
    if (!error) {
      const char* projectToLock = doc["project"] | currentProject;
      if (strlen(projectToLock) > 0) {
        lockProject(projectToLock);
        snprintf(response, sizeof(response), "{\"success\":true,\"lockedProject\":\"%s\"}", lockedProject);
        server.send(200, "application/json", response);
        return;
      }
    }
  }
  // No body or no project - lock current project
  if (strlen(currentProject) > 0) {
    lockProject(currentProject);
    snprintf(response, sizeof(response), "{\"success\":true,\"lockedProject\":\"%s\"}", lockedProject);
    server.send(200, "application/json", response);
  } else {
    server.send(400, "application/json", "{\"error\":\"No project to lock\"}");
  }
}

void handleUnlock() {
  unlockProject();
  server.send(200, "application/json", "{\"success\":true,\"lockedProject\":null}");
}

void handleLockModeGet() {
  char response[256];
  if (strlen(lockedProject) > 0) {
    snprintf(response, sizeof(response),
      "{\"mode\":\"%s\",\"modes\":{\"first-project\":\"First Project\",\"on-thinking\":\"On Thinking\"},\"lockedProject\":\"%s\"}",
      getLockModeString(), lockedProject);
  } else {
    snprintf(response, sizeof(response),
      "{\"mode\":\"%s\",\"modes\":{\"first-project\":\"First Project\",\"on-thinking\":\"On Thinking\"},\"lockedProject\":null}",
      getLockModeString());
  }
  server.send(200, "application/json", response);
}

void handleLockModePost() {
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    // Use const reference to avoid String copy
    const String& body = server.arg("plain");
    DeserializationError error = deserializeJson(doc, body);
    if (!error) {
      const char* modeStr = doc["mode"] | "";
      if (strlen(modeStr) > 0) {
        int newMode = parseLockMode(modeStr);
        if (newMode >= 0) {
          setLockMode(newMode);
          char response[64];
          snprintf(response, sizeof(response), "{\"success\":true,\"mode\":\"%s\",\"lockedProject\":null}", getLockModeString());
          server.send(200, "application/json", response);
          return;
        }
      }
    }
  }
  server.send(400, "application/json", "{\"error\":\"Invalid mode. Valid modes: first-project, on-thinking\"}");
}

void handleReboot() {
  // Require {"confirm":true} in request body to prevent accidental/unauthorized reboots
  if (server.hasArg("plain")) {
    StaticJsonDocument<64> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc["confirm"] == true) {
      server.send(200, "application/json", "{\"success\":true,\"rebooting\":true}");
      delay(100);  // Allow HTTP response to complete
      ESP.restart();
      return;
    }
  }
  server.send(400, "application/json", "{\"error\":\"Requires {\\\"confirm\\\":true}\"}");
}

// =============================================================================
// WiFi Setup & Connection
// =============================================================================

// Forward declaration for WebSocket
#ifdef USE_WEBSOCKET
void setupWebSocket();
#endif

void setupWiFi() {
  // Load saved WiFi credentials
  loadWiFiCredentials();

  // Check if we have credentials
  if (strlen(wifiSSID) == 0) {
    // No credentials - start provisioning mode
    startProvisioningMode();
    return;
  }

  // Try to connect to WiFi with retry rounds
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  // Display WiFi status at Y=230 for better visibility
  int wifiY = 230;
  tft.setCursor(10, wifiY);
  tft.setTextColor(COLOR_TEXT_DIM);
  tft.setTextSize(1);
  tft.print("WiFi: ");

  for (int retry = 0; retry < WIFI_CONNECT_RETRIES; retry++) {
    if (retry > 0) {
      tft.print("R");
      tft.print(retry + 1);
      WiFi.disconnect();
      delay(1000);
    }
    WiFi.begin(wifiSSID, wifiPassword);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < WIFI_CONNECT_ATTEMPTS) {
      delay(WIFI_CONNECT_DELAY_MS);
      yield();  // Prevent WDT timeout during long connection wait
      tft.print(".");
      attempts++;
    }
    if (WiFi.status() == WL_CONNECTED) break;
  }

  if (WiFi.status() == WL_CONNECTED) {
    tft.println("OK");
    tft.setCursor(10, wifiY + 18);
    tft.print("IP: ");
    tft.println(WiFi.localIP());
    wifiWasConnected = true;

    // Enable WiFi modem sleep (WIFI_PS_MIN_MODEM) to reduce radio power and heat.
    // Heartbeat timeout relaxed to 10s (from 3s) to accommodate modem sleep latency.
    WiFi.setSleep(true);

    // HTTP server setup
    server.on("/status", HTTP_POST, handleStatus);
    server.on("/status", HTTP_GET, handleStatusGet);
    server.on("/health", HTTP_GET, handleHealth);
    server.on("/lock", HTTP_POST, handleLock);
    server.on("/unlock", HTTP_POST, handleUnlock);
    server.on("/lock-mode", HTTP_GET, handleLockModeGet);
    server.on("/lock-mode", HTTP_POST, handleLockModePost);
    server.on("/reboot", HTTP_POST, handleReboot);

    // WiFi reset endpoint - requires {"confirm":true} to prevent accidental resets
    server.on("/wifi-reset", HTTP_POST, []() {
      if (server.hasArg("plain")) {
        StaticJsonDocument<64> doc;
        deserializeJson(doc, server.arg("plain"));
        if (doc["confirm"] == true) {
          preferences.begin("vibemon", false);
          preferences.remove("wifiSSID");
          preferences.remove("wifiPassword");
          preferences.end();
          server.send(200, "application/json", "{\"success\":true,\"message\":\"WiFi credentials cleared. Rebooting...\"}");
          delay(1000);
          ESP.restart();
          return;
        }
      }
      server.send(400, "application/json", "{\"error\":\"Requires {\\\"confirm\\\":true}\"}");
    });

    server.begin();
  } else {
    tft.println("Failed");

    // Connection failed after all retries - enter provisioning mode
    // Keep saved credentials so user can retry without re-entering them
    tft.setCursor(10, wifiY + 18);
    tft.println("Starting setup...");
    delay(WIFI_FAIL_RESTART_MS);

    startProvisioningMode();
    return;
  }
}

// Monitor WiFi connection and recover if dropped
void checkWiFiConnection() {
  unsigned long now = millis();
  if (now - lastWifiCheck < WIFI_CHECK_INTERVAL) return;
  lastWifiCheck = now;

  bool currentlyConnected = (WiFi.status() == WL_CONNECTED);

  if (!currentlyConnected && wifiWasConnected) {
    // WiFi just dropped
    wifiWasConnected = false;
    drawConnectionIndicator();
    Serial.print("{\"wifi\":\"disconnected\",\"heap\":");
    Serial.print(ESP.getFreeHeap());
    Serial.println("}");
  } else if (currentlyConnected && !wifiWasConnected) {
    // WiFi recovered
    wifiWasConnected = true;
    drawConnectionIndicator();
    Serial.print("{\"wifi\":\"reconnected\",\"ip\":\"");
    Serial.print(WiFi.localIP());
    Serial.print("\",\"heap\":");
    Serial.print(ESP.getFreeHeap());
    Serial.println("}");
#ifdef USE_WEBSOCKET
    // Reset backoff and restart WebSocket after WiFi recovery
    wsReconnectDelay = WS_RECONNECT_INITIAL;
    wsDisconnectedSince = 0;
    webSocket.disconnect();
    setupWebSocket();
#endif
  }

#ifdef USE_WEBSOCKET
  // WebSocket health check: if WiFi is up but WS has been disconnected too long,
  // force reinitialize (handles cases where library reconnect silently fails).
  if (currentlyConnected && !wsConnected && wsDisconnectedSince > 0) {
    if (now - wsDisconnectedSince >= WS_REINIT_TIMEOUT) {
      unsigned long disconnectedMs = now - wsDisconnectedSince;
      wsReconnectDelay = WS_RECONNECT_INITIAL;
      wsDisconnectedSince = now;  // Reset timer to avoid repeated rapid reinit
      Serial.print("{\"websocket\":\"force_reinit\",\"disconnectedMs\":");
      Serial.print(disconnectedMs);
      Serial.print(",\"heap\":");
      Serial.print(ESP.getFreeHeap());
      Serial.println("}");
      webSocket.disconnect();
      setupWebSocket();
    }
  }
#endif
}

// =============================================================================
// WebSocket (conditional)
// =============================================================================

#ifdef USE_WEBSOCKET

// Forward declaration
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);

void setupWebSocket() {
  // Load token from preferences if not already loaded
  if (strlen(wsToken) == 0) {
    loadWebSocketToken();
  }

  // Build path with token query parameter for API Gateway authentication.
  // API Gateway authorizes at $connect route using URL query params,
  // so the token MUST be in the URL for the connection to be accepted.
  // The auth message sent after connection is for application-level auth.
  char wsPath[256];
  if (strlen(wsToken) > 0) {
    snprintf(wsPath, sizeof(wsPath), "%s?token=%s", WS_PATH, wsToken);
  } else {
    safeCopyStr(wsPath, WS_PATH);
  }

#if WS_USE_SSL
  webSocket.beginSSL(WS_HOST, WS_PORT, wsPath);
#else
  webSocket.begin(WS_HOST, WS_PORT, wsPath);
#endif

  // Set event handler
  webSocket.onEvent(webSocketEvent);

  // Set initial reconnect interval (adjusted by exponential backoff)
  webSocket.setReconnectInterval(wsReconnectDelay);

  // Enable heartbeat to detect stale connections
  // Ping every 30s, timeout after 10s, disconnect after 2 missed pongs
  webSocket.enableHeartbeat(WS_HEARTBEAT_INTERVAL, WS_HEARTBEAT_TIMEOUT, WS_HEARTBEAT_FAILURES);

  Serial.print("{\"websocket\":\"connecting\",\"heap\":");
  Serial.print(ESP.getFreeHeap());
  Serial.println("}");
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      wsConnected = false;
      if (wsDisconnectedSince == 0) wsDisconnectedSince = millis();
      if (wsConsecutiveFailures < 255) wsConsecutiveFailures++;
      drawConnectionIndicator();
      // Exponential backoff: increase delay for next reconnection.
      // After WS_MAX_FAILURES consecutive disconnects (likely persistent error
      // such as bad token), slow down to 5-minute intervals to avoid wasting bandwidth.
      if (wsConsecutiveFailures >= WS_MAX_FAILURES) {
        wsReconnectDelay = WS_RECONNECT_BACKOFF;
      } else {
        unsigned long newDelay = (unsigned long)(wsReconnectDelay * WS_RECONNECT_MULTIPLIER);
        wsReconnectDelay = (newDelay > WS_RECONNECT_MAX) ? WS_RECONNECT_MAX : newDelay;
      }
      webSocket.setReconnectInterval(wsReconnectDelay);
      Serial.print("{\"websocket\":\"disconnected\",\"failures\":");
      Serial.print(wsConsecutiveFailures);
      Serial.print(",\"nextRetry\":");
      Serial.print(wsReconnectDelay);
      Serial.print(",\"heap\":");
      Serial.print(ESP.getFreeHeap());
      Serial.println("}");
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      wsDisconnectedSince = 0;  // Clear disconnect timestamp
      wsConsecutiveFailures = 0;  // Reset failure counter on successful connection
      drawConnectionIndicator();
      // Reset backoff on successful connection
      wsReconnectDelay = WS_RECONNECT_INITIAL;
      webSocket.setReconnectInterval(wsReconnectDelay);
      Serial.print("{\"websocket\":\"connected\",\"url\":\"");
      Serial.print((char*)payload);
      Serial.print("\",\"heap\":");
      Serial.print(ESP.getFreeHeap());
      Serial.println("}");

      // Send authentication message if token is configured
      if (strlen(wsToken) > 0) {
        char authMsg[128];
        snprintf(authMsg, sizeof(authMsg), "{\"type\":\"auth\",\"token\":\"%s\"}", wsToken);
        webSocket.sendTXT(authMsg);
        Serial.println("{\"websocket\":\"auth_sent\"}");
      }
      break;

    case WStype_TEXT:
      // Process received message (same as Serial/HTTP input)
      processInput((char*)payload, length);
      break;

    case WStype_ERROR:
      Serial.print("{\"websocket\":\"error\",\"heap\":");
      Serial.print(ESP.getFreeHeap());
      Serial.println("}");
      break;

    default:
      break;
  }
}

#endif // USE_WEBSOCKET
#endif // USE_WIFI
#endif // WIFI_MANAGER_H
