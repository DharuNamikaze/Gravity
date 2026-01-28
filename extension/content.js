// Content script for DOM element diagnosis and WebSocket bridge
(function() {
  'use strict';

  // WebSocket bridge for MCP server communication
  let wsServer = null;
  let messageQueue = [];
  let isExtensionReady = false;

  // Initialize WebSocket bridge
  function initWebSocketBridge() {
    // Regular page - set up message passing
    // Note: We don't need special handling for localhost:9224 as that's a WebSocket server
    setupMessageBridge();
  }

  // Set up message bridge for regular pages
  function setupMessageBridge() {
    // Listen for messages from extension
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'diagnose') {
        const result = diagnoseElement(request.selector);
        sendResponse(result);
      } else if (request.action === 'websocket_message') {
        // Forward WebSocket message to extension
        handleWebSocketMessage(request.message).then(sendResponse);
        return true; // Keep channel open
      }
    });
    
    isExtensionReady = true;
    console.log('Gravity content script ready');
  }

  // Handle WebSocket messages
  async function handleWebSocketMessage(message) {
    try {
      // Forward to extension background script
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'websocket_message',
          message: message
        }, resolve);
      });
    } catch (error) {
      return {
        id: message.id,
        error: { message: error.message }
      };
    }
  }

  // Diagnostic functions
  function diagnoseElement(selector) {
    const element = document.querySelector(selector);
    
    if (!element) {
      return {
        error: `Element not found: ${selector}`,
        timestamp: new Date().toISOString()
      };
    }

    const rect = element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(element);
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Check for layout issues
    const issues = [];
    const THRESHOLD = 2;

    // Check if element extends beyond viewport
    if (rect.right > viewport.width + THRESHOLD) {
      issues.push({
        type: "offscreen-right",
        severity: "high",
        message: `Element extends ${Math.round(rect.right - viewport.width)}px beyond right edge of viewport`,
        pixels: Math.round(rect.right - viewport.width),
        suggestion: "Add max-width: 100% or use responsive units (vw, %, rem)"
      });
    }

    if (rect.bottom > viewport.height + THRESHOLD) {
      issues.push({
        type: "offscreen-bottom",
        severity: "high",
        message: `Element extends ${Math.round(rect.bottom - viewport.height)}px beyond bottom edge of viewport`,
        pixels: Math.round(rect.bottom - viewport.height),
        suggestion: "Add max-height: 100vh or enable scrolling"
      });
    }

    if (rect.left < -THRESHOLD) {
      issues.push({
        type: "offscreen-left",
        severity: "high",
        message: `Element starts ${Math.round(Math.abs(rect.left))}px to the left of viewport`,
        pixels: Math.round(Math.abs(rect.left)),
        suggestion: "Check left/margin-left values, ensure >= 0"
      });
    }

    if (rect.top < -THRESHOLD) {
      issues.push({
        type: "offscreen-top",
        severity: "high",
        message: `Element starts ${Math.round(Math.abs(rect.top))}px above viewport`,
        pixels: Math.round(Math.abs(rect.top)),
        suggestion: "Check top/margin-top values, ensure >= 0"
      });
    }

    // Check for common modal issues
    if (computedStyle.position === 'fixed' || computedStyle.position === 'absolute') {
      // Check z-index
      const zIndex = computedStyle.zIndex;
      if (zIndex === 'auto' || parseInt(zIndex) < 1000) {
        issues.push({
          type: "low-z-index",
          severity: "medium",
          message: `Modal z-index is ${zIndex}, may be hidden behind other elements`,
          suggestion: "Set z-index to a high value (e.g., 9999) for modals"
        });
      }

      // Check if modal has backdrop
      const backdrop = document.querySelector('.modal-backdrop, .overlay, [class*="backdrop"]');
      if (!backdrop) {
        issues.push({
          type: "missing-backdrop",
          severity: "low",
          message: "No backdrop element detected",
          suggestion: "Consider adding a backdrop/overlay for better UX"
        });
      }
    }

    // Check visibility
    if (computedStyle.display === 'none') {
      issues.push({
        type: "hidden-display",
        severity: "high",
        message: "Element has display: none",
        suggestion: "Change display property to show the modal"
      });
    }

    if (computedStyle.visibility === 'hidden') {
      issues.push({
        type: "hidden-visibility",
        severity: "high",
        message: "Element has visibility: hidden",
        suggestion: "Change visibility to 'visible'"
      });
    }

    if (parseFloat(computedStyle.opacity) === 0) {
      issues.push({
        type: "transparent",
        severity: "medium",
        message: "Element has opacity: 0",
        suggestion: "Increase opacity to make element visible"
      });
    }

    return {
      element: selector,
      timestamp: new Date().toISOString(),
      position: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom)
      },
      viewport: viewport,
      computedStyles: {
        display: computedStyle.display,
        position: computedStyle.position,
        width: computedStyle.width,
        height: computedStyle.height,
        overflow: computedStyle.overflow,
        zIndex: computedStyle.zIndex,
        visibility: computedStyle.visibility,
        opacity: computedStyle.opacity
      },
      issues: issues.length > 0 ? issues : [
        {
          type: "none",
          severity: "low",
          message: "No layout issues detected",
          suggestion: "Element appears to be positioned correctly within viewport"
        }
      ],
      confidence: issues.length > 0 ? 0.95 : 0.8
    };
  }

  // Initialize bridge
  initWebSocketBridge();

  // Also make it available globally for manual testing
  window.diagnoseElement = diagnoseElement;

})();