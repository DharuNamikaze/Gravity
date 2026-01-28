# Gravity - Technical Architecture & Implementation

## Executive Summary

Gravity is a three-layer system that enables AI assistants to diagnose CSS layout issues in live browser tabs. It solves the fundamental problem that AI cannot inspect real DOM elements without a bridge to the browser.

**Key Innovation:** Inverted connection logic - the native host runs a persistent WebSocket server, allowing the MCP server to reconnect without losing the browser connection.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              GRAVITY SYSTEM                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────┐    stdio     ┌──────────────┐    WebSocket    ┌────────────┐  │
│  │              │   (MCP)      │              │   (port 9224)   │            │  │
│  │   Kiro/AI    │─────────────▶│  MCP Server  │◀───────────────▶│  Native  │  │
│  │   Client     │◀─────────────│  (TypeScript)│                │  Host      │ │
│  │              │   JSON-RPC   │              │                 │  (Node.js) │ │
│  └──────────────┘              └──────────────┘                 └─────┬──────┘ │
│                                                                       │        │
│                                                          Native Messaging      │
│                                                          (length-prefixed)     │
│                                                                       │        │
│                                                                       ▼        │
│                                                                ┌────────────┐  │
│                                                                │  Chrome    │  │
│                                                                │ Extension  │  │
│                                                                │  (MV3)     │  │
│                                                                └─────┬──────┘  │
│                                                                      │         │
│                                                          chrome.debugger API   │
│                                                                      │         │
│                                                                      ▼         │
│                                                                ┌────────────┐  │
│                                                                │  Browser   │  │
│                                                                │   Tab      │  │
│                                                                │  (DOM)     │  │
│                                                                └────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. MCP Server (`mcp-server/src/index.ts`)

The MCP server is the main entry point that Kiro communicates with.

**Responsibilities:**
- Exposes MCP tools (`connect_browser`, `diagnose_layout`) via stdio
- Validates CSS selectors before querying
- Sends CDP commands through the native bridge
- Analyzes layout data and generates diagnostic reports

**Key Functions:**
```typescript
// Tool handlers
connect_browser  → Checks/establishes browser connection
diagnose_layout  → Analyzes element layout issues

// Diagnostic checks
checkOffscreen()     → Detects elements outside viewport
checkVisibility()    → Detects hidden elements (display, visibility, opacity)
checkModalIssues()   → Detects z-index and centering problems
checkOverflow()      → Detects overflow clipping issues
```

**Data Flow:**
1. Receives tool call from Kiro via stdio (JSON-RPC)
2. Validates input (selector syntax)
3. Sends CDP commands via WebSocket to native host
4. Receives CDP responses
5. Analyzes data and returns diagnostic report

---

### 2. Native Bridge (`mcp-server/src/native-bridge.ts`)

WebSocket client that connects to the native host's WebSocket server.

**Responsibilities:**
- Maintains WebSocket connection to native host (port 9224)
- Auto-reconnects on connection loss
- Routes CDP commands/responses with request ID tracking
- Handles timeouts for CDP commands

**Key Functions:**
```typescript
startNativeBridge(port)     → Initiates connection with auto-reconnect
stopNativeBridge()          → Cleanly closes connection
isNativeHostConnected()     → Connection status check
ensureConnected(timeout)    → Waits for connection with timeout
sendCDPCommand(method, params) → Sends CDP command, returns promise
```

**Connection State Machine:**
```
[Disconnected] ──connect──▶ [Connecting] ──success──▶ [Connected]
      ▲                          │                         │
      │                          │ error                   │ close
      │                          ▼                         │
      └────────────────── [Reconnecting] ◀─────────────────┘
                          (2s interval)
```

---

### 3. Native Messaging Host (`native-host/index.js`)

Node.js process spawned by Chrome that bridges the extension to the MCP server.

**Responsibilities:**
- Runs WebSocket server on port 9224
- Reads/writes Chrome Native Messaging protocol (length-prefixed JSON)
- Routes messages bidirectionally between MCP server and extension

**Protocol Details:**

Native Messaging format (Chrome ↔ Native Host):
```
┌──────────────┬─────────────────────────────────┐
│ 4 bytes      │ N bytes                         │
│ (uint32 LE)  │ (UTF-8 JSON)                    │
│ length = N   │ message payload                 │
└──────────────┴─────────────────────────────────┘
```

WebSocket format (Native Host ↔ MCP Server):
```json
// CDP Request (MCP → Extension)
{
  "type": "cdp_request",
  "id": 1,
  "method": "DOM.getDocument",
  "params": { "depth": -1 }
}

// CDP Response (Extension → MCP)
{
  "type": "cdp_response",
  "id": 1,
  "result": { "root": { "nodeId": 1, ... } }
}
```

**Lifecycle:**
1. Chrome spawns native host when extension calls `chrome.runtime.connectNative()`
2. Native host starts WebSocket server on port 9224
3. MCP server connects as WebSocket client
4. Messages flow bidirectionally
5. When extension disconnects (stdin closes), native host shuts down

---

### 4. Chrome Extension (`extension/`)

Manifest V3 extension with debugger access.

**Components:**

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration, permissions |
| `background.js` | Service worker - debugger & native messaging |
| `content.js` | Content script - fallback DOM diagnostics |
| `popup.html/js` | User interface for connection control |

**Permissions Required:**
- `debugger` - Attach Chrome Debugger API
- `activeTab` - Access current tab
- `tabs` - Query tab information
- `nativeMessaging` - Communicate with native host

**background.js Flow:**
```
User clicks "Connect to Tab"
         │
         ▼
┌─────────────────────┐
│ attachDebugger()    │ ← chrome.debugger.attach()
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ enableCDPDomains()  │ ← DOM.enable, CSS.enable, Page.enable
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ connectNativeHost() │ ← chrome.runtime.connectNative()
└─────────┬───────────┘
          │
          ▼
    Ready for CDP commands
```

**CDP Command Execution:**
```javascript
// Receives from native host
{ type: 'cdp_request', id: 1, method: 'DOM.getDocument', params: {} }

// Executes via chrome.debugger
chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {}, (result) => {
  // Sends back to native host
  sendToNativeHost({ type: 'cdp_response', id: 1, result });
});
```

---

## Data Flow: Complete diagnose_layout Request

```
1. Kiro sends tool call
   ┌─────────────────────────────────────────────────────────┐
   │ { "method": "diagnose_layout", "params": { "selector": "#modal" } } │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼ stdio (JSON-RPC)
                              
2. MCP Server validates & sends CDP commands
   ┌─────────────────────────────────────────────────────────┐
   │ DOM.getDocument → DOM.querySelector → DOM.getBoxModel   │
   │ → Page.getLayoutMetrics → CSS.getComputedStyleForNode   │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼ WebSocket (port 9224)
                              
3. Native Host forwards to extension
   ┌─────────────────────────────────────────────────────────┐
   │ { type: 'cdp_request', id: 1, method: 'DOM.getDocument' }│
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼ Native Messaging (stdio)
                              
4. Extension executes CDP command
   ┌─────────────────────────────────────────────────────────┐
   │ chrome.debugger.sendCommand(tabId, 'DOM.getDocument')   │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼ Chrome Debugger API
                              
5. Browser returns DOM data
   ┌─────────────────────────────────────────────────────────┐
   │ { root: { nodeId: 1, nodeName: '#document', ... } }     │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼ (reverse path)
                              
6. MCP Server analyzes & returns diagnostic
   ┌─────────────────────────────────────────────────────────┐
   │ { element: '#modal', issues: [...], position: {...} }   │
   └─────────────────────────────────────────────────────────┘
```

---

## CDP Commands Used

| Command | Purpose |
|---------|---------|
| `DOM.getDocument` | Get document root node |
| `DOM.querySelector` | Find element by CSS selector |
| `DOM.getBoxModel` | Get element's box model (position, size) |
| `Page.getLayoutMetrics` | Get viewport dimensions |
| `CSS.getComputedStyleForNode` | Get computed CSS styles |

---

## Diagnostic Issue Types

| Issue Type | Severity | Trigger Condition |
|------------|----------|-------------------|
| `offscreen-left` | high | `bounds.left < -2px` |
| `offscreen-right` | high | `bounds.right > viewport.width + 2px` |
| `offscreen-top` | high | `bounds.top < -2px` |
| `offscreen-bottom` | medium | `bounds.bottom > viewport.height + 2px` |
| `completely-offscreen` | high | Element entirely outside viewport |
| `hidden-display` | high | `display: none` |
| `hidden-visibility` | high | `visibility: hidden` |
| `hidden-opacity` | high | `opacity: 0` |
| `low-opacity` | medium | `opacity < 0.1` |
| `zero-dimensions` | medium | `width: 0 && height: 0` |
| `modal-no-zindex` | medium | Positioned element without z-index |
| `modal-low-zindex` | low | `z-index < 100` |
| `modal-not-centered` | low | Fixed element not using centering technique |
| `overflow-hidden` | low | `overflow: hidden` (may clip content) |
| `stacking-context` | low | Creates new stacking context |

---

## Error Handling

### Connection Errors
- **MCP Server can't connect to native host**: Auto-reconnects every 2 seconds
- **Native host not running**: Returns "waiting" status, prompts user to click extension
- **Extension not connected**: Returns clear error message

### CDP Errors
- **Element not found**: Returns selector and suggestion to verify
- **Box model unavailable**: Element may be `display: none`
- **Timeout**: CDP commands timeout after 10 seconds

### Protocol Errors
- **Invalid selector**: Validated before sending to browser
- **Native messaging corruption**: Length-prefix ensures message integrity

---

## File Structure

```
gravity/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts          # MCP server, tool handlers, diagnostics
│   │   └── native-bridge.ts  # WebSocket client for native host
│   ├── build/                # Compiled JavaScript
│   ├── package.json
│   └── tsconfig.json
│
├── native-host/
│   ├── index.js              # Native messaging host
│   ├── com.gravity.json      # Native host manifest
│   ├── gravity-host.bat      # Windows launcher
│   └── package.json
│
├── extension/
│   ├── manifest.json         # Extension manifest (MV3)
│   ├── background.js         # Service worker
│   ├── content.js            # Content script (fallback)
│   ├── popup.html            # Extension popup UI
│   ├── popup.js              # Popup logic
│   └── icon*.svg             # Extension icons
│
├── test.html                 # Test page with layout scenarios
├── readme.md                 # User documentation
└── ARCHITECTURE.md           # This file
```

---

## Security Considerations

1. **Extension Permissions**: Requires `debugger` permission which Chrome warns about
2. **Native Host Allowlist**: Only the specific extension ID can connect
3. **Local Only**: WebSocket server binds to localhost only
4. **No Remote Code**: All code runs locally, no external dependencies at runtime

---

## Future Improvements

1. **Auto-attach debugger** - Remove manual "Connect to Tab" step
2. **Multiple tab support** - Diagnose elements across tabs
3. **Element highlighting** - Visually highlight diagnosed elements in browser
4. **Screenshot capture** - Include visual evidence in diagnostics
5. **Flexbox/Grid diagnostics** - Detect flex/grid layout issues
6. **Animation state detection** - Check if element is mid-animation
7. **Accessibility checks** - Color contrast, focus indicators