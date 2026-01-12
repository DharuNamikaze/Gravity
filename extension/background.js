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
async function handleNativeMessage(message) {
  // Handle status messages from native host
  if (message.type === 'status') {
    console.log('Native host status:', message);
    return;
  }
  
  // Handle CDP requests from MCP server
  if (message.type === 'cdp_request') {
    const { id, method, params } = message;
    
    try {
      if (!debuggerState.attached) {
        throw new Error('Debugger not attached');
      }
      
      // Execute CDP command
      const result = await sendCDPCommand(debuggerState.tabId, method, params || {});
      
      // Send response back through native host
      sendToNativeHost({
        type: 'cdp_response',
        id,
        result
      });
      
    } catch (error) {
      // Send error back through native host
      sendToNativeHost({
        type: 'cdp_response',
        id,
        error: { message: error.message }
      });
    }
  }
}

// ============================================================================
// Debugger Management
// ============================================================================

/**
 * Attach debugger to current tab with enhanced error handling
 */
async function attachDebugger(tabId) {
  try {
    debuggerState.lastError = null;
    
    // Check if tab exists and is valid
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error(`Tab ${tabId} not found or inaccessible`);
    }
    
    // Check if tab URL is debuggable
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://')) {
      throw new Error(`Cannot attach debugger to system page: ${tab.url}`);
    }
    
    // Detach from previous tab if attached
    if (debuggerState.attached && debuggerState.tabId && debuggerState.tabId !== tabId) {
      await detachDebugger(debuggerState.tabId);
    }
    
    console.log(`Attempting to attach debugger to tab ${tabId} (${tab.url})`);
    
    // Attach debugger with timeout
    await Promise.race([
      chrome.debugger.attach({ tabId }, '1.3'),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Debugger attachment timeout (5s)')), 5000)
      )
    ]);
    
    debuggerTabId = tabId;
    debuggerState.attached = true;
    debuggerState.tabId = tabId;
    debuggerState.domainsEnabled = false;
    debuggerState.attachmentTime = Date.now();
    
    console.log(`Successfully attached debugger to tab ${tabId}`);
    
    // Enable required CDP domains
    await enableCDPDomains(tabId);
    
    // Connect to native host after debugger is attached
    connectNativeHost();
    
    return { success: true, tabId, url: tab.url };
  } catch (error) {
    const errorMessage = error.message || 'Unknown debugger attachment error';
    console.error('Failed to attach debugger:', errorMessage);
    
    debuggerState.lastError = errorMessage;
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    
    // Clean up partial state
    if (debuggerTabId) {
      try {
        await chrome.debugger.detach({ tabId: debuggerTabId });
      } catch (detachError) {
        console.warn('Failed to clean up debugger attachment:', detachError);
      }
      debuggerTabId = null;
    }
    
    return { success: false, error: errorMessage };
  }
}

/**
 * Enable required CDP domains
 */
async function enableCDPDomains(tabId) {
  const domains = ['DOM', 'CSS', 'Page'];
  const enabledDomains = [];
  
  try {
    for (const domain of domains) {
      console.log(`Enabling ${domain} domain...`);
      await sendCDPCommand(tabId, `${domain}.enable`);
      enabledDomains.push(domain);
      console.log(`Successfully enabled ${domain} domain`);
    }
    
    debuggerState.domainsEnabled = true;
    console.log('All CDP domains enabled successfully');
    
  } catch (error) {
    // Clean up partially enabled domains
    for (const domain of enabledDomains) {
      try {
        await sendCDPCommand(tabId, `${domain}.disable`);
      } catch (cleanupError) {
        console.warn(`Failed to disable ${domain} during cleanup:`, cleanupError);
      }
    }
    
    debuggerState.domainsEnabled = false;
    throw error;
  }
}

/**
 * Detach debugger with proper cleanup
 */
async function detachDebugger(tabId = null) {
  const targetTabId = tabId || debuggerState.tabId || debuggerTabId;
  
  // Disconnect native host first
  disconnectNativeHost();
  
  if (!targetTabId) {
    console.log('No debugger to detach');
    return { success: true };
  }
  
  try {
    console.log(`Detaching debugger from tab ${targetTabId}`);
    await chrome.debugger.detach({ tabId: targetTabId });
    
    // Reset state
    debuggerTabId = null;
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    debuggerState.lastError = null;
    debuggerState.attachmentTime = null;
    
    console.log('Debugger detached successfully');
    return { success: true };
    
  } catch (error) {
    const errorMessage = error.message || 'Unknown detachment error';
    console.error('Failed to detach debugger:', errorMessage);
    
    // Reset state even if detachment failed
    debuggerTabId = null;
    debuggerState.attached = false;
    debuggerState.tabId = null;
    debuggerState.domainsEnabled = false;
    debuggerState.lastError = errorMessage;
    
    return { success: false, error: errorMessage };
  }
}

/**
 * Send CDP command with timeout
 */
async function sendCDPCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!debuggerState.attached || debuggerState.tabId !== tabId) {
      reject(new Error(`Debugger not attached to tab ${tabId}`));
      return;
    }
    
    const timeout = setTimeout(() => {
      reject(new Error(`CDP command ${method} timed out after 5 seconds`));
    }, 5000);
    
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      clearTimeout(timeout);
      
      if (chrome.runtime.lastError) {
        reject(new Error(`CDP command ${method} failed: ${chrome.runtime.lastError.message}`));
      } else {
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
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      
      const tab = tabs[0];
      if (!tab.id) {
        sendResponse({ success: false, error: 'Invalid tab ID' });
        return;
      }
      
      const result = await attachDebugger(tab.id);
      sendResponse(result);
    });
    return true;
  }
  
  if (request.action === 'detach') {
    detachDebugger().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
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
  console.log(`Debugger detached from tab ${source.tabId}: ${reason}`);
  
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
