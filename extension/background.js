// ============================================================================
// DevTools Bridge - Background Script
// Handles debugger attachment and native messaging communication
// ============================================================================

// Debugger state
let debuggerTabId = null;
let debuggerState = {
  attached: false,
  tabId: null,
  domainsEnabled: false,
  lastError: null,
  attachmentTime: null
};

// Native messaging state
let nativePort = null;
let nativeHostConnected = false;
let keepAliveInterval = null;

// ============================================================================
// Native Messaging (Extension <-> Native Host)
// ============================================================================

/**
 * Connect to native messaging host
 */
function connectNativeHost() {
  if (nativePort) {
    console.log('Native host already connected');
    return;
  }
  
  try {
    console.log('Connecting to native messaging host...');
    nativePort = chrome.runtime.connectNative('com.devtools.bridge');
    
    nativePort.onMessage.addListener((message) => {
      console.log('Received from native host:', message);
      handleNativeMessage(message);
    });
    
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.log('Native host disconnected:', error?.message || 'unknown reason');
      nativePort = null;
      nativeHostConnected = false;
      stopKeepAlive();
    });
    
    nativeHostConnected = true;
    console.log('Connected to native messaging host');
    
    // Start keep-alive to prevent service worker termination
    startKeepAlive();
    
  } catch (error) {
    console.error('Failed to connect to native host:', error);
    nativePort = null;
    nativeHostConnected = false;
  }
}

/**
 * Keep-alive mechanism to prevent service worker termination
 */
function startKeepAlive() {
  if (keepAliveInterval) return;
  
  keepAliveInterval = setInterval(() => {
    if (nativePort) {
      // Send a no-op message to keep the connection alive
      try {
        nativePort.postMessage({ type: 'keep-alive' });
      } catch (e) {
        // Connection may be dead
        stopKeepAlive();
      }
    }
  }, 20000); // Every 20 seconds
}

/**
 * Stop keep-alive mechanism
 */
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * Disconnect from native messaging host
 */
function disconnectNativeHost() {
  stopKeepAlive();
  
  if (nativePort) {
    nativePort.disconnect();
    nativePort = null;
    nativeHostConnected = false;
    console.log('Disconnected from native host');
  }
}

/**
 * Send message to native host
 */
function sendToNativeHost(message) {
  // Auto-reconnect if not connected
  if (!nativePort || !nativeHostConnected) {
    connectNativeHost();
  }
  
  if (!nativePort) {
    console.error('Cannot send to native host - not connected');
    return false;
  }
  
  try {
    nativePort.postMessage(message);
    console.log('Sent to native host:', message);
    return true;
  } catch (error) {
    console.error('Failed to send to native host:', error);
    return false;
  }
}

/**
 * Handle messages from native host (CDP requests from MCP server)
 */
function handleNativeMessage(message) {
  // Handle status messages from native host
  if (message.type === 'status') {
    console.log('Native host status:', message);
    return;
  }
  
  // Handle CDP requests from MCP server
  if (message.type === 'cdp_request') {
    const { id, method, params } = message;
    
    if (!debuggerState.attached) {
      sendToNativeHost({
        type: 'cdp_response',
        id,
        error: { message: 'Debugger not attached' }
      });
      return;
    }
    
    // Execute CDP command with error handling
    sendCDPCommand(debuggerState.tabId, method, params || {})
      .then(result => {
        try {
          sendToNativeHost({
            type: 'cdp_response',
            id,
            result
          });
        } catch (error) {
          console.error('Failed to send CDP response:', error);
        }
      })
      .catch(error => {
        try {
          sendToNativeHost({
            type: 'cdp_response',
            id,
            error: { message: error.message }
          });
        } catch (sendError) {
          console.error('Failed to send CDP error response:', sendError);
        }
      });
  }
}

// ============================================================================
// Debugger Management
// ============================================================================

/**
 * Attach debugger to current tab with enhanced error handling
 */
function attachDebugger(tabId) {
  debuggerState.lastError = null;
  
  // Check if tab exists and is valid
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      const error = chrome.runtime.lastError?.message || 'Tab not found or inaccessible';
      debuggerState.lastError = error;
      debuggerState.attached = false;
      debuggerState.tabId = null;
      debuggerState.domainsEnabled = false;
      console.error('Failed to get tab:', error);
      return;
    }
    
    // Check if tab URL is debuggable
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://')) {
      const error = `Cannot attach debugger to system page: ${tab.url}`;
      debuggerState.lastError = error;
      console.error(error);
      return;
    }
    
    // Detach from previous tab if attached
    if (debuggerState.attached && debuggerState.tabId && debuggerState.tabId !== tabId) {
      detachDebugger(debuggerState.tabId);
    }
    
    console.log(`Attempting to attach debugger to tab ${tabId} (${tab.url})`);
    
    // Attach debugger
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        console.error('Failed to attach debugger:', error);
        debuggerState.lastError = error;
        debuggerState.attached = false;
        debuggerState.tabId = null;
        debuggerState.domainsEnabled = false;
        return;
      }
      
      debuggerTabId = tabId;
      debuggerState.attached = true;
      debuggerState.tabId = tabId;
      debuggerState.domainsEnabled = false;
      debuggerState.attachmentTime = Date.now();
      
      console.log(`Successfully attached debugger to tab ${tabId}`);
      
      // Enable required CDP domains
      enableCDPDomains(tabId);
      
      // Connect to native host after debugger is attached
      connectNativeHost();
    });
  });
}

/**
 * Enable required CDP domains
 */
/**
 * Enable required CDP domains
 */
function enableCDPDomains(tabId) {
  const domains = ['DOM', 'CSS', 'Page', 'Overlay'];
  let enabledCount = 0;
  
  function enableNextDomain() {
    if (enabledCount >= domains.length) {
      debuggerState.domainsEnabled = true;
      console.log('All CDP domains enabled successfully');
      return;
    }
    
    const domain = domains[enabledCount];
    console.log(`Enabling ${domain} domain...`);
    
    chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {}, () => {
      if (chrome.runtime.lastError) {
        console.warn(`Failed to enable ${domain}:`, chrome.runtime.lastError.message);
        debuggerState.domainsEnabled = false;
        return;
      }
      
      console.log(`Successfully enabled ${domain} domain`);
      enabledCount++;
      enableNextDomain();
    });
  }
  
  enableNextDomain();
}

/**
 * Detach debugger with proper cleanup
 */
function detachDebugger(tabId = null) {
  const targetTabId = tabId || debuggerState.tabId || debuggerTabId;
  
  // Disconnect native host first
  disconnectNativeHost();
  
  if (!targetTabId) {
    console.log('No debugger to detach');
    return;
  }
  
  console.log(`Detaching debugger from tab ${targetTabId}`);
  chrome.debugger.detach({ tabId: targetTabId }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to detach debugger:', chrome.runtime.lastError.message);
    }
    
    // Reset state
    debuggerTabId = null;
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    debuggerState.lastError = null;
    debuggerState.attachmentTime = null;
    
    console.log('Debugger detached successfully');
  });
}

/**
 * Send CDP command with timeout
 */
async function sendCDPCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!debuggerState.attached || debuggerState.tabId !== tabId) {
      const error = `Debugger not attached to tab ${tabId}`;
      console.error('CDP Error:', error, 'State:', debuggerState);
      reject(new Error(error));
      return;
    }
    
    let responded = false;
    
    // Use 12 second timeout (longer than MCP server's 10 second timeout)
    // This ensures the MCP server times out first, preventing state corruption
    const timeout = setTimeout(() => {
      responded = true;
      const errorMsg = `CDP command ${method} timed out after 12 seconds`;
      console.error('CDP Timeout:', errorMsg);
      reject(new Error(errorMsg));
    }, 12000);
    
    console.log(`Sending CDP command: ${method} to tab ${tabId}`);
    
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      clearTimeout(timeout);
      
      // Ignore response if we already timed out
      if (responded) {
        console.warn(`Ignoring late response for ${method} (already timed out)`);
        return;
      }
      
      responded = true;
      
      if (chrome.runtime.lastError) {
        const errorMsg = `CDP command ${method} failed: ${chrome.runtime.lastError.message}`;
        console.error('CDP Error:', errorMsg);
        reject(new Error(errorMsg));
      } else {
        console.log(`CDP command ${method} succeeded`);
        resolve(result);
      }
    });
  });
}

/**
 * Get comprehensive debugger status
 */
function getDebuggerStatus() {
  return {
    connected: debuggerState.attached,
    tabId: debuggerState.tabId,
    domainsEnabled: debuggerState.domainsEnabled,
    lastError: debuggerState.lastError,
    attachmentTime: debuggerState.attachmentTime,
    uptime: debuggerState.attachmentTime ? Date.now() - debuggerState.attachmentTime : null,
    nativeHostConnected: nativeHostConnected
  };
}


// ============================================================================
// Message Handlers (Popup <-> Background)
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'attach') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      
      const tab = tabs[0];
      if (!tab.id) {
        sendResponse({ success: false, error: 'Invalid tab ID' });
        return;
      }
      
      attachDebugger(tab.id);
      // Send response after a short delay to allow attachment to complete
      setTimeout(() => {
        sendResponse({ 
          success: debuggerState.attached, 
          tabId: debuggerState.tabId,
          error: debuggerState.lastError
        });
      }, 100);
    });
    return true;
  }
  
  if (request.action === 'detach') {
    detachDebugger();
    sendResponse({ success: true });
    return true;
  }
  
  if (request.action === 'status') {
    const status = getDebuggerStatus();
    sendResponse(status);
    return true;
  }
  
  // Forward CDP commands with validation
  if (request.action === 'cdp') {
    if (!debuggerState.attached || !debuggerState.domainsEnabled) {
      sendResponse({ 
        success: false, 
        error: 'Debugger not properly attached or domains not enabled' 
      });
      return true;
    }
    
    sendCDPCommand(debuggerState.tabId, request.method, request.params)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Handle diagnosis requests
  if (request.action === 'diagnose') {
    if (!debuggerState.attached) {
      sendResponse({ 
        success: false, 
        error: 'Debugger not attached. Please connect to a tab first.' 
      });
      return true;
    }
    
    chrome.tabs.sendMessage(debuggerState.tabId, { 
      action: 'diagnose', 
      selector: request.selector 
    }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ 
          success: false, 
          error: `Content script communication failed: ${chrome.runtime.lastError.message}` 
        });
      } else {
        sendResponse({ success: true, result: response });
      }
    });
    return true;
  }
});

// ============================================================================
// Event Handlers
// ============================================================================

// Handle debugger detach
chrome.debugger.onDetach.addListener((source, reason) => {
  console.error(`🔴 DEBUGGER DETACHED from tab ${source.tabId}: ${reason}`);
  console.error('Debugger state at detach:', debuggerState);
  
  if (source.tabId === debuggerState.tabId) {
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    debuggerState.lastError = reason === 'target_closed' ? 'Tab was closed' : `Detached: ${reason}`;
    debuggerTabId = null;
    
    // Disconnect native host when debugger detaches
    disconnectNativeHost();
  }
  
  // Notify popup if it's open
  chrome.runtime.sendMessage({ 
    action: 'debugger_detached', 
    tabId: source.tabId, 
    reason 
  }).catch(() => {
    // Popup might not be open, ignore error
  });
});

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === debuggerState.tabId && changeInfo.status === 'loading') {
    console.log(`Attached tab ${tabId} is reloading`);
    debuggerState.domainsEnabled = false;
  }
});

// Handle tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === debuggerState.tabId) {
    console.log(`Attached tab ${tabId} was closed`);
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    debuggerState.lastError = 'Tab was closed';
    debuggerTabId = null;
    
    disconnectNativeHost();
  }
});

console.log('DevTools Bridge extension loaded');
