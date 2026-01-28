#!/usr/bin/env node

/**
 * Gravity Native Messaging Host
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
  ? path.join(process.env.TEMP || 'C:\\Temp', 'gravity-host.log')
  : '/tmp/gravity-host.log';

// State
let ws = null;
let reconnectTimer = null;
let isShuttingDown = false;

// Debug logging
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  try {
    logStream.write(`[${timestamp}] ${message}\n`);
  } catch (e) {
    // Ignore log errors
  }
}

// Global error handlers to prevent silent exits
process.on('uncaughtException', (error) => {
  const msg = `CRITICAL: Uncaught Exception: ${error.message}\n${error.stack}`;
  log(msg);
  console.error(msg); // Also log to stderr for Chrome to see
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = `CRITICAL: Unhandled Rejection at: ${promise} reason: ${reason}`;
  log(msg);
  console.error(msg); // Also log to stderr for Chrome to see
});

// Log all console.error calls to file as well
const originalConsoleError = console.error;
console.error = function(...args) {
  log(`[STDERR] ${args.join(' ')}`);
  originalConsoleError.apply(console, args);
};

log('Native host starting sequence...');
log(`TIMESTAMP: ${new Date().toISOString()} - This is a NEW instance with error logging`);

// ============================================================================
// Native Messaging Protocol (Chrome Extension <-> Native Host)
// Uses length-prefixed JSON messages over stdin/stdout
// ============================================================================

/**
 * Send a message to Chrome extension via stdout
 * Format: [4-byte little-endian length][JSON message]
 */
function sendToExtension(message) {
  return new Promise((resolve, reject) => {
    try {
      const json = JSON.stringify(message);
      const bodyBuffer = Buffer.from(json, 'utf8');
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(bodyBuffer.length, 0);
      
      // Atomic write to prevent protocol corruption
      const fullBuffer = Buffer.concat([headerBuffer, bodyBuffer]);
      
      // Write with proper backpressure handling
      const canContinue = process.stdout.write(fullBuffer, (err) => {
        if (err) {
          log(`Error flushing to extension: ${err.message}`);
          reject(err);
        } else {
          log(`Flushed to extension: ${json.substring(0, 100)}... (${bodyBuffer.length} bytes)`);
          resolve();
        }
      });
      
      if (!canContinue) {
        log(`WARNING: stdout buffer full, backpressure detected for message (${bodyBuffer.length} bytes)`);
      }
      
      log(`Sent to extension: ${json.substring(0, 100)}... (${bodyBuffer.length} bytes)`);
    } catch (error) {
      log(`Error sending to extension: ${error.message}`);
      reject(error);
    }
  });
}

/**
 * Read messages from Chrome extension via stdin
 * Native messaging uses length-prefixed JSON
 */
function setupStdinReader() {
  let buffer = Buffer.alloc(0);
  let pendingLength = 0;

  process.stdin.on('readable', () => {
    log('stdin readable event');
    let chunk;
    let chunkCount = 0;
    while ((chunk = process.stdin.read()) !== null) {
      chunkCount++;
      // Ensure chunk is always a Buffer
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      buffer = Buffer.concat([buffer, chunkBuffer]);
      log(`Read chunk ${chunkCount}: ${chunkBuffer.length} bytes, total buffer: ${buffer.length} bytes`);
      
      while (true) {
        if (pendingLength === 0) {
          if (buffer.length < 4) {
            log(`Waiting for length header: have ${buffer.length} bytes, need 4`);
            break;
          }
          
          // Check if the buffer contains JSON (look for '{' anywhere in first few bytes)
          let jsonStart = -1;
          for (let i = 0; i < Math.min(buffer.length, 10); i++) {
            if (buffer[i] === 0x7B) { // '{'
              jsonStart = i;
              break;
            }
          }
          
          if (jsonStart >= 0) {
            log(`WARNING: Detected JSON at offset ${jsonStart}! First 50 bytes: ${buffer.slice(0, 50).toString('utf8')}`);
            // Skip to the JSON start
            buffer = buffer.slice(jsonStart);
            
            // Try to parse as JSON directly
            try {
              let braceCount = 0;
              let inString = false;
              let escaped = false;
              for (let i = 0; i < buffer.length; i++) {
                const byte = buffer[i];
                if (escaped) {
                  escaped = false;
                  continue;
                }
                if (byte === 0x5C) { // backslash
                  escaped = true;
                  continue;
                }
                if (byte === 0x22) { // quote
                  inString = !inString;
                  continue;
                }
                if (!inString) {
                  if (byte === 0x7B) braceCount++; // {
                  if (byte === 0x7D) braceCount--; // }
                  if (braceCount === 0 && i > 0) {
                    // Found end of JSON
                    const jsonBuffer = buffer.slice(0, i + 1);
                    buffer = buffer.slice(i + 1);
                    try {
                      const jsonString = jsonBuffer.toString('utf8');
                      const message = JSON.parse(jsonString);
                      log(`Received from extension (no length prefix): ${jsonString.substring(0, 100)}... (${jsonBuffer.length} bytes)`);
                      handleExtensionMessage(message);
                    } catch (e) {
                      log(`Error parsing JSON without length prefix: ${e.message}`);
                    }
                    pendingLength = 0;
                    continue;
                  }
                }
              }
              // If we get here, we need more data
              log(`Incomplete JSON, waiting for more data. Have ${buffer.length} bytes.`);
              break;
            } catch (e) {
              log(`Error handling JSON without length prefix: ${e.message}`);
            }
            break;
          }
          
          pendingLength = buffer.readUInt32LE(0);
          
          // Sanity check: message length should be reasonable (< 100MB)
          if (pendingLength > 100 * 1024 * 1024) {
            log(`ERROR: Invalid message length ${pendingLength}, buffer starts with: ${buffer.slice(0, 20).toString('hex')}`);
            log(`First 20 bytes as string: ${buffer.slice(0, 20).toString('utf8')}`);
            // Try to recover by looking for next valid message
            buffer = buffer.slice(1);
            pendingLength = 0;
            continue;
          }
          
          buffer = buffer.slice(4);
          log(`Read message length: ${pendingLength} bytes`);
        }

        if (buffer.length < pendingLength) {
          // Check if we're waiting for an unreasonably large message
          if (pendingLength > 100 * 1024 * 1024) {
            log(`ERROR: Stuck waiting for huge message (${pendingLength} bytes), resetting state`);
            pendingLength = 0;
            buffer = Buffer.alloc(0);
            break;
          }
          log(`Waiting for message body: have ${buffer.length} bytes, need ${pendingLength}`);
          break;
        }

        const messageBuffer = buffer.slice(0, pendingLength);
        buffer = buffer.slice(pendingLength);
        const currentLength = pendingLength;
        pendingLength = 0;

        try {
          const jsonString = messageBuffer.toString('utf8');
          const message = JSON.parse(jsonString);
          log(`Received from extension: ${jsonString.substring(0, 100)}... (${currentLength} bytes)`);
          handleExtensionMessage(message);
        } catch (error) {
          log(`Error parsing message from extension: ${error.message}`);
        }
      }
    }
    if (chunkCount === 0) {
      log('stdin readable but no data available');
    }
  });

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
// WebSocket Server (Native Host/Server <-> MCP Server/Client)
// ============================================================================

let wss = null;
let activeClient = null;

/**
 * Start WebSocket server that MCP server connects to
 */
function startWSServer() {
  if (isShuttingDown) {
    log('[WS SERVER] Cannot start - shutting down');
    return;
  }
  
  log('[WS SERVER] ═══════════════════════════════════════════════════');
  log('[WS SERVER] Starting WebSocket server on port 9224...');
  log('[WS SERVER] This server will ACCEPT connections from MCP Server');
  log('[WS SERVER] ═══════════════════════════════════════════════════');
  
  try {
    // Large payload limit for complex layout diagnostics
    log('[WS SERVER] Creating WebSocket.Server with config:');
    log('[WS SERVER]   - port: 9224');
    log('[WS SERVER]   - maxPayload: 256MB');
    
    wss = new WebSocket.Server({ 
      port: 9224, 
      maxPayload: 256 * 1024 * 1024 
    });
    
    log('[WS SERVER] WebSocket.Server instance created');
    
    wss.on('listening', () => {
      log('[WS SERVER] ✅✅✅ SERVER IS NOW LISTENING ON PORT 9224 ✅✅✅');
      log('[WS SERVER] MCP Server can now connect to ws://localhost:9224');
      log('[WS SERVER] Waiting for MCP Server to connect...');
    });
    
    wss.on('connection', (client, request) => {
      const clientAddress = request.socket.remoteAddress;
      const clientPort = request.socket.remotePort;
      log('[WS SERVER] ═══════════════════════════════════════════════════');
      log('[WS SERVER] 🎉 NEW CONNECTION RECEIVED!');
      log(`[WS SERVER] Client address: ${clientAddress}:${clientPort}`);
      log('[WS SERVER] ═══════════════════════════════════════════════════');
      
      // Always accept new connections and close old ones
      // This allows MCP server to reconnect after restarts
      if (activeClient) {
        const oldState = activeClient.readyState;
        log(`[WS SERVER] Closing existing client (state: ${oldState}) to accept new connection`);
        try {
          activeClient.close();
        } catch (e) {
          log(`[WS SERVER] Error closing old client: ${e.message}`);
        }
      }
      
      activeClient = client;
      log('[WS SERVER] ✅ MCP Server connected and set as active client');
      
      client.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          log(`[WS SERVER] ⬅️  Received from MCP server (type: ${message.type || 'unknown'})`);
          sendToExtension(message).catch((err) => {
            log(`[WS SERVER] ❌ Failed to send message to extension: ${err.message}`);
          });
        } catch (error) {
          log(`[WS SERVER] ❌ Error processing message from MCP server: ${error.message}`);
        }
      });
      
      client.on('close', () => {
        log('[WS SERVER] ❌ MCP Server disconnected from bridge');
        if (activeClient === client) {
          activeClient = null;
          log('[WS SERVER] Active client cleared');
        }
      });
      
      client.on('error', (error) => {
        log(`[WS SERVER] ❌ MCP client WebSocket error: ${error.message}`);
      });

      log('[WS SERVER] Sending status message to extension...');
      sendToExtension({ type: 'status', connected: true }).catch((err) => {
        log(`[WS SERVER] ❌ Failed to send status message: ${err.message}`);
      });
    });
    
    wss.on('error', (error) => {
      log(`[WS SERVER] ❌❌❌ CRITICAL ERROR: ${error.message}`);
      log(`[WS SERVER] Error code: ${error.code}`);
      log(`[WS SERVER] Error stack: ${error.stack}`);
      
      if (error.code === 'EADDRINUSE') {
        log('[WS SERVER] ❌ Port 9224 already in use!');
        log('[WS SERVER] Another process is using this port');
        log('[WS SERVER] Exiting...');
        process.exit(1);
      }
    });

    log('[WS SERVER] Event listeners registered');
    log('[WS SERVER] Waiting for "listening" event...');
    
  } catch (error) {
    log(`[WS SERVER] ❌❌❌ EXCEPTION during startup: ${error.message}`);
    log(`[WS SERVER] Stack: ${error.stack}`);
  }
}

function sendToMCPServer(message) {
  if (!activeClient || activeClient.readyState !== WebSocket.OPEN) {
    log(`Cannot send to MCP server - no active client (state: ${activeClient ? activeClient.readyState : 'none'})`);
    return;
  }
  
  try {
    const json = JSON.stringify(message);
    activeClient.send(json, (err) => {
      if (err) log(`WebSocket send error: ${err.message}`);
    });
    log(`Sent to MCP server: ${json.substring(0, 100)}... (${json.length} bytes)`);
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
  // Respond to keep-alive messages to keep connection alive
  if (message.type === 'keep-alive') {
    log('Received keep-alive from extension, sending acknowledgment');
    sendToExtension({ type: 'keep-alive-ack', timestamp: Date.now() }).catch((err) => {
      log(`Failed to send keep-alive ack: ${err.message}`);
    });
    return;
  }
  
  // Forward all other messages to MCP server
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
  
  if (activeClient) {
    activeClient.close();
    activeClient = null;
  }
  
  if (wss) {
    wss.close();
    wss = null;
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

log('═══════════════════════════════════════════════════════════════');
log('NATIVE HOST INITIALIZATION STARTING');
log('═══════════════════════════════════════════════════════════════');
log(`Process ID: ${process.pid}`);
log(`Node Version: ${process.version}`);
log(`Platform: ${process.platform}`);
log(`Working Directory: ${process.cwd()}`);
log(`Log File: ${LOG_FILE}`);
log('═══════════════════════════════════════════════════════════════');

// Set up stdin for binary reading
log('[STEP 1] Setting up stdin for binary reading...');
process.stdin.setEncoding(null);
log('[STEP 1] ✅ stdin encoding set to null (binary mode)');

// Start reading from extension
log('[STEP 2] Setting up stdin reader for Chrome Extension messages...');
setupStdinReader();
log('[STEP 2] ✅ stdin reader configured');

// Start WebSocket server (MCP server will connect to us)
log('[STEP 3] Starting WebSocket server on port 9224...');
log('[STEP 3] This server will accept connections from MCP Server');
startWSServer();
log('[STEP 3] ✅ WebSocket server initialization complete');

log('═══════════════════════════════════════════════════════════════');
log('NATIVE HOST READY - Waiting for connections');
log('═══════════════════════════════════════════════════════════════');
log('Expected connection flow:');
log('  1. Chrome Extension → Native Host (via stdin/stdout)');
log('  2. MCP Server → Native Host (via WebSocket on port 9224)');
log('═══════════════════════════════════════════════════════════════');
log('Native host ready');

// Send initial ready message to extension after a short delay
// This ensures stdout is properly set up
setTimeout(() => {
  log('[STARTUP] Sending ready message to extension...');
  sendToExtension({ 
    type: 'ready', 
    timestamp: Date.now(),
    pid: process.pid,
    version: '1.0.0'
  }).then(() => {
    log('[STARTUP] ✅ Ready message sent successfully');
  }).catch((err) => {
    log(`[STARTUP] ⚠️  Failed to send ready message: ${err.message}`);
    // Don't exit - this is not critical
  });
}, 100);
