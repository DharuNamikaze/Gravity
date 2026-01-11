#!/usr/bin/env node

/**
 * DevTools Bridge Native Messaging Host
 * 
 * Bridges Chrome extension (via Native Messaging stdio) to MCP server (via WebSocket)
 * 
 * Architecture:
 * Chrome Extension <--Native Messaging (stdio)--> This Host <--WebSocket--> MCP Server
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Configuration
const MCP_SERVER_URL = 'ws://localhost:9224';
const RECONNECT_DELAY = 1000;
const LOG_FILE = process.platform === 'win32' 
  ? path.join(process.env.TEMP || 'C:\\Temp', 'devtools-bridge-host.log')
  : '/tmp/devtools-bridge-host.log';

// State
let ws = null;
let reconnectTimer = null;
let isShuttingDown = false;

// Debug logging
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${message}\n`);
}

log('Native host starting...');

// ============================================================================
// Native Messaging Protocol (Chrome Extension <-> Native Host)
// Uses length-prefixed JSON messages over stdin/stdout
// ============================================================================

/**
 * Send a message to Chrome extension via stdout
 * Format: [4-byte little-endian length][JSON message]
 */
function sendToExtension(message) {
  try {
    const json = JSON.stringify(message);
    const buffer = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(buffer.length, 0);
    
    process.stdout.write(header);
    process.stdout.write(buffer);
    
    log(`Sent to extension: ${json.substring(0, 200)}...`);
  } catch (error) {
    log(`Error sending to extension: ${error.message}`);
  }
}

/**
 * Read messages from Chrome extension via stdin
 * Native messaging uses length-prefixed JSON
 */
function setupStdinReader() {
  let pendingHeader = null;
  let pendingLength = 0;
  let buffer = Buffer.alloc(0);

  process.stdin.on('readable', () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    }
  });

  function processBuffer() {
    while (true) {
      // Need to read header first
      if (pendingLength === 0) {
        if (buffer.length < 4) return; // Wait for more data
        
        pendingLength = buffer.readUInt32LE(0);
        buffer = buffer.slice(4);
        log(`Reading message of length: ${pendingLength}`);
      }

      // Now read the message body
      if (buffer.length < pendingLength) return; // Wait for more data

      const messageBuffer = buffer.slice(0, pendingLength);
      buffer = buffer.slice(pendingLength);
      pendingLength = 0;

      try {
        const message = JSON.parse(messageBuffer.toString('utf8'));
        log(`Received from extension: ${JSON.stringify(message).substring(0, 200)}...`);
        handleExtensionMessage(message);
      } catch (error) {
        log(`Error parsing message from extension: ${error.message}`);
      }
    }
  }

  process.stdin.on('end', () => {
    log('stdin closed - extension disconnected');
    shutdown();
  });

  process.stdin.on('error', (error) => {
    log(`stdin error: ${error.message}`);
    shutdown();
  });
}


// ============================================================================
// WebSocket Connection (Native Host <-> MCP Server)
// ============================================================================

/**
 * Connect to MCP server via WebSocket
 */
function connectToMCPServer() {
  if (isShuttingDown) return;
  
  log(`Connecting to MCP server at ${MCP_SERVER_URL}...`);
  
  try {
    ws = new WebSocket(MCP_SERVER_URL);
    
    ws.on('open', () => {
      log('Connected to MCP server');
      // Notify extension that we're connected
      sendToExtension({ type: 'status', connected: true });
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        log(`Received from MCP server: ${JSON.stringify(message).substring(0, 200)}...`);
        // Forward CDP requests from MCP server to extension
        sendToExtension(message);
      } catch (error) {
        log(`Error parsing message from MCP server: ${error.message}`);
      }
    });
    
    ws.on('close', () => {
      log('Disconnected from MCP server');
      ws = null;
      // Notify extension
      sendToExtension({ type: 'status', connected: false });
      // Attempt reconnection
      scheduleReconnect();
    });
    
    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
      // Error will be followed by close event
    });
    
  } catch (error) {
    log(`Failed to create WebSocket: ${error.message}`);
    scheduleReconnect();
  }
}

/**
 * Schedule reconnection attempt
 */
function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer) return;
  
  log(`Scheduling reconnection in ${RECONNECT_DELAY}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToMCPServer();
  }, RECONNECT_DELAY);
}

/**
 * Send message to MCP server via WebSocket
 */
function sendToMCPServer(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('Cannot send to MCP server - not connected');
    // Send error back to extension
    if (message.id) {
      sendToExtension({
        type: 'cdp_response',
        id: message.id,
        error: { message: 'MCP server not connected' }
      });
    }
    return;
  }
  
  try {
    const json = JSON.stringify(message);
    ws.send(json);
    log(`Sent to MCP server: ${json.substring(0, 200)}...`);
  } catch (error) {
    log(`Error sending to MCP server: ${error.message}`);
  }
}

// ============================================================================
// Message Routing
// ============================================================================

/**
 * Handle messages from Chrome extension
 * Forward CDP responses to MCP server
 */
function handleExtensionMessage(message) {
  // Forward all messages to MCP server
  // The extension sends CDP responses back through here
  sendToMCPServer(message);
}

// ============================================================================
// Lifecycle
// ============================================================================

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  log('Shutting down...');
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (ws) {
    ws.close();
    ws = null;
  }
  
  log('Native host stopped');
  logStream.end();
  process.exit(0);
}

// Handle process signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============================================================================
// Main
// ============================================================================

// Set up stdin for binary reading
process.stdin.setEncoding(null);

// Start reading from extension
setupStdinReader();

// Connect to MCP server
connectToMCPServer();

log('Native host ready');
