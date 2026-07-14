/**
 * WebSocket client for Vibe Monitor
 * Connects to a central server to receive real-time status updates
 */

const WebSocket = require('ws');
const Store = require('electron-store');
const { WS_URL, WS_TOKEN } = require('../shared/config.cjs');

// Reconnection configuration
const RECONNECT_INITIAL_DELAY = 5000;   // 5 seconds
const RECONNECT_MAX_DELAY = 30000;      // 30 seconds
const RECONNECT_MULTIPLIER = 1.5;

// Heartbeat configuration
const PING_INTERVAL = 30000;            // Ping every 30 seconds

class WsClient {
  constructor() {
    this.ws = null;
    this.url = WS_URL;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY;
    this.reconnectTimer = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.shouldReconnect = true;
    this.pingTimer = null;
    this.pongReceived = true;

    // Persistent storage for token
    this.store = new Store({
      name: 'ws-settings',
      defaults: {
        token: null
      }
    });

    // Load token: stored value > environment variable
    const storedToken = this.store.get('token');
    this.token = storedToken || WS_TOKEN || null;

    // Callbacks
    this.onStatusUpdate = null;  // Called when status message received
    this.onStatusDelete = null;  // Called when {type:'delete'} received with project name
    this.onConnectionChange = null;  // Called when connection state changes
  }

  /**
   * Get current token
   * @returns {string|null}
   */
  getToken() {
    return this.token;
  }

  /**
   * Set token and save to store
   * @param {string|null} token
   */
  setToken(token) {
    this.token = token || null;
    this.store.set('token', this.token);

    // Reconnect with new token (token is passed via URL query parameter)
    if (this.isConnected || this.isConnecting) {
      this.reconnect();
    }
  }

  /**
   * Reconnect to WebSocket server
   */
  reconnect() {
    // Close current connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.isConnected = false;

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reconnect immediately
    this.reconnectDelay = RECONNECT_INITIAL_DELAY;
    this.connect();
  }

  /**
   * Clear token from store
   */
  clearToken() {
    this.token = null;
    this.store.delete('token');
  }

  /**
   * Check if WebSocket is configured
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.url);
  }

  /**
   * Get connection status
   * @returns {string} 'connected', 'connecting', 'disconnected', or 'not-configured'
   */
  getStatus() {
    if (!this.isConfigured()) {
      return 'not-configured';
    }
    if (this.isConnected) {
      return 'connected';
    }
    if (this.isConnecting) {
      return 'connecting';
    }
    return 'disconnected';
  }

  /**
   * Build connection URL with token as query parameter (like ESP32)
   * @returns {string}
   */
  buildConnectionUrl() {
    if (!this.token) {
      return this.url;
    }

    // Add token as query parameter (same as ESP32: /?token=xxx)
    const separator = this.url.includes('?') ? '&' : '?';
    return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
  }

  /**
   * Start WebSocket connection
   */
  connect() {
    if (!this.isConfigured()) {
      console.log('WebSocket not configured (VIBEMON_WS_URL not set)');
      return;
    }

    if (this.isConnecting || this.isConnected) {
      return;
    }

    this.isConnecting = true;
    this.notifyConnectionChange();

    const connectionUrl = this.buildConnectionUrl();
    console.log(`WebSocket connecting to ${this.url}...`);

    try {
      this.ws = new WebSocket(connectionUrl);

      this.ws.on('open', () => {
        console.log('WebSocket connected');
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectDelay = RECONNECT_INITIAL_DELAY;
        this.sendAuth();
        this.startHeartbeat();
        this.notifyConnectionChange();
      });

      this.ws.on('pong', () => {
        this.pongReceived = true;
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        this.handleDisconnect();
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        // Error will be followed by close event
      });
    } catch (error) {
      console.error('WebSocket connection error:', error.message);
      this.handleDisconnect();
    }
  }

  /**
   * Send authentication message
   */
  sendAuth() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.token) {
      return;
    }

    const authMessage = JSON.stringify({
      type: 'auth',
      token: this.token
    });

    this.ws.send(authMessage);
    console.log('WebSocket auth sent');
  }

  /**
   * Handle incoming message
   * @param {Buffer|string} data
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      // Handle error messages from server
      if (message.type === 'error') {
        console.error('WebSocket server error:', message.message);
        return;
      }

      // Handle auth success
      if (message.type === 'authenticated') {
        console.log('WebSocket authenticated, userId:', message.userId);
        return;
      }

      // Handle status update (server sends {type: "status", data: {...}})
      if (message.type === 'status' && message.data) {
        if (this.onStatusUpdate) {
          this.onStatusUpdate(message.data);
        }
        return;
      }

      // Handle project deletion (server sends {type: "delete", data: {project}})
      // Emitted by DELETE /api/status?project=X on the server side.
      if (message.type === 'delete' && message.data && typeof message.data.project === 'string') {
        if (this.onStatusDelete) {
          this.onStatusDelete(message.data.project);
        }
        return;
      }

      // Handle status update (direct format: {state: "..."})
      if (message.state) {
        if (this.onStatusUpdate) {
          this.onStatusUpdate(message);
        }
      }
    } catch (error) {
      console.error('WebSocket message parse error:', error.message);
    }
  }

  /**
   * Start heartbeat ping to detect stale connections
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.pongReceived = true;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (!this.pongReceived) {
        // Server didn't respond to last ping - connection is stale
        console.log('WebSocket heartbeat timeout, reconnecting...');
        this.ws.terminate();
        return;
      }

      this.pongReceived = false;
      this.ws.ping();
    }, PING_INTERVAL);
  }

  /**
   * Stop heartbeat ping
   */
  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Handle disconnection and schedule reconnect
   */
  handleDisconnect() {
    this.isConnecting = false;
    this.isConnected = false;
    this.ws = null;
    this.stopHeartbeat();
    this.notifyConnectionChange();

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    console.log(`WebSocket reconnecting in ${this.reconnectDelay / 1000}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Increase delay for next attempt (exponential backoff)
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_MULTIPLIER,
      RECONNECT_MAX_DELAY
    );
  }

  /**
   * Notify connection state change
   */
  notifyConnectionChange() {
    if (this.onConnectionChange) {
      this.onConnectionChange(this.getStatus());
    }
  }

  /**
   * Disconnect and stop reconnection
   */
  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnecting = false;
    this.isConnected = false;
    this.notifyConnectionChange();
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.disconnect();
  }
}

module.exports = { WsClient };
