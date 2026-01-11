/**
 * Native Bridge - WebSocket server for communication with Native Host
 *
 * Architecture:
 * MCP Server <--WebSocket--> Native Host <--Native Messaging--> Chrome Extension
 */
import { WebSocketServer, WebSocket } from 'ws';
// State
let wss = null;
let nativeConnection = null;
let messageIdCounter = 1;
// Pending CDP requests waiting for responses
const pendingCDPRequests = new Map();
// Configuration
const CDP_TIMEOUT = 10000; // 10 seconds
/**
 * Start WebSocket server that native host connects to
 */
export function startNativeBridge(port = 9224) {
    return new Promise((resolve, reject) => {
        if (wss) {
            console.error('Native bridge already started');
            resolve();
            return;
        }
        try {
            wss = new WebSocketServer({ port }, () => {
                console.error(`📡 Native bridge WebSocket server listening on ws://localhost:${port}`);
                resolve();
            });
            wss.on('connection', (ws) => {
                console.error('✅ Native host connected');
                // Only allow one connection at a time
                if (nativeConnection) {
                    console.error('Closing existing native host connection');
                    nativeConnection.close();
                }
                nativeConnection = ws;
                ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        handleNativeMessage(message);
                    }
                    catch (error) {
                        console.error('Failed to parse message from native host:', error);
                    }
                });
                ws.on('close', () => {
                    console.error('❌ Native host disconnected');
                    if (nativeConnection === ws) {
                        nativeConnection = null;
                    }
                    // Reject all pending requests
                    for (const [id, pending] of pendingCDPRequests) {
                        clearTimeout(pending.timeout);
                        pending.reject(new Error('Native host disconnected'));
                        pendingCDPRequests.delete(id);
                    }
                });
                ws.on('error', (error) => {
                    console.error('Native host WebSocket error:', error);
                });
            });
            wss.on('error', (error) => {
                console.error('❌ WebSocket server error:', error);
                if (error.code === 'EADDRINUSE') {
                    console.error(`Port ${port} is already in use. Trying to reuse existing server...`);
                    // Try to recover by waiting a bit and retrying
                    setTimeout(() => {
                        if (!wss) {
                            startNativeBridge(port).then(resolve).catch(reject);
                        }
                    }, 1000);
                }
            });
        }
        catch (error) {
            console.error('Failed to create WebSocket server:', error);
            reject(error);
        }
    });
}
/**
 * Stop the WebSocket server
 */
export function stopNativeBridge() {
    if (nativeConnection) {
        nativeConnection.close();
        nativeConnection = null;
    }
    if (wss) {
        wss.close();
        wss = null;
    }
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
    return nativeConnection !== null && nativeConnection.readyState === WebSocket.OPEN;
}
/**
 * Send CDP command to browser via native host
 */
export async function sendCDPCommand(method, params = {}) {
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
            nativeConnection.send(JSON.stringify(message));
            console.error(`Sent CDP command: ${method} (id: ${id})`);
        }
        catch (error) {
            clearTimeout(timeout);
            pendingCDPRequests.delete(id);
            reject(new Error(`Failed to send CDP command: ${error.message}`));
        }
    });
}
/**
 * Handle messages from native host
 */
function handleNativeMessage(message) {
    // Handle CDP responses
    if (message.type === 'cdp_response') {
        const pending = pendingCDPRequests.get(message.id);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingCDPRequests.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message || 'CDP command failed'));
            }
            else {
                pending.resolve(message.result);
            }
        }
        else {
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
