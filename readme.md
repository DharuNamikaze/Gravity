   # DevTools Bridge MCP Server

   An MCP (Model Context Protocol) server that enables AI assistants like Kiro to diagnose CSS layout issues in real browser tabs using Chrome DevTools Protocol.

   ## Project Goal

   **Enable AI assistants to debug visual/layout issues in web pages by directly inspecting live DOM elements in the browser.**

   When a developer says "my modal is not showing" or "this element is off-screen", the AI can:
   1. Connect to the browser via this MCP server
   2. Query the actual DOM element using CSS selectors
   3. Get real computed styles, positions, and viewport information
   4. Diagnose issues (off-screen, hidden, z-index problems, etc.)
   5. Provide actionable fix suggestions

   ## Architecture

   ```
   ┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
   │   Kiro/AI   │────▶│ MCP Server  │────▶│ Native Host  │────▶│  Chrome     │
   │   Client    │ MCP │  (Client)   │ WS  │   (Server)   │ NM  │  Extension  │
   └─────────────┘     └─────────────┘     └──────────────┘     └─────────────┘
         │                  │                    │                    │
         │ stdio            │ ws://localhost     │ Native Messaging   │ chrome.debugger
         │ (JSON-RPC)       │ :9224              │ (length-prefixed)  │ API
         │                  │                    │                    │
         ▼                  ▼                    ▼                    ▼
      Tool calls        WebSocket client     WebSocket server     CDP commands
      from AI           (reconnects on       Persistent bridge    to inspect
                        restart)             process              live DOM
   ```

   ### Why This Architecture?

   Chrome extensions cannot directly communicate with external processes. The bridge is necessary:

   1. **MCP Server** - Speaks MCP protocol to Kiro, runs WebSocket server for native host
   2. **Native Host** - Chrome's Native Messaging allows extensions to talk to local executables
   3. **Extension** - Has privileged access to `chrome.debugger` API for CDP commands

   ## Components

   ### 1. MCP Server (`mcp-server/`)
   - TypeScript MCP server using `@modelcontextprotocol/sdk`
   - Exposes two tools: `connect_browser` and `diagnose_layout`
   - Runs WebSocket server on port 9224
   - Sends CDP commands through native host → extension → browser

   ### 2. Native Messaging Host (`native-host/`)
   - Node.js process spawned by Chrome when extension connects
   - Bridges stdio (Chrome Native Messaging) ↔ WebSocket (MCP server)
   - Handles message framing (4-byte length prefix for Native Messaging)

   ### 3. Chrome Extension (`extension/`)
   - Manifest V3 service worker extension
   - Attaches Chrome Debugger API to target tab
   - Enables DOM, CSS, Page CDP domains
   - Executes CDP commands and returns results

   ## MCP Tools

   ### `connect_browser`
   Check if the browser extension is connected and ready.

   ```json
   // Input
   { "port": 9224 }

   // Output
   {
   "status": "connected",
   "message": "Browser extension is connected and ready"
   }
   ```

   ### `diagnose_layout`
   Analyze a DOM element for layout issues.

   ```json
   // Input
   { "selector": "#modal" }

   // Output
   {
   "element": "#modal",
   "position": { "left": 100, "top": 50, "width": 400, "height": 300 },
   "viewport": { "width": 1920, "height": 1080 },
   "computedStyles": {
      "display": "block",
      "position": "fixed",
      "zIndex": "1000",
      "visibility": "visible"
   },
   "issues": [
      {
         "type": "offscreen-right",
         "severity": "high",
         "message": "Element extends 200px beyond right edge of viewport",
         "suggestion": "Add max-width: 100% or use width: fit-content"
      }
   ]
   }
   ```

   ### Detected Issues

   | Issue Type | Severity | Description |
   |------------|----------|-------------|
   | `offscreen-right/left/top/bottom` | high | Element extends beyond viewport |
   | `completely-offscreen` | high | Element entirely outside viewport |
   | `hidden-display` | high | `display: none` |
   | `hidden-visibility` | high | `visibility: hidden` |
   | `hidden-opacity` | high | `opacity: 0` |
   | `zero-dimensions` | medium | Width and height are 0 |
   | `modal-no-zindex` | medium | Positioned element without z-index |
   | `overflow-hidden` | low | May clip child content |

   ---

   ## Solved: MCP Server Process Lifecycle

   **Status:** ✅ RESOLVED via Inverted Connection Logic

   Previously, Kiro's tendency to restart MCP processes would kill the WebSocket server. By moving the server role to the **Native Host**, we've decoupled the ephemeral tools from the persistent browser connection.

   ---

   ## Known Issues & Challenges

   ### 🟡 Medium: Native Host Spawning Delay

   **Problem:** Chrome spawns a new native host process each time the extension connects. There's a ~500ms delay before the WebSocket connection is established.

   **Mitigation:** Native host auto-reconnects with 1-second retry interval.

   ### 🟡 Medium: Extension Service Worker Lifecycle

   **Problem:** Manifest V3 service workers can be terminated by Chrome when idle, which disconnects the native messaging port.

   **Mitigation:** The extension reconnects native host when debugger is attached.

   ### 🟢 Low: Debugger Attachment UX

   **Problem:** User must manually click "Connect to Tab" in extension popup before tools work.

   **Potential Solution:** Auto-attach on first `diagnose_layout` call, or provide better error messages.

   ---

   ## Setup Instructions

   ### 1. Install Dependencies

   ```bash
   # MCP Server
   cd mcp-server
   npm install
   npm run build

   # Native Host  
   cd native-host
   npm install
   ```

   ### 2. Register Native Messaging Host

   **Windows (PowerShell as Admin):**
   ```powershell
   # Edit native-host/com.devtools.bridge.json - update "path" to absolute path
   # Then register:
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.devtools.bridge" /ve /t REG_SZ /d "D:\path\to\native-host\com.devtools.bridge.json" /f
   ```

   **macOS:**
   ```bash
   mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   cp native-host/com.devtools.bridge.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   # Edit the copied file to update "path" to absolute path
   ```

   **Linux:**
   ```bash
   mkdir -p ~/.config/google-chrome/NativeMessagingHosts/
   cp native-host/com.devtools.bridge.json ~/.config/google-chrome/NativeMessagingHosts/
   # Edit the copied file to update "path" to absolute path
   ```

   ### 3. Load Chrome Extension

   1. Open `chrome://extensions`
   2. Enable "Developer mode" (top right)
   3. Click "Load unpacked"
   4. Select the `extension/` folder
   5. Note the extension ID (needed for native host manifest)

   ### 4. Update Native Host Manifest

   Edit `native-host/com.devtools.bridge.json`:
   ```json
   {
   "name": "com.devtools.bridge",
   "description": "DevTools Bridge Native Messaging Host",
   "path": "D:\\absolute\\path\\to\\native-host\\devtools-bridge-host.bat",
   "type": "stdio",
   "allowed_origins": [
      "chrome-extension://YOUR_EXTENSION_ID/"
   ]
   }
   ```

   ### 5. Configure Kiro MCP

   Add to `.kiro/settings/mcp.json`:
   ```json
   {
   "mcpServers": {
      "devtools-bridge": {
         "command": "node",
         "args": ["D:\\absolute\\path\\to\\mcp-server\\build\\index.js"],
         "disabled": false
      }
   }
   }
   ```

   ### 6. Restart Kiro

   Restart Kiro to load the MCP server configuration.

   ---

   ## Usage

   1. Open a webpage in Chrome
   2. Click the DevTools Bridge extension icon in toolbar
   3. Click "Connect to Tab" - status should turn green
   4. In Kiro, use the tools:
      - "Check browser connection" → `connect_browser`
      - "Diagnose the #modal element" → `diagnose_layout`

   ---

   ## Debugging

   ### Native Host Logs

   ```powershell
   # Windows
   type "$env:TEMP\devtools-bridge-host.log" | Select-Object -Last 30

   # macOS/Linux
   tail -30 /tmp/devtools-bridge-host.log
   ```

   ### Extension Logs

   1. Go to `chrome://extensions`
   2. Find "DevTools Bridge"
   3. Click "service worker" link
   4. Check Console tab for logs

   ### MCP Server

   The MCP server logs to stderr, which Kiro captures. Check Kiro's output panel for MCP server logs.

   ### Check WebSocket Connection

   ```powershell
   # See if port 9224 is listening
   netstat -ano | findstr "9224"
   ```

   ---

   ## File Structure

   ```
   ├── extension/
   │   ├── manifest.json      # Extension manifest (MV3)
   │   ├── background.js      # Service worker - debugger & native messaging
   │   ├── content.js         # Content script (fallback diagnostics)
   │   ├── popup.html/js      # Extension popup UI
   │   └── icon*.svg          # Extension icons
   │
   ├── native-host/
   │   ├── index.js           # Native messaging host
   │   ├── com.devtools.bridge.json  # Native host manifest
   │   ├── devtools-bridge-host.bat  # Windows launcher
   │   └── package.json
   │
   ├── mcp-server/
   │   ├── src/
   │   │   ├── index.ts       # MCP server & tool handlers
   │   │   └── native-bridge.ts  # WebSocket server for native host
   │   ├── build/             # Compiled JS
   │   ├── package.json
   │   └── tsconfig.json
   │
   ├── test.html              # Test page with various layout scenarios
   └── readme.md              # This file
   ```

   ---

   ## Future Improvements

   1. **Fix MCP process lifecycle issue** - Most critical for reliability
   2. **Add retry/wait logic** - Handle reconnection delays gracefully
   3. **Auto-attach debugger** - Remove manual "Connect to Tab" step
   4. **More diagnostic checks** - Flexbox issues, grid problems, animation states
   5. **Element highlighting** - Visually highlight diagnosed elements
   6. **Multiple element support** - Diagnose multiple selectors at once
   7. **Screenshot capture** - Include visual evidence in diagnostics