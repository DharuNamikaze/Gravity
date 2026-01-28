# Gravity - MCP Server for Browser Layout Diagnostics

An MCP (Model Context Protocol) server that enables AI assistants like Kiro to diagnose CSS layout issues in real browser tabs using Chrome DevTools Protocol (CDP).

## What It Does

Gravity solves a critical problem: **AI assistants can't inspect live DOM elements to debug visual issues**. When a developer says "my modal is not showing" or "this element is off-screen", the AI can now:

1. Connect to the browser via this MCP server
2. Query actual DOM elements using CSS selectors
3. Get real computed styles, positions, and viewport information
4. Diagnose issues (off-screen, hidden, z-index problems, overflow, etc.)
5. Provide actionable fix suggestions

## Quick Start

### Prerequisites
- Node.js 16+
- Chrome/Chromium browser
- Kiro IDE

### Installation

```bash
# 1. Build MCP Server
cd mcp-server
npm install
npm run build

# 2. Install Native Host
cd ../native-host
npm install
```

### Setup

**Windows (PowerShell as Admin):**
```powershell
# 1. Register native host manifest
$manifestPath = "D:\path\to\native-host\com.gravity.json"
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gravity" /ve /t REG_SZ /d "$manifestPath" /f

# 2. Update manifest with absolute paths
# Edit native-host/com.gravity.json:
# - Set "path" to absolute path of gravity-host.bat
# - Set "allowed_origins" to your extension ID
```

**macOS/Linux:**
```bash
# 1. Copy manifest
mkdir -p ~/.config/google-chrome/NativeMessagingHosts/
cp native-host/com.gravity.json ~/.config/google-chrome/NativeMessagingHosts/

# 2. Update paths in the copied manifest
```

**Load Extension:**
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder
5. Note the extension ID

**Update Native Host Manifest:**
Edit `native-host/com.gravity.json`:
```json
{
  "name": "com.gravity",
  "path": "D:\\absolute\\path\\to\\native-host\\gravity-host.bat",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

**Configure Kiro:**
Add to `.kiro/settings/mcp.json`:
```json
{
  "mcpServers": {
    "gravity": {
      "command": "node",
      "args": ["D:\\absolute\\path\\to\\mcp-server\\build\\index.js"],
      "disabled": false
    }
  }
}
```

Restart Kiro.

## Usage

1. Open a webpage in Chrome
2. Click the Gravity extension icon
3. Click "Connect to Tab" (status turns green)
4. In Kiro, ask the AI to diagnose layout issues:
   - "Check if the browser is connected"
   - "Diagnose the #modal element"
   - "Highlight the .button element"

## Available Tools

### `connect_browser`
Check if the browser extension is connected and ready.

### `diagnose_layout`
Analyze a DOM element for layout issues. Returns:
- Element position and dimensions
- Viewport information
- Computed styles
- List of detected issues with severity and suggestions

### `highlight_element`
Visually highlight an element in the browser with a colored overlay.

### `get_element_tree`
Get DOM tree structure (parents, siblings, children) around an element.

### `check_accessibility`
Audit element for accessibility issues (ARIA, contrast, focus).

### `get_computed_layout`
Get detailed layout info (flexbox, grid, margins, padding breakdown).

### `find_overlapping_elements`
Find all elements overlapping a given element.

### `get_event_listeners`
List all event listeners attached to an element.

### `screenshot_element`
Capture screenshot of a specific element.

### `check_responsive`
Test element at different viewport sizes.

## Detected Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| `offscreen-right/left/top/bottom` | high | Element extends beyond viewport |
| `completely-offscreen` | high | Element entirely outside viewport |
| `hidden-display` | high | `display: none` |
| `hidden-visibility` | high | `visibility: hidden` |
| `hidden-opacity` | high | `opacity: 0` |
| `zero-dimensions` | medium | Width and height are 0 |
| `modal-no-zindex` | medium | Positioned element without z-index |
| `modal-low-zindex` | low | `z-index < 100` |
| `overflow-hidden` | low | May clip child content |

## Architecture

```
Kiro/AI ──(MCP)──▶ MCP Server ──(WebSocket)──▶ Native Host ──(Native Messaging)──▶ Chrome Extension ──(CDP)──▶ Browser
```

- **MCP Server** (TypeScript): Exposes tools, validates selectors, analyzes layout data
- **Native Host** (Node.js): Bridges MCP server ↔ Chrome extension via WebSocket
- **Chrome Extension** (MV3): Executes CDP commands via Chrome Debugger API
- **Browser**: Provides DOM data via Chrome DevTools Protocol

## Debugging

**View native host logs:**
```powershell
# Windows
type "$env:TEMP\gravity-host.log" | Select-Object -Last 50

# macOS/Linux
tail -50 /tmp/gravity-host.log
```

**View extension logs:**
1. Go to `chrome://extensions`
2. Click "background page" under Gravity
3. Check Console tab

**Check WebSocket connection:**
```powershell
netstat -ano | findstr "9224"
```

## Project Structure

```
gravity/
├── mcp-server/          # MCP Server (TypeScript)
│   ├── src/
│   │   ├── index.ts     # Main server & tool handlers
│   │   ├── native-bridge.ts  # WebSocket client
│   │   └── tools.ts     # Advanced diagnostic tools
│   └── build/           # Compiled JavaScript
│
├── native-host/         # Native Messaging Host (Node.js)
│   ├── index.js         # Main host process
│   └── com.gravity.json  # Native host manifest
│
├── extension/           # Chrome Extension (MV3)
│   ├── background.js    # Service worker
│   ├── content.js       # Content script
│   ├── popup.html/js    # Extension UI
│   └── manifest.json    # Extension manifest
│
└── test.html            # Test page with layout scenarios
```

## How It Works

1. **User connects tab** → Extension attaches Chrome Debugger API
2. **Extension connects native host** → Native host starts WebSocket server
3. **MCP server connects** → Establishes persistent connection to native host
4. **AI requests diagnosis** → MCP server sends CDP commands through the bridge
5. **Browser responds** → CDP data flows back through native host to MCP server
6. **AI analyzes** → MCP server checks for layout issues and returns suggestions

## Known Limitations

- Manual "Connect to Tab" step required (UX friction)
- Cannot diagnose multiple tabs simultaneously
- No visual highlighting of diagnosed elements (yet)
- Limited to basic layout diagnostics

## Future Improvements

- Auto-attach debugger on first tool call
- Multiple tab support
- Element highlighting with visual overlays
- Screenshot capture with annotations
- Flexbox/Grid-specific diagnostics
- Animation state detection
- Accessibility checks (WCAG compliance)
- Performance metrics

## Troubleshooting

**"Native host not connected"**
- Click "Connect to Tab" in extension popup
- Check that extension is loaded at `chrome://extensions`
- Verify native host manifest is registered

**"Element not found"**
- Verify CSS selector is correct
- Check that element exists in the DOM
- Try a simpler selector (e.g., `#modal` instead of `.modal > div`)

**WebSocket connection fails**
- Check that port 9224 is not in use: `netstat -ano | findstr "9224"`
- Restart the extension
- Check native host logs for errors

**Extension crashes**
- Check extension logs at `chrome://extensions` → service worker
- Restart the extension
- Reload the webpage

## License

MIT