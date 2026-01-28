# Gravity - Setup Guide

## Installation

### Option 1: Using CLI (Recommended)

```bash
npm install -g gravity/cli
gravity install --ide kiro
```

### Option 2: Manual Installation

#### Step 1: Install MCP Server

```bash
npm install @gravity/mcp-server
```

#### Step 2: Install Native Host

```bash
npm install @gravity/native-host
```

#### Step 3: Load Chrome Extension

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the extension folder
5. Note the extension ID

#### Step 4: Register Native Host

**Windows (PowerShell as Admin):**
```powershell
gravity register --extension-id YOUR_EXTENSION_ID
```

**macOS/Linux:**
```bash
gravity register --extension-id YOUR_EXTENSION_ID
```

#### Step 5: Configure IDE

**Kiro:**
```json
{
  "mcpServers": {
    "gravity": {
      "command": "node",
      "args": ["path/to/mcp-server/build/index.js"],
      "disabled": false
    }
  }
}
```

**VSCode:**
```json
{
  "gravity.mcp.enabled": true,
  "gravity.mcp.serverPath": "path/to/mcp-server/build/index.js"
}
```

**Cursor:**
```json
{
  "gravity.enabled": true,
  "gravity.mcp.serverPath": "path/to/mcp-server/build/index.js"
}
```

---

## Verification

```bash
gravity verify
```

This will check:
- ✓ Node.js version
- ✓ Chrome/Chromium installation
- ✓ MCP server installation
- ✓ Native host installation
- ✓ Extension loaded
- ✓ Native host registered
- ✓ WebSocket connection

---

## Troubleshooting

### "Native host not connected"
1. Click "Connect to Tab" in extension popup
2. Check native host logs: `tail -f /tmp/gravity-host.log`
3. Verify native host is registered: `gravity verify`

### "Extension not found"
1. Go to `chrome://extensions`
2. Verify extension is loaded
3. Check extension ID matches native host manifest

### "Port 9224 already in use"
1. Find process using port: `lsof -i :9224`
2. Kill process: `kill -9 <PID>`
3. Restart native host

### "MCP server not responding"
1. Check MCP server is running
2. Check IDE configuration
3. Restart IDE

---

## Configuration

### Environment Variables

```bash
# MCP Server
GRAVITY_MCP_PORT=9224
GRAVITY_MCP_DEBUG=true

# Native Host
GRAVITY_NATIVE_HOST_PORT=9224
GRAVITY_NATIVE_HOST_LOG=/tmp/gravity.log

# Extension
GRAVITY_EXTENSION_ID=your-extension-id
```

### Configuration File

`~/.gravity/config.json`:
```json
{
  "mcp": {
    "port": 9224,
    "debug": false,
    "timeout": 10000
  },
  "nativeHost": {
    "port": 9224,
    "logFile": "/tmp/gravity.log"
  },
  "extension": {
    "id": "your-extension-id",
    "autoConnect": false
  }
}
```

---

## Development

### Building from Source

```bash
# Clone repository
git clone https://github.com/gravity-ai/gravity.git
cd gravity

# Install dependencies
npm install

# Build all packages
npm run build

# Watch mode
npm run dev

# Run tests
npm run test
```

### Project Structure

```
packages/
├── mcp-server/      # MCP Server (TypeScript)
├── native-host/     # Native Host (Node.js)
├── extension/       # Chrome Extension
└── cli/             # CLI Tool
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm run test`
5. Submit a pull request

---

## Uninstallation

```bash
# Using CLI
gravity uninstall

# Manual
npm uninstall -g @gravity/cli
npm uninstall @gravity/mcp-server
npm uninstall @gravity/native-host

# Remove extension
# Go to chrome://extensions and click "Remove"

# Remove native host registration
# Windows: Delete registry key
# macOS/Linux: Delete manifest file
```

---

## Support

- Documentation: https://github.com/gravity-ai/gravity/docs
- Issues: https://github.com/gravity-ai/gravity/issues
- Discussions: https://github.com/gravity-ai/gravity/discussions