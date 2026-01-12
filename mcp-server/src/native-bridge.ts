/**
 * Native Bridge - WebSocket server for communication with Native Host
 * 
 * Architecture:
 * MCP Server <--WebSocket--> Native Host <--Native Messaging--> Chrome Extension
 */

import { WebSocketServer, WebSocket } from 'ws';

// State
let socket: WebSocket | null = null;
let isConnected = false;
let messageIdCounter = 1;

// Pending CDP requests waiting for responses
const pendingCDPRequests = new Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Configuration
const CDP_TIMEOUT = 10000; // 10 seconds
const RECONNECT_INTERVAL = 2000; // 2 seconds between reconnect attempts
const MAX_RECONNECT_ATTEMPTS = Infinity; // Keep trying forever

// Reconnection state
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let targetPort = 9224;

/**
 * Start WebSocket client and connect to native host
 * Will auto-reconnect if connection fails or drops
 */
export function startNativeBridge(port: number = 9224): Promise<void> {
  targetPort = port;
  
  return new Promise((resolve) => {
    // Always resolve immediately - connection happens in background
    // This prevents MCP server startup from blocking on native host
    scheduleConnect(true);
    resolve();
  });
}

/**
 * Schedule a connection attempt
 */
function scheduleConnect(immediate: boolean = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  const delay = immediate ? 0 : RECONNECT_INTERVAL;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    attemptConnect();
  }, delay);
}

/**
 * Attempt to connect to native host
 */
function attemptConnect() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return; // Already connected
  }
  
  // Clean up any existing socket
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  
  const url = `ws://localhost:${targetPort}`;
  reconnectAttempts++;
  
  if (reconnectAttempts === 1) {
    console.error(`🔌 Connecting to native host at ${url}...`);
  } else if (reconnectAttempts % 10 === 0) {
    console.error(`🔌 Still trying to connect to native host... (attempt ${reconnectAttempts})`);
  }

  const ws = new WebSocket(url);
  socket = ws;

  ws.on('open', () => {
    console.error('✅ Connected to native host');
    isConnected = true;
    reconnectAttempts = 0;
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      handleNativeMessage(message);
    } catch (error) {
      console.error('Failed to parse message from native host:', error);
    }
  });

  ws.on('close', () => {
    console.error('❌ Native host connection closed');
    isConnected = false;
    socket = null;

    // Reject all pending requests
    for (const [id, pending] of pendingCDPRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Native host disconnected'));
      pendingCDPRequests.delete(id);
    }
    pendingCDPRequests.clear();

    // Auto-reconnect
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleConnect();
    }
  });

  ws.on('error', (error: any) => {
    // ECONNREFUSED is expected when native host isn't running yet
    if (error.code !== 'ECONNREFUSED') {
      console.error('Native host WebSocket error:', error.message);
    }
    
    // Socket will emit 'close' after 'error', which triggers reconnect
  });
}

/**
 * Stop the WebSocket client
 */
export function stopNativeBridge(): void {
  // Stop reconnection attempts
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  isConnected = false;

  // Clear pending requests
  for (const [id, pending] of pendingCDPRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Native bridge stopped'));
  }
  pendingCDPRequests.clear();
}

/**
 * Check if native host is connected
 */
export function isNativeHostConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/**
 * Force an immediate connection attempt if not connected
 * Returns a promise that resolves when connected or after timeout
 */
export async function ensureConnected(timeoutMs: number = 5000): Promise<boolean> {
  // Already connected
  if (isNativeHostConnected()) {
    return true;
  }
  
  // Trigger immediate connection attempt
  scheduleConnect(true);
  
  // Wait for connection with timeout
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (isNativeHostConnected()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return isNativeHostConnected();
}

/**
 * Send CDP command to browser via native host
 */
export async function sendCDPCommand(method: string, params: any = {}): Promise<any> {
  if (!isNativeHostConnected()) {
    throw new Error('Native host not connected. Make sure the browser extension is connected.');
  }

  const id = messageIdCounter++;

  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeout = setTimeout(() => {
      pendingCDPRequests.delete(id);
      reject(new Error(`CDP command ${method} timed out after ${CDP_TIMEOUT}ms`));
    }, CDP_TIMEOUT);

    // Store pending request
    pendingCDPRequests.set(id, { resolve, reject, timeout });

    // Send request to native host
    const message = {
      type: 'cdp_request',
      id,
      method,
      params
    };

    try {
      socket!.send(JSON.stringify(message));
      console.error(`Sent CDP command: ${method} (id: ${id})`);
    } catch (error) {
      clearTimeout(timeout);
      pendingCDPRequests.delete(id);
      reject(new Error(`Failed to send CDP command: ${(error as Error).message}`));
    }
  });
}

/**
 * Handle messages from native host
 */
function handleNativeMessage(message: any): void {
  // Handle CDP responses
  if (message.type === 'cdp_response') {
    const pending = pendingCDPRequests.get(message.id);

    if (pending) {
      clearTimeout(pending.timeout);
      pendingCDPRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || 'CDP command failed'));
      } else {
        pending.resolve(message.result);
      }
    } else {
      console.error(`Received response for unknown request id: ${message.id}`);
    }
    return;
  }

  // Handle status messages
  if (message.type === 'status') {
    console.error('Native host status:', message);
    return;
  }

  console.error('Unknown message type from native host:', message.type);
}
