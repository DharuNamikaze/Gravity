# DevTools Bridge

An MCP server that enables AI assistants to diagnose UI layout issues using Chrome DevTools Protocol.

## Architecture

```
Kiro IDE ↔ MCP Server ↔ WebSocket ↔ Native Host ↔ Native Messaging ↔ Chrome Extension ↔ Browser
```

## Quick Start

### 1. Install Dependencies

```bash
# MCP Server
cd mcp-server
npm install
npm run build

# Native Host
cd ../native-host
npm install
```

### 2. Load Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder
5. **Copy the Extension ID** (e.g., `abcdefghijklmnopqrstuvwxyz123456`)

### 3. Configure Native Messaging Host

#### Windows

1. Edit `native-host/com.devtools.bridge.json`:
   - Replace `REPLACE_WITH_ABSOLUTE_PATH` with the full path to your project
   - Replace `REPLACE_WITH_EXTENSION_ID` with your extension ID

   Example:
   ```json
   {
     "name": "com.devtools.bridge",
     "description": "DevTools Bridge Native Messaging Host",
     "path": "C:\\Users\\YourName\\Projects\\devtools-bridge\\native-host\\devtools-bridge-host.bat",
     "type": "stdio",
     "allowed_origins": [
       "chrome-extension://abcdefghijklmnopqrstuvwxyz123456/"
     ]
   }
   ```

2. Register the manifest in Windows Registry:
   ```cmd
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.devtools.bridge" /ve /t REG_SZ /d "C:\path\to\native-host\com.devtools.bridge.json" /f
   ```

#### macOS

1. Edit `native-host/com.devtools.bridge.json` with absolute path and extension ID

2. Copy manifest to Chrome's native messaging hosts directory:
   ```bash
   mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts
   cp native-host/com.devtools.bridge.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   ```

3. Make the native host executable:
   ```bash
   chmod +x native-host/index.js
   ```

#### Linux

1. Edit `native-host/com.devtools.bridge.json` with absolute path and extension ID

2. Copy manifest:
   ```bash
   mkdir -p ~/.config/google-chrome/NativeMessagingHosts
   cp native-host/com.devtools.bridge.json ~/.config/google-chrome/NativeMessagingHosts/
   ```

3. Make executable:
   ```bash
   chmod +x native-host/index.js
   ```

### 4. Configure Kiro MCP

Add to your Kiro MCP configuration (`.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "devtools-bridge": {
      "command": "node",
      "args": ["C:/path/to/mcp-server/build/index.js"]
    }
  }
}
```

### 5. Usage

1. **Start the MCP server** (Kiro does this automatically)

2. **Connect the browser extension**:
   - Navigate to a webpage you want to diagnose
   - Click the DevTools Bridge extension icon
   - Click "Connect to Tab"

3. **Use in Kiro**:
   ```
   Diagnose the layout of #modal
   ```

   Or call the tool directly:
   ```
   diagnose_layout selector="#modal"
   ```

## Tools

### `diagnose_layout`

Analyzes a DOM element for layout issues.

**Parameters:**
- `selector` (required): CSS selector for the element (e.g., `#modal`, `.button`)

**Returns:**
- Element position and dimensions
- Viewport information
- Computed styles
- Detected issues with severity and suggestions

**Example Response:**
```json
{
  "element": "#modal",
  "position": { "left": 100, "top": 50, "width": 400, "height": 300 },
  "viewport": { "width": 1920, "height": 1080 },
  "issues": [
    {
      "type": "offscreen-right",
      "severity": "high",
      "message": "Element extends 50px beyond right edge",
      "suggestion": "Add max-width: 100%"
    }
  ]
}
```

### `connect_browser`

Checks browser connection status.

**Parameters:**
- `port` (optional): WebSocket port (default: 9224)

## Troubleshooting

### Native host not connecting

1. Check the extension ID in `com.devtools.bridge.json` matches your installed extension
2. Verify the path in the manifest is absolute and correct
3. Check the native host log:
   - Windows: `%TEMP%\devtools-bridge-host.log`
   - macOS/Linux: `/tmp/devtools-bridge-host.log`

### CDP commands failing

1. Ensure the debugger is attached (check extension popup)
2. Make sure you're not on a `chrome://` or `chrome-extension://` page
3. Try disconnecting and reconnecting

### MCP server not receiving messages

1. Verify the WebSocket server is running on port 9224
2. Check that the native host can connect to `ws://localhost:9224`
3. Look for errors in the MCP server output

## Development

### Project Structure

```
devtools-bridge/
├── extension/           # Chrome extension
│   ├── manifest.json
│   ├── background.js    # Native messaging + debugger
│   ├── popup.html/js    # UI for connection
│   └── content.js       # Fallback diagnostics
├── native-host/         # Native messaging bridge
│   ├── index.js         # stdio ↔ WebSocket bridge
│   ├── package.json
│   └── com.devtools.bridge.json  # Manifest template
├── mcp-server/          # MCP server
│   ├── src/
│   │   ├── index.ts     # MCP tools + diagnostics
│   │   └── native-bridge.ts  # WebSocket server
│   └── package.json
└── README.md
```

### Building

```bash
# Build MCP server
cd mcp-server
npm run build

# Watch mode for development
npm run dev
```

## License

MIT
