# ESP32 WiFi & WebSocket Setup

VibeMon ESP32 devices support automatic WiFi and WebSocket token configuration through a captive portal web interface. No need to hardcode credentials in the firmware!

## Quick Start

### Arduino IDE Setup

Install Arduino IDE 2.x, then install the ESP32 board package and required libraries before opening `esp32/esp32.ino`.

1. **Install ESP32 board support**
   - Open **Arduino IDE → Settings** (or **Preferences**).
   - Add this URL to **Additional boards manager URLs**:
     ```text
     https://espressif.github.io/arduino-esp32/package_esp32_index.json
     ```
   - Open **Tools → Board → Boards Manager...**.
   - Search `esp32` and install **esp32 by Espressif Systems**.

2. **Install required libraries**
   - Open **Tools → Manage Libraries...**.
   - Install these libraries:
     - `ArduinoJson` by Benoit Blanchon
     - `WebSockets` by Markus Sattler
     - `LovyanGFX` by lovyan03

3. **Select the ESP32-C6 board and upload settings**
   - Open `esp32/esp32.ino` in Arduino IDE.
   - Select **Tools → Board → ESP32 Arduino → ESP32C6 Dev Module**.
   - Select the serial port from **Tools → Port**.
   - Set **Tools → Partition Scheme → Huge APP (3MB No OTA/1MB SPIFFS)**.
   - Keep the other board options at their defaults unless your board vendor documents different values.

> The firmware exceeds the default app partition size. VibeMon uses neither OTA nor a filesystem, so the Huge APP partition scheme is the recommended Arduino IDE setting.

### First-Time Setup (Recommended)

1. **Flash Firmware**
```bash
cp credentials.h.example credentials.h
# Edit credentials.h: uncomment BOARD_TYPE for your board (BOARD_1_47 or BOARD_1_9)
# Flash to ESP32 (WiFi and WebSocket enabled by default)
```

> **Arduino IDE:** Complete the setup above before uploading.

2. **Connect to Setup Network**
- SSID: `VibeMon-Setup`
- Password: `vibemon123`

3. **Configure via Web Interface**
- Captive portal opens automatically (or go to `http://192.168.4.1`)
- Scan and select your WiFi network
- Enter WiFi password
- (Optional) Enter VibeMon WebSocket token
- Click "Save & Connect"

4. **Done!**
- Device reboots and connects to your WiFi
- Settings persist across reboots

## How It Works

### Provisioning Mode

When the device has no saved WiFi credentials, it automatically enters **Provisioning Mode**:

```
┌─────────────────────────────────────────┐
│  No WiFi credentials detected           │
│         ↓                               │
│  Create Access Point                    │
│  - SSID: VibeMon-Setup                  │
│  - Password: vibemon123                 │
│  - IP: 192.168.4.1                      │
│         ↓                               │
│  DNS Server (Captive Portal)            │
│         ↓                               │
│  User connects & configures             │
│         ↓                               │
│  Save to NVS Flash → Reboot             │
│         ↓                               │
│  Connect to configured WiFi             │
└─────────────────────────────────────────┘
```

### Web Configuration Interface

**Features:**
- 📡 WiFi network scanning with signal strength
- 🔒 Security indicator for protected networks
- 🎨 Responsive design (works on phones & computers)
- 🔑 Optional WebSocket token configuration
- ✅ Form validation and error handling

**Fields:**
1. **WiFi Network** - Dropdown list of scanned networks
2. **Password** - WiFi password (required)
3. **VibeMon Token** - WebSocket token (optional)

### Data Storage

Credentials are stored in ESP32's **NVS (Non-Volatile Storage)**:

| Key | Type | Description |
|-----|------|-------------|
| `wifiSSID` | String | WiFi network name |
| `wifiPassword` | String | WiFi password |
| `wsToken` | String | WebSocket authentication token |

**Persistence:**
- ✅ Survives reboots
- ✅ Survives power cycles
- ✅ Survives firmware updates (if not doing full erase)

## Setup Options

### Option 1: Provisioning Mode (Recommended)

**Best for:** New devices, easy setup, changing WiFi networks

```bash
# 1. Copy credentials template
cp credentials.h.example credentials.h

# 2. Set BOARD_TYPE (uncomment BOARD_1_47 or BOARD_1_9)

# 3. Flash firmware (USE_WIFI and USE_WEBSOCKET enabled by default)

# 4. Power on device → Automatically enters provisioning mode

# 5. Connect to VibeMon-Setup and configure via web
```

### Option 2: Hardcoded Credentials

**Best for:** Production deployments, known WiFi networks

```cpp
// credentials.h
#define USE_WIFI
#define USE_WEBSOCKET

#define WIFI_SSID "MyNetwork"
#define WIFI_PASSWORD "MyPassword"
#define WS_TOKEN "vbm-secret-token"  // Optional

#define BOARD_TYPE BOARD_1_47  // or BOARD_1_9
```

These are used as **defaults** if no saved credentials exist.

## LCD Display States

### Provisioning Mode
```
┌────────────────────────┐
│  Setup Mode            │
│  SSID: VibeMon-Setup   │
│  Password: vibemon123  │
│  IP: 192.168.4.1       │
│                        │
│  [Character]           │
└────────────────────────┘
```

### Normal Mode
```
┌────────────────────────┐
│  WiFi: OK              │
│  IP: 192.168.1.42      │
│                        │
│  [Character]           │
│  Status: working       │
└────────────────────────┘
```

## WiFi Management

### Reset WiFi Settings

Clear saved credentials and return to provisioning mode:

```bash
curl -X POST http://DEVICE_IP/wifi-reset \
  -H "Content-Type: application/json" \
  -d '{"confirm":true}'
```

Device will:
1. Clear `wifiSSID`, `wifiPassword` from NVS (WebSocket token is preserved)
2. Reboot automatically
3. Enter provisioning mode

### Check Connection

```bash
curl http://DEVICE_IP/health
# Returns: {"status":"ok"}
```

## WebSocket Token Configuration

### What is the WebSocket Token?

The token is used for **authentication** when connecting to VibeMon WebSocket servers:
- Added to WebSocket URL: `wss://ws.vibemon.io/?token=YOUR_TOKEN`
- Sent in auth message: `{"type":"auth","token":"YOUR_TOKEN"}`

### Setting the Token

**Via Provisioning Interface:**
1. Enter token in "VibeMon Token (Optional)" field
2. Leave empty if not needed
3. Token saved to NVS flash

**Via credentials.h:**
```cpp
#define WS_TOKEN "your_access_token"
```

**Priority:** Saved token in NVS > WS_TOKEN define

## Troubleshooting

### Captive Portal Doesn't Open

**Solutions:**
1. Manually navigate to `http://192.168.4.1`
2. Disable mobile data on your phone
3. Try a different device (iOS/Android/laptop)

### WiFi Connection Fails

**What happens:**
1. Device attempts to connect with provided credentials
2. If connection fails after 3 rounds of 20 attempts (60 total)
3. Device enters provisioning mode directly (saved credentials are preserved for retry)

**Check:**
- Correct WiFi password
- WiFi network uses 2.4GHz (ESP32 doesn't support 5GHz)
- Router is powered on and in range

### No Networks in Scan

**Solutions:**
1. Click "🔍 Scan Networks" again
2. Move device closer to WiFi router
3. Ensure WiFi router is broadcasting SSID

### Device Won't Enter Provisioning Mode

**Solutions:**
1. Ensure `USE_WIFI` is defined in `credentials.h`
2. Use `/wifi-reset` endpoint to clear credentials
3. Power cycle the device
4. Manually erase NVS:
```bash
esptool.py --port /dev/ttyUSB0 erase_region 0x9000 0x6000
```

## Technical Details

### API Endpoints

**Provisioning Mode:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/*` | GET | Configuration page (HTML) |
| `/scan` | GET | WiFi networks list (JSON) |
| `/save` | POST | Save WiFi + token, reboot |

**Normal Mode:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | POST | Update device status |
| `/status` | GET | Get current status |
| `/health` | GET | Health check |
| `/lock` | POST | Lock to a specific project |
| `/unlock` | POST | Unlock project |
| `/lock-mode` | GET | Get current lock mode |
| `/lock-mode` | POST | Set lock mode |
| `/reboot` | POST | Reboot device |
| `/wifi-reset` | POST | Clear credentials, restart provisioning |

See [API Reference](api.md) for full request/response details.

### Signal Strength Indicators

| Indicator | RSSI Range | Quality |
|-----------|------------|---------|
| ▰▰▰▰ | > -50 dBm | Excellent |
| ▰▰▰▱ | -50 to -60 dBm | Good |
| ▰▰▱▱ | -60 to -70 dBm | Fair |
| ▰▱▱▱ | < -70 dBm | Weak |

### Code Flow

```cpp
void setup() {
  // Load WiFi credentials from NVS (fallback to credentials.h defines)
  loadWiFiCredentials();

  if (strlen(wifiSSID) == 0) {
    // No credentials → Start provisioning
    startProvisioningMode();
  } else {
    // Try to connect (3 rounds × 20 attempts)
    WiFi.begin(wifiSSID, wifiPassword);

    if (connection fails after all retries) {
      // Enter provisioning mode directly
      // Saved credentials are preserved for retry
      startProvisioningMode();
    }
  }
}

void setupWebSocket() {
  // Load token from NVS (or use WS_TOKEN define as fallback)
  loadWebSocketToken();

  // Add token to WebSocket URL
  snprintf(wsPath, "/?token=%s", wsToken);

  // Connect to WebSocket server
  webSocket.beginSSL(WS_HOST, WS_PORT, wsPath);
}
```

### Security Considerations

**Security Measures:**
- ✅ SSID values escaped to prevent JSON injection
- ✅ Input validation on server side
- ✅ Provisioning only active during setup (temporary)

**Security Limitations:**
- ⚠️ Default AP password (`vibemon123`) is known - configure quickly!
- ⚠️ Configuration page uses HTTP (local only, acceptable for captive portal)
- ⚠️ Credentials stored in NVS without encryption (ESP32 supports NVS encryption but not enabled by default)
- ⚠️ WiFi password visible during provisioning

**Recommendations:**
1. Connect to provisioning AP quickly to minimize exposure
2. Use strong WiFi password with WPA2/WPA3
3. Use strong WebSocket tokens
4. Consider enabling NVS encryption for production

## Alert Light (Optional)

Connect a physical alert light (e.g., warning beacon) to an available GPIO pin. The light turns ON when the device enters `alert` state and OFF when the state changes.

### Wiring

```
ESP32 GPIO pin ──── Alert light (+)
ESP32 GND      ──── Alert light (-)
```

> **Note:** ESP32-C6 GPIO output is 3.3V, max ~40mA. Ensure your light operates within these limits. For higher voltage lights (5V/12V/24V), use a relay module.

### Configuration

Add to `credentials.h`:

```cpp
#define ALERT_PIN 2
```

Any unused GPIO pin can be used. Recommended: **GPIO2** (safe for both boards).

> **⚠️ Pin conflicts by board:**
>
> | Board | LCD pins in use (do NOT use for ALERT_PIN) |
> |-------|---------------------------------------------|
> | 1.47" | 6 (MOSI), 7 (SCK), 14 (CS), 15 (DC), 21 (RST), 22 (BL) |
> | 1.9"  | 4 (MOSI), 5 (SCK), 6 (DC), 7 (CS), 14 (RST), 15 (BL) |
>
> GPIO4 is safe on the 1.47" board but conflicts with 1.9" MOSI — do not use it if supporting both boards.

If `ALERT_PIN` is not defined, the feature is disabled and no extra code is compiled.

## Supported Hardware

Two ESP32-C6 LCD boards are supported. Set `BOARD_TYPE` in `credentials.h` to match your hardware:

```cpp
#define BOARD_TYPE BOARD_1_47   // ESP32-C6-LCD-1.47 (default)
#define BOARD_TYPE BOARD_1_9    // ESP32-C6-LCD-1.9
```

| Board | LCD | Resolution | Backlight | SPI Freq | SPI Pins (MOSI/SCK/DC/CS/RST) |
|-------|-----|------------|-----------|----------|-------------------------------|
| ESP32-C6-LCD-1.47 | ST7789V2 | 172×320 | GPIO22 PWM | 40MHz | 6/7/15/14/21 |
| ESP32-C6-LCD-1.9  | ST7789V2 | 170×320 | GPIO15 direct (active-low) | 20MHz | 4/5/6/7/14 |

### 1.9" Board Notes

- Backlight uses **GPIO15 direct GPIO** (active-low: LOW=on, HIGH=off). In sleep state, backlight turns completely off.
- SPI frequency: 20MHz (matching Waveshare demo; 1.47" board uses 40MHz).
- Touch (CST816) and IMU (QMI8658) sensors are present on the board but not used by VibeMon firmware.

## Advanced Configuration

### Disable WiFi/WebSocket

To disable features, edit `credentials.h`:

```cpp
// Disable WiFi
// #define USE_WIFI

// Disable WebSocket (WiFi still works)
// #define USE_WEBSOCKET
```

### Custom Access Point Settings

To change the provisioning AP name/password, edit `state.h`:

```cpp
const char* AP_SSID = "MyCustomSSID";
const char* AP_PASSWORD = "MyCustomPassword";
```

### Multiple Devices

Each device can be configured independently:
1. Flash same firmware to multiple devices
2. Each enters provisioning mode on first boot
3. Configure each with same or different WiFi/tokens
4. All work independently

## Performance

**Expected Timing:**
- Boot to provisioning mode: < 5 seconds
- WiFi scan: 3-8 seconds
- Credential save + reboot: < 3 seconds
- Connect to WiFi: 5-15 seconds
- **Total setup time: < 30 seconds**

## Related Documentation

- [Main README](../README.md) - Project overview
- [API Reference](api.md) - Complete HTTP API documentation
- [Features](features.md) - Device features and states
