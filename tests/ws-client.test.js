/**
 * Tests for ws-client.cjs
 */

const { EventEmitter } = require('events');

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sentMessages = [];
  }

  send(data) {
    this.sentMessages.push(data);
  }

  ping() {
    // Mock ping - emit pong to simulate server response
    this.emit('pong');
  }

  terminate() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', 1006, 'Terminated');
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', 1000, 'Normal closure');
  }

  // Simulate connection open
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  // Simulate message received
  simulateMessage(data) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }

  // Simulate error
  simulateError(error) {
    this.emit('error', error);
  }

  // Simulate close
  simulateClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', code, reason);
  }
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

// Store original env and module
let mockWsInstance;

// Mock ws module with static constants
const MockWebSocketConstructor = jest.fn().mockImplementation((url) => {
  mockWsInstance = new MockWebSocket(url);
  return mockWsInstance;
});
MockWebSocketConstructor.CONNECTING = 0;
MockWebSocketConstructor.OPEN = 1;
MockWebSocketConstructor.CLOSING = 2;
MockWebSocketConstructor.CLOSED = 3;

jest.mock('ws', () => MockWebSocketConstructor);

// Mock config module
jest.mock('../src/shared/config.cjs', () => ({
  WS_URL: null,
  WS_TOKEN: null
}));

describe('WsClient', () => {
  let WsClient;
  let configModule;
  let activeClients = [];

  beforeEach(() => {
    jest.resetModules();
    mockWsInstance = null;
    activeClients = [];

    // Get fresh references
    configModule = require('../src/shared/config.cjs');
    const wsClientModule = require('../src/modules/ws-client.cjs');
    WsClient = wsClientModule.WsClient;
  });

  afterEach(() => {
    // Cleanup all active clients to prevent timer leaks
    activeClients.forEach(client => {
      client.shouldReconnect = false;
      client.cleanup();
    });
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  // Helper to track clients for cleanup
  function createClient() {
    const client = new WsClient();
    activeClients.push(client);
    return client;
  }

  describe('isConfigured', () => {
    test('returns false when WS_URL is not set', () => {
      configModule.WS_URL = null;
      const client = createClient();
      expect(client.isConfigured()).toBe(false);
    });

    test('returns true when WS_URL is set', () => {
      configModule.WS_URL = 'wss://example.com/ws';
      const client = createClient();
      client.url = 'wss://example.com/ws';
      expect(client.isConfigured()).toBe(true);
    });
  });

  describe('getStatus', () => {
    test('returns not-configured when URL is not set', () => {
      const client = createClient();
      client.url = null;
      expect(client.getStatus()).toBe('not-configured');
    });

    test('returns disconnected when not connected', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.isConnected = false;
      client.isConnecting = false;
      expect(client.getStatus()).toBe('disconnected');
    });

    test('returns connecting when connecting', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.isConnecting = true;
      expect(client.getStatus()).toBe('connecting');
    });

    test('returns connected when connected', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.isConnected = true;
      expect(client.getStatus()).toBe('connected');
    });
  });

  describe('connect', () => {
    test('does not connect when not configured', () => {
      const client = createClient();
      client.url = null;
      client.connect();
      expect(mockWsInstance).toBeNull();
    });

    test('does not connect when already connecting', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.isConnecting = true;
      client.connect();
      expect(mockWsInstance).toBeNull();
    });

    test('does not connect when already connected', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.isConnected = true;
      client.connect();
      expect(mockWsInstance).toBeNull();
    });

    test('creates WebSocket connection when configured', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.connect();
      expect(mockWsInstance).not.toBeNull();
      expect(client.isConnecting).toBe(true);
    });

    test('calls onConnectionChange when connecting', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const callback = jest.fn();
      client.onConnectionChange = callback;
      client.connect();
      expect(callback).toHaveBeenCalledWith('connecting');
    });
  });

  describe('connection events', () => {
    test('handles open event', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const callback = jest.fn();
      client.onConnectionChange = callback;

      client.connect();
      mockWsInstance.simulateOpen();

      expect(client.isConnected).toBe(true);
      expect(client.isConnecting).toBe(false);
      expect(callback).toHaveBeenCalledWith('connected');
    });

    test('sends auth message on open when token is configured', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.token = 'test-token';

      client.connect();
      mockWsInstance.simulateOpen();

      expect(mockWsInstance.sentMessages.length).toBe(1);
      const authMsg = JSON.parse(mockWsInstance.sentMessages[0]);
      expect(authMsg.type).toBe('auth');
      expect(authMsg.token).toBe('test-token');
    });

    test('does not send auth when token is not configured', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      client.token = null;

      client.connect();
      mockWsInstance.simulateOpen();

      expect(mockWsInstance.sentMessages.length).toBe(0);
    });

    test('handles close event', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const callback = jest.fn();
      client.onConnectionChange = callback;

      client.connect();
      mockWsInstance.simulateOpen();
      callback.mockClear();

      mockWsInstance.simulateClose(1000, 'Normal');

      expect(client.isConnected).toBe(false);
      expect(callback).toHaveBeenCalledWith('disconnected');
    });

    test('handles error event', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      client.connect();
      mockWsInstance.simulateError(new Error('Connection refused'));

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('message handling', () => {
    test('calls onStatusUpdate for status messages', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const callback = jest.fn();
      client.onStatusUpdate = callback;

      client.connect();
      mockWsInstance.simulateOpen();

      const statusData = {
        state: 'working',
        project: 'test-project',
        tool: 'Bash'
      };
      mockWsInstance.simulateMessage(statusData);

      expect(callback).toHaveBeenCalledWith(statusData);
    });

    test('handles auth success message', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      client.connect();
      mockWsInstance.simulateOpen();
      // Server responds with 'authenticated' type (not 'auth')
      mockWsInstance.simulateMessage({ type: 'authenticated', userId: 'test-user' });

      expect(consoleSpy).toHaveBeenCalledWith('WebSocket authenticated, userId:', 'test-user');
      consoleSpy.mockRestore();
    });

    test('handles error message from server', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage({ type: 'error', message: 'Auth failed' });

      expect(consoleSpy).toHaveBeenCalledWith('WebSocket server error:', 'Auth failed');
      consoleSpy.mockRestore();
    });

    test('handles invalid JSON gracefully', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      client.connect();
      mockWsInstance.simulateOpen();

      // Simulate raw invalid message
      mockWsInstance.emit('message', Buffer.from('invalid json'));

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('reconnection', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('schedules reconnect after disconnect', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';

      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateClose();

      expect(client.reconnectTimer).not.toBeNull();
    });

    test('reconnects after delay', () => {
      const WebSocket = require('ws');
      const client = createClient();
      client.url = 'wss://example.com/ws';

      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateClose();

      WebSocket.mockClear();
      jest.advanceTimersByTime(5000);

      expect(WebSocket).toHaveBeenCalled();
    });

    test('does not reconnect when shouldReconnect is false', () => {
      const WebSocket = require('ws');
      const client = createClient();
      client.url = 'wss://example.com/ws';

      client.connect();
      mockWsInstance.simulateOpen();
      client.shouldReconnect = false;
      mockWsInstance.simulateClose();

      WebSocket.mockClear();
      jest.advanceTimersByTime(5000);

      expect(WebSocket).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    test('closes WebSocket and clears reconnect timer', () => {
      jest.useFakeTimers();
      const client = createClient();
      client.url = 'wss://example.com/ws';

      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateClose();

      client.disconnect();

      expect(client.shouldReconnect).toBe(false);
      expect(client.reconnectTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  describe('cleanup', () => {
    test('calls disconnect', () => {
      const client = createClient();
      client.url = 'wss://example.com/ws';
      const disconnectSpy = jest.spyOn(client, 'disconnect');

      client.cleanup();

      expect(disconnectSpy).toHaveBeenCalled();
    });
  });
});
