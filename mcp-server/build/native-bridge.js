/**
 * Native Bridge - WebSocket server for communication with Native Host
 *
 * Architecture:
 * MCP Server <--WebSocket--> Native Host <--Native Messaging--> Chrome Extension
 */
import { WebSocket } from 'ws';
// State
let socket = null;
let isConnected = false;
let messageIdCounter = 1;
// Pending CDP requests waiting for responses
const pendingCDPRequests = new Map();
// Configuration
const CDP_TIMEOUT = 10000; // 10 seconds
const RECONNECT_INTERVAL = 2000; // 2 seconds between reconnect attempts
const MAX_RECONNECT_ATTEMPTS = Infinity; // Keep trying forever
// Reconnection state
let reconnectTimer = null;
let reconnectAttempts = 0;
let targetPort = 9224;
/**
 * Start WebSocket client and connect to native host
 * Will auto-reconnect if connection fails or drops
 */
export function startNativeBridge(port = 9224) {
    console.error("\n┌─────────────────────────────────────────────────────┐");
    console.error("│  NATIVE BRIDGE - WebSocket Client Initialization   │");
    console.error("└─────────────────────────────────────────────────────┘");
    console.error(`🎯 Target: ws://localhost:${port}`);
    console.error(`🔄 Auto-reconnect: Enabled (every ${RECONNECT_INTERVAL}ms)`);
    targetPort = port;
    return new Promise((resolve) => {
        // Always resolve immediately - connection happens in background
        // This prevents MCP server startup from blocking on native host
        console.error("✅ Native Bridge initialized (connecting in background)");
        scheduleConnect(true);
        resolve();
    });
}
/**
 * Schedule a connection attempt
 */
function scheduleConnect(immediate = false) {
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
        console.error(`\n[NATIVE BRIDGE] 🔌 Connecting to native host at ${url}...`);
    }
    else if (reconnectAttempts % 10 === 0) {
        console.error(`[NATIVE BRIDGE] 🔄 Still trying to connect... (attempt ${reconnectAttempts})`);
    }
    const ws = new WebSocket(url);
    socket = ws;
    ws.on('open', () => {
        console.error('\n┌─────────────────────────────────────────────────────┐');
        console.error('│  ✅ NATIVE BRIDGE CONNECTED                         │');
        console.error('└─────────────────────────────────────────────────────┘');
        console.error(`📡 WebSocket connection established to Native Host`);
        console.error(`🔗 Connection: MCP Server ←→ Native Host`);
        console.error(`⏳ Waiting for Native Host ←→ Chrome Extension link...\n`);
        isConnected = true;
        reconnectAttempts = 0;
    });
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.error(`[NATIVE BRIDGE] ⬅️  Received from Native Host: ${message.type} (id: ${message.id || 'N/A'})`);
            handleNativeMessage(message);
        }
        catch (error) {
            console.error('[NATIVE BRIDGE] ❌ Failed to parse message from native host:', error);
        }
    });
    ws.on('close', () => {
        console.error('\n[NATIVE BRIDGE] ❌ Connection to Native Host closed');
        console.error('[NATIVE BRIDGE] 🔄 Will attempt to reconnect...');
        isConnected = false;
        socket = null;
        // Reject all pending requests
        const pendingCount = pendingCDPRequests.size;
        if (pendingCount > 0) {
            console.error(`[NATIVE BRIDGE] ⚠️  Rejecting ${pendingCount} pending CDP requests`);
        }
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
    ws.on('error', (error) => {
        // ECONNREFUSED is expected when native host isn't running yet
        if (error.code !== 'ECONNREFUSED') {
            console.error('[NATIVE BRIDGE] ⚠️  WebSocket error:', error.message);
        }
        // Socket will emit 'close' after 'error', which triggers reconnect
    });
}
/**
 * Stop the WebSocket client
 */
export function stopNativeBridge() {
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
export function isNativeHostConnected() {
    return socket !== null && socket.readyState === WebSocket.OPEN;
}
/**
 * Force an immediate connection attempt if not connected
 * Returns a promise that resolves when connected or after timeout
 */
export async function ensureConnected(timeoutMs = 5000) {
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
 * Reconnect to native host (for tools that detect disconnection)
 * Useful when extension reconnects after being idle
 */
export async function reconnect(timeoutMs = 5000) {
    console.error('🔄 Attempting to reconnect to native host...');
    // Close existing connection if any
    if (socket) {
        socket.removeAllListeners();
        socket.close();
        socket = null;
    }
    isConnected = false;
    reconnectAttempts = 0;
    // Trigger immediate connection attempt
    scheduleConnect(true);
    // Wait for connection with timeout
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (isNativeHostConnected()) {
            console.error('✅ Reconnected to native host');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.error('❌ Failed to reconnect to native host');
    return isNativeHostConnected();
}
/**
 * Send CDP command to browser via native host
 * Automatically reconnects if needed
 */
export async function sendCDPCommand(method, params = {}) {
    console.error(`\n[CDP] 📤 Sending command: ${method}`);
    console.error(`[CDP] 📋 Params:`, JSON.stringify(params, null, 2));
    // Ensure connection before sending
    if (!isNativeHostConnected()) {
        console.error(`[CDP] ⚠️  Connection lost, attempting to reconnect...`);
        const connected = await reconnect(5000);
        if (!connected) {
            console.error(`[CDP] ❌ Reconnection failed`);
            throw new Error('Native host not connected. Make sure the browser extension is connected.');
        }
        console.error(`[CDP] ✅ Reconnected successfully`);
    }
    const id = messageIdCounter++;
    console.error(`[CDP] 🆔 Request ID: ${id}`);
    return new Promise((resolve, reject) => {
        // Set up timeout
        const timeout = setTimeout(() => {
            pendingCDPRequests.delete(id);
            console.error(`[CDP] ⏱️  TIMEOUT for ${method} (id: ${id}) after ${CDP_TIMEOUT}ms`);
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
            socket.send(JSON.stringify(message));
            console.error(`[CDP] ➡️  Sent to Native Host (id: ${id})`);
            console.error(`[CDP] ⏳ Waiting for response...`);
        }
        catch (error) {
            clearTimeout(timeout);
            pendingCDPRequests.delete(id);
            console.error(`[CDP] ❌ Send failed, attempting reconnect and retry...`);
            // Try to reconnect and retry once
            reconnect(3000).then(() => {
                try {
                    socket.send(JSON.stringify(message));
                    console.error(`[CDP] 🔄 Retried after reconnect (id: ${id})`);
                }
                catch (retryError) {
                    console.error(`[CDP] ❌ Retry failed:`, retryError);
                    reject(new Error(`Failed to send CDP command: ${retryError.message}`));
                }
            }).catch(() => {
                console.error(`[CDP] ❌ Reconnect failed`);
                reject(new Error(`Failed to send CDP command: ${error.message}`));
            });
        }
    });
}
/**
 * Handle messages from native host
 */
function handleNativeMessage(message) {
    // Handle CDP responses
    if (message.type === 'cdp_response') {
        console.error(`[CDP] ⬅️  Response received (id: ${message.id})`);
        const pending = pendingCDPRequests.get(message.id);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingCDPRequests.delete(message.id);
            if (message.error) {
                console.error(`[CDP] ❌ Error in response:`, message.error);
                pending.reject(new Error(message.error.message || 'CDP command failed'));
            }
            else {
                console.error(`[CDP] ✅ Success - returning result to MCP tool handler`);
                pending.resolve(message.result);
            }
        }
        else {
            console.error(`[CDP] ⚠️  Received response for unknown request id: ${message.id}`);
        }
        return;
    }
    // Handle status messages
    if (message.type === 'status') {
        console.error('[NATIVE BRIDGE] 📊 Status update:', message);
        return;
    }
    console.error('[NATIVE BRIDGE] ⚠️  Unknown message type:', message.type);
}
