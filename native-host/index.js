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
  try {
    logStream.write(`[${timestamp}] ${message}\n`);
  } catch (e) {
    // Ignore log errors
  }
}

// Global error handlers to prevent silent exits
process.on('uncaughtException', (error) => {
  log(`CRITICAL: Uncaught Exception: ${error.message}\n${error.stack}`);
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`CRITICAL: Unhandled Rejection at: ${promise} reason: ${reason}`);
});

log('Native host starting sequence...');

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
  if (isShuttingDown) return;
  
  log(`Starting WebSocket server on port 9224...`);
  
  try {
    // Large payload limit for complex layout diagnostics
    wss = new WebSocket.Server({ 
      port: 9224, 
      maxPayload: 256 * 1024 * 1024 
    });
    
    wss.on('connection', (client) => {
      log('MCP Server connected to bridge');
      
      // Don't close the previous connection - reuse it if still valid
      // This allows multiple MCP server instances to share the same native messaging connection
      if (activeClient && activeClient.readyState === WebSocket.OPEN) {
        log('Reusing existing MCP client connection');
        client.close();
        return;
      }
      
      // Only replace if the old one is dead
      if (activeClient) {
        log('Closing dead MCP client connection');
        activeClient.close();
      }
      
      activeClient = client;
      
      client.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          log(`Received from MCP server (type: ${message.type || 'unknown'})`);
          sendToExtension(message).catch((err) => {
            log(`Failed to send message to extension: ${err.message}`);
          });
        } catch (error) {
          log(`Error processing message from MCP server: ${error.message}`);
        }
      });
      
      client.on('close', () => {
        log('MCP Server disconnected from bridge');
        if (activeClient === client) {
          activeClient = null;
        }
      });
      
      client.on('error', (error) => {
        log(`MCP client WebSocket error: ${error.message}`);
      });

      sendToExtension({ type: 'status', connected: true }).catch((err) => {
        log(`Failed to send status message: ${err.message}`);
      });
    });
    
    wss.on('error', (error) => {
      log(`WebSocket server error: ${error.message}`);
      if (error.code === 'EADDRINUSE') {
        log('Port 9224 already in use. Exiting.');
        process.exit(1);
      }
    });

    log('WebSocket server listening on ws://localhost:9224');
    
  } catch (error) {
    log(`Failed to start WebSocket server: ${error.message}`);
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
  // Ignore keep-alive messages
  if (message.type === 'keep-alive') {
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

// Set up stdin for binary reading
process.stdin.setEncoding(null);

// Start reading from extension
setupStdinReader();

// Start WebSocket server (MCP server will connect to us)
startWSServer();

log('Native host ready');
