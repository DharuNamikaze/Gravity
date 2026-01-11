const indicator = document.getElementById('indicator');
const statusText = document.getElementById('statusText');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const errorDisplay = document.getElementById('errorDisplay');

let currentStatus = null;

// Check initial status and set up periodic updates
function initializeUI() {
  updateStatus();
  // Check status every 2 seconds to maintain UI consistency
  setInterval(updateStatus, 2000);
}

// Update status from background script
function updateStatus() {
  chrome.runtime.sendMessage({ action: 'status' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Failed to get status:', chrome.runtime.lastError);
      return;
    }
    
    currentStatus = response;
    updateUI(response);
  });
}

// Connect button with enhanced error handling
connectBtn.addEventListener('click', async () => {
  // Disable button during connection attempt
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  hideError();
  
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'attach' }, resolve);
    });
    
    if (response.success) {
      showSuccess(`Connected to tab ${response.tabId}`);
      updateStatus(); // Refresh status immediately
    } else {
      showError(response.error || 'Failed to connect to tab');
    }
  } catch (error) {
    showError(`Connection failed: ${error.message}`);
  } finally {
    // Re-enable button
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect to Tab';
  }
});

// Disconnect button with enhanced error handling
disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  disconnectBtn.textContent = 'Disconnecting...';
  hideError();
  
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'detach' }, resolve);
    });
    
    if (response.success) {
      showSuccess('Disconnected successfully');
      updateStatus(); // Refresh status immediately
    } else {
      showError(response.error || 'Failed to disconnect');
    }
  } catch (error) {
    showError(`Disconnect failed: ${error.message}`);
  } finally {
    disconnectBtn.disabled = false;
    disconnectBtn.textContent = 'Disconnect';
  }
});

// Update UI based on debugger status
function updateUI(status) {
  if (status.connected && status.domainsEnabled) {
    // Fully connected and ready
    indicator.classList.remove('error', 'warning');
    indicator.classList.add('connected');
    statusText.textContent = `Connected to tab ${status.tabId}`;
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    
    if (status.uptime) {
      const uptimeSeconds = Math.floor(status.uptime / 1000);
      statusText.textContent += ` (${uptimeSeconds}s)`;
    }
    
  } else if (status.connected && !status.domainsEnabled) {
    // Connected but domains not enabled (transitional state)
    indicator.classList.remove('connected', 'error');
    indicator.classList.add('warning');
    statusText.textContent = `Connecting to tab ${status.tabId}...`;
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    
  } else {
    // Not connected
    indicator.classList.remove('connected', 'warning');
    if (status.lastError) {
      indicator.classList.add('error');
      statusText.textContent = 'Connection failed';
      showError(status.lastError);
    } else {
      indicator.classList.remove('error');
      statusText.textContent = 'Not connected';
    }
    
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }
}

// Show error message
function showError(message) {
  if (errorDisplay) {
    errorDisplay.textContent = message;
    errorDisplay.classList.remove('hidden', 'success');
    errorDisplay.classList.add('error');
  }
}

// Show success message
function showSuccess(message) {
  if (errorDisplay) {
    errorDisplay.textContent = message;
    errorDisplay.classList.remove('hidden', 'error');
    errorDisplay.classList.add('success');
    
    // Auto-hide success messages after 3 seconds
    setTimeout(hideError, 3000);
  }
}

// Hide error/success message
function hideError() {
  if (errorDisplay) {
    errorDisplay.classList.add('hidden');
    errorDisplay.classList.remove('error', 'success');
  }
}

// Listen for debugger detach events
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'debugger_detached') {
    showError(`Debugger detached: ${message.reason}`);
    updateStatus();
  }
});

// Initialize UI when popup opens
initializeUI();