#!/usr/bin/env node
/**
 * DevTools Bridge MCP Server
 *
 * Provides layout diagnostic tools via MCP protocol.
 * Communicates with browser extension through Native Messaging + WebSocket bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { startNativeBridge, stopNativeBridge, sendCDPCommand, ensureConnected, reconnect } from "./native-bridge.js";
import { highlightElement, getElementTree, checkAccessibility, getComputedLayout, findOverlappingElements, getEventListeners, screenshotElement, checkResponsive, findSimilarElements } from "./tools.js";
// ============================================================================
// Diagnostic Helper Functions
// ============================================================================
function extractBounds(boxModel) {
    const left = Math.min(boxModel.content[0], boxModel.content[6]);
    const top = Math.min(boxModel.content[1], boxModel.content[3]);
    const right = Math.max(boxModel.content[2], boxModel.content[4]);
    const bottom = Math.max(boxModel.content[5], boxModel.content[7]);
    return {
        left: Math.round(left),
        top: Math.round(top),
        right: Math.round(right),
        bottom: Math.round(bottom),
        width: Math.round(boxModel.width),
        height: Math.round(boxModel.height),
    };
}
function validateSelector(selector) {
    if (!selector || typeof selector !== "string") {
        return { valid: false, error: "Selector must be a non-empty string" };
    }
    const trimmed = selector.trim();
    if (trimmed.length === 0) {
        return { valid: false, error: "Selector cannot be empty or whitespace only" };
    }
    if (/^[0-9]/.test(trimmed)) {
        return { valid: false, error: "Selector cannot start with a number" };
    }
    const openBrackets = (trimmed.match(/\[/g) || []).length;
    const closeBrackets = (trimmed.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
        return { valid: false, error: "Selector has unbalanced brackets" };
    }
    const openParens = (trimmed.match(/\(/g) || []).length;
    const closeParens = (trimmed.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        return { valid: false, error: "Selector has unbalanced parentheses" };
    }
    return { valid: true };
}
function checkOffscreen(bounds, viewport) {
    const issues = [];
    const THRESHOLD = 2;
    if (bounds.right > viewport.clientWidth + THRESHOLD) {
        const overflow = bounds.right - viewport.clientWidth;
        issues.push({
            type: "offscreen-right",
            severity: "high",
            message: `Element extends ${overflow}px beyond right edge of viewport (${viewport.clientWidth}px)`,
            pixels: overflow,
            suggestion: "Add max-width: 100%, use width: fit-content, or apply overflow: hidden to parent"
        });
    }
    if (bounds.bottom > viewport.clientHeight + THRESHOLD) {
        const overflow = bounds.bottom - viewport.clientHeight;
        issues.push({
            type: "offscreen-bottom",
            severity: "medium",
            message: `Element extends ${overflow}px beyond bottom edge of viewport (${viewport.clientHeight}px)`,
            pixels: overflow,
            suggestion: "Add max-height: 100vh, enable scrolling with overflow: auto, or use position: fixed"
        });
    }
    if (bounds.left < -THRESHOLD) {
        const overflow = Math.abs(bounds.left);
        issues.push({
            type: "offscreen-left",
            severity: "high",
            message: `Element starts ${overflow}px to the left of viewport (negative left position)`,
            pixels: overflow,
            suggestion: "Check left/margin-left values, use left: 0 or transform: translateX(0)"
        });
    }
    if (bounds.top < -THRESHOLD) {
        const overflow = Math.abs(bounds.top);
        issues.push({
            type: "offscreen-top",
            severity: "high",
            message: `Element starts ${overflow}px above viewport (negative top position)`,
            pixels: overflow,
            suggestion: "Check top/margin-top values, use top: 0 or transform: translateY(0)"
        });
    }
    if (bounds.right < 0 || bounds.left > viewport.clientWidth ||
        bounds.bottom < 0 || bounds.top > viewport.clientHeight) {
        issues.push({
            type: "completely-offscreen",
            severity: "high",
            message: "Element is completely outside the visible viewport",
            suggestion: "Check position, transform, and margin values; element may be hidden unintentionally"
        });
    }
    return issues;
}
function checkVisibility(styleMap) {
    const issues = [];
    const display = styleMap.get("display");
    if (display === "none") {
        issues.push({
            type: "hidden-display",
            severity: "high",
            message: "Element has display: none and is not rendered",
            suggestion: "Change to display: block/flex/grid or remove display: none to make visible"
        });
    }
    const visibility = styleMap.get("visibility");
    if (visibility === "hidden") {
        issues.push({
            type: "hidden-visibility",
            severity: "high",
            message: "Element has visibility: hidden (takes up space but invisible)",
            suggestion: "Change to visibility: visible to make element visible"
        });
    }
    if (visibility === "collapse") {
        issues.push({
            type: "hidden-collapse",
            severity: "high",
            message: "Element has visibility: collapse (hidden, may not take up space)",
            suggestion: "Change to visibility: visible to make element visible"
        });
    }
    const opacity = styleMap.get("opacity");
    if (opacity !== undefined) {
        const opacityValue = parseFloat(opacity);
        if (opacityValue === 0) {
            issues.push({
                type: "hidden-opacity",
                severity: "high",
                message: "Element has opacity: 0 (fully transparent)",
                suggestion: "Change to opacity: 1 or remove opacity: 0 to make visible"
            });
        }
        else if (opacityValue < 0.1) {
            issues.push({
                type: "low-opacity",
                severity: "medium",
                message: `Element has very low opacity: ${opacity} (nearly invisible)`,
                suggestion: "Increase opacity value for better visibility"
            });
        }
    }
    const clipPath = styleMap.get("clip-path");
    if (clipPath === "inset(100%)" || clipPath === "circle(0)" || clipPath === "polygon(0 0)") {
        issues.push({
            type: "hidden-clip-path",
            severity: "medium",
            message: `Element is hidden via clip-path: ${clipPath}`,
            suggestion: "Remove or modify clip-path to make element visible"
        });
    }
    const width = styleMap.get("width");
    const height = styleMap.get("height");
    if (width === "0px" && height === "0px") {
        issues.push({
            type: "zero-dimensions",
            severity: "medium",
            message: "Element has zero width and height",
            suggestion: "Set explicit width/height or ensure content can expand the element"
        });
    }
    return issues;
}
function checkModalIssues(styleMap, bounds, viewport) {
    const issues = [];
    const position = styleMap.get("position");
    const zIndex = styleMap.get("z-index");
    const zIndexValue = zIndex ? parseInt(zIndex, 10) : NaN;
    if (position === "fixed" || position === "absolute" || position === "relative") {
        if (zIndex === "auto" || isNaN(zIndexValue)) {
            issues.push({
                type: "modal-no-zindex",
                severity: "medium",
                message: `Positioned element (${position}) has no explicit z-index`,
                suggestion: "Add z-index value (e.g., z-index: 1000) to ensure modal appears above other content"
            });
        }
        else if (zIndexValue < 100) {
            issues.push({
                type: "modal-low-zindex",
                severity: "low",
                message: `Modal has relatively low z-index: ${zIndexValue}`,
                suggestion: "Consider using higher z-index (1000+) for modals to ensure they appear above other positioned elements"
            });
        }
    }
    if (position === "fixed") {
        const left = styleMap.get("left");
        const top = styleMap.get("top");
        const transform = styleMap.get("transform");
        const isCenteredHorizontally = left === "50%" ||
            (transform && transform.includes("translateX(-50%)"));
        const isCenteredVertically = top === "50%" ||
            (transform && transform.includes("translateY(-50%)"));
        const right = styleMap.get("right");
        if (!isCenteredHorizontally && !isCenteredVertically) {
            if (left !== "0px" && left !== "0" && right !== "0px" && right !== "0") {
                issues.push({
                    type: "modal-not-centered",
                    severity: "low",
                    message: "Fixed element may not be properly centered",
                    suggestion: "Use left: 50%; top: 50%; transform: translate(-50%, -50%) for centering"
                });
            }
        }
    }
    const isolation = styleMap.get("isolation");
    const mixBlendMode = styleMap.get("mix-blend-mode");
    const filter = styleMap.get("filter");
    const willChange = styleMap.get("will-change");
    if (isolation === "isolate" ||
        (mixBlendMode && mixBlendMode !== "normal") ||
        (filter && filter !== "none") ||
        (willChange && willChange !== "auto")) {
        issues.push({
            type: "stacking-context",
            severity: "low",
            message: "Element creates a new stacking context which may affect z-index behavior",
            suggestion: "Be aware that z-index is relative to the stacking context, not the document"
        });
    }
    const backgroundColor = styleMap.get("background-color");
    if (backgroundColor && position === "fixed") {
        const isFullWidth = bounds.width >= viewport.clientWidth * 0.9;
        const isFullHeight = bounds.height >= viewport.clientHeight * 0.9;
        if (isFullWidth && isFullHeight) {
            if (!backgroundColor.includes("rgba") && !backgroundColor.includes("hsla") &&
                backgroundColor !== "transparent") {
                issues.push({
                    type: "backdrop-opaque",
                    severity: "low",
                    message: "Full-screen overlay has opaque background",
                    suggestion: "Consider using semi-transparent background (e.g., rgba(0,0,0,0.5)) for backdrop"
                });
            }
        }
    }
    return issues;
}
function checkOverflow(styleMap) {
    const issues = [];
    const overflow = styleMap.get("overflow");
    const overflowX = styleMap.get("overflow-x");
    const overflowY = styleMap.get("overflow-y");
    if (overflow === "hidden" || overflowX === "hidden" || overflowY === "hidden") {
        issues.push({
            type: "overflow-hidden",
            severity: "low",
            message: "Element has overflow: hidden which may clip child content",
            suggestion: "If content is being cut off, change to overflow: auto or overflow: visible"
        });
    }
    if (overflow === "scroll" || overflow === "auto" ||
        overflowX === "scroll" || overflowX === "auto" ||
        overflowY === "scroll" || overflowY === "auto") {
        const scrollType = overflow || `x: ${overflowX}, y: ${overflowY}`;
        issues.push({
            type: "scroll-container",
            severity: "low",
            message: `Element is a scroll container (overflow: ${scrollType})`,
            suggestion: "Ensure scrollable content is accessible and scroll indicators are visible"
        });
    }
    return issues;
}
// ============================================================================
// MCP Server Setup
// ============================================================================
const server = new Server({
    name: "devtools-bridge",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "diagnose_layout",
                description: "Analyzes why a UI element has layout issues using Chrome DevTools Protocol. Returns semantic facts about positioning, overflow, and viewport conflicts.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: {
                            type: "string",
                            description: "CSS selector for the element to diagnose (e.g., '#modal', '.button', 'div.card')",
                        },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "connect_browser",
                description: "Connects to Chrome DevTools. Must be called before diagnose_layout. Requires browser extension to be active.",
                inputSchema: {
                    type: "object",
                    properties: {
                        port: {
                            type: "number",
                            description: "WebSocket port (default: 9224)",
                            default: 9224,
                        },
                    },
                },
            },
            {
                name: "highlight_element",
                description: "Visually highlight an element in the browser with colored overlays.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector to highlight" },
                        color: { type: "string", description: "Color name (default: red)" },
                        duration: { type: "number", description: "Duration in ms (default: 3000)" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "get_element_tree",
                description: "Get DOM tree structure around an element (parents, siblings, children).",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                        depth: { type: "number", description: "Tree depth (default: 3)" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "check_accessibility",
                description: "Audit element for accessibility issues (ARIA, contrast, focus).",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "get_computed_layout",
                description: "Get detailed layout info (flexbox, grid, margins, padding breakdown).",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "find_overlapping_elements",
                description: "Find all elements overlapping a given element.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "get_event_listeners",
                description: "List all event listeners attached to an element.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "screenshot_element",
                description: "Capture screenshot of specific element.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "check_responsive",
                description: "Test element at different viewport sizes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                        breakpoints: {
                            type: "array",
                            items: { type: "number" },
                            description: "Viewport widths to test (default: [320, 768, 1024, 1920])",
                        },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "find_similar_elements",
                description: "Find other elements with similar layout issues.",
                inputSchema: {
                    type: "object",
                    properties: {
                        issueType: {
                            type: "string",
                            description: "Issue type to search for (e.g., 'offscreen-right', 'hidden-display')",
                        },
                    },
                    required: ["issueType"],
                },
            },
        ],
    };
});
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        if (name === "connect_browser") {
            // Try to connect if not already connected
            const connected = await ensureConnected(5000);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: connected ? "connected" : "waiting",
                            message: connected
                                ? "Browser extension is connected and ready"
                                : "Waiting for browser extension to connect. Please click 'Connect to Tab' in the extension popup.",
                            timestamp: new Date().toISOString(),
                        }, null, 2),
                    },
                ],
            };
        }
        if (name === "diagnose_layout") {
            const selector = args?.selector;
            if (!selector) {
                throw new Error("selector is required");
            }
            const selectorValidation = validateSelector(selector);
            if (!selectorValidation.valid) {
                throw new Error(`Invalid CSS selector: ${selectorValidation.error}`);
            }
            // Auto-connect with retry logic
            let connected = await ensureConnected(3000);
            if (!connected) {
                connected = await reconnect(5000);
            }
            if (!connected) {
                throw new Error("Browser extension not connected. Please click 'Connect to Tab' in the extension popup.");
            }
            console.error(`🔍 Diagnosing: ${selector}`);
            // 1. Get document root
            let root;
            try {
                const docResult = await sendCDPCommand("DOM.getDocument", { depth: -1 });
                root = docResult.root;
            }
            catch (error) {
                throw new Error(`Failed to get document: ${error.message}`);
            }
            // 2. Query for element
            let nodeId;
            try {
                const queryResult = await sendCDPCommand("DOM.querySelector", {
                    nodeId: root.nodeId,
                    selector,
                });
                nodeId = queryResult.nodeId;
            }
            catch (error) {
                throw new Error(`Invalid selector or query failed: ${selector} - ${error.message}`);
            }
            if (!nodeId) {
                throw new Error(`Element not found: ${selector}. Verify the selector matches an element in the DOM.`);
            }
            // 3. Get box model
            let model;
            try {
                const boxResult = await sendCDPCommand("DOM.getBoxModel", { nodeId });
                model = boxResult.model;
            }
            catch (error) {
                throw new Error(`Failed to get box model for ${selector}: ${error.message}. Element may be hidden or not rendered.`);
            }
            // 4. Get viewport metrics
            let viewport;
            try {
                const layoutMetrics = await sendCDPCommand("Page.getLayoutMetrics");
                viewport = layoutMetrics.layoutViewport;
            }
            catch (error) {
                throw new Error(`Failed to get viewport metrics: ${error.message}`);
            }
            // 5. Get computed styles
            let styleMap;
            try {
                const { computedStyle } = await sendCDPCommand("CSS.getComputedStyleForNode", { nodeId });
                styleMap = new Map(computedStyle.map((prop) => [prop.name, prop.value]));
            }
            catch (error) {
                throw new Error(`Failed to get computed styles for ${selector}: ${error.message}`);
            }
            // 6. Extract element bounds
            const bounds = extractBounds(model);
            // 7. Run all diagnostic checks
            const allIssues = [];
            const visibilityIssues = checkVisibility(styleMap);
            allIssues.push(...visibilityIssues);
            const offscreenIssues = checkOffscreen(bounds, viewport);
            allIssues.push(...offscreenIssues);
            const modalIssues = checkModalIssues(styleMap, bounds, viewport);
            allIssues.push(...modalIssues);
            const overflowIssues = checkOverflow(styleMap);
            allIssues.push(...overflowIssues);
            // 8. Sort issues by severity
            const severityOrder = { high: 0, medium: 1, low: 2 };
            allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
            // 9. Build diagnostic result
            const result = {
                element: selector,
                timestamp: new Date().toISOString(),
                position: {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                    width: bounds.width,
                    height: bounds.height,
                },
                viewport: {
                    width: viewport.clientWidth,
                    height: viewport.clientHeight,
                },
                computedStyles: {
                    display: styleMap.get("display"),
                    position: styleMap.get("position"),
                    width: styleMap.get("width"),
                    height: styleMap.get("height"),
                    overflow: styleMap.get("overflow"),
                    zIndex: styleMap.get("z-index"),
                    visibility: styleMap.get("visibility"),
                    opacity: styleMap.get("opacity"),
                },
                issues: allIssues.length > 0 ? allIssues : [
                    {
                        type: "none",
                        severity: "low",
                        message: "No layout issues detected",
                        suggestion: "Element appears to be positioned correctly within viewport",
                    },
                ],
                confidence: allIssues.length > 0 ? 0.95 : 0.85,
                summary: {
                    totalIssues: allIssues.length,
                    highSeverity: allIssues.filter(i => i.severity === "high").length,
                    mediumSeverity: allIssues.filter(i => i.severity === "medium").length,
                    lowSeverity: allIssues.filter(i => i.severity === "low").length,
                },
            };
            console.error(`✅ Found ${allIssues.length} issue(s)`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        // New tools
        if (name === "highlight_element") {
            const selector = args?.selector;
            const color = args?.color || "red";
            const duration = args?.duration || 3000;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await highlightElement(selector, color, duration);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "get_element_tree") {
            const selector = args?.selector;
            const depth = args?.depth || 3;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await getElementTree(selector, depth);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "check_accessibility") {
            const selector = args?.selector;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await checkAccessibility(selector);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "get_computed_layout") {
            const selector = args?.selector;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await getComputedLayout(selector);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "find_overlapping_elements") {
            const selector = args?.selector;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await findOverlappingElements(selector);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "get_event_listeners") {
            const selector = args?.selector;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await getEventListeners(selector);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "screenshot_element") {
            const selector = args?.selector;
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await screenshotElement(selector);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "check_responsive") {
            const selector = args?.selector;
            const breakpoints = args?.breakpoints || [320, 768, 1024, 1920];
            if (!selector)
                throw new Error("selector is required");
            await ensureConnected(5000);
            const result = await checkResponsive(selector, breakpoints);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        if (name === "find_similar_elements") {
            const issueType = args?.issueType;
            if (!issueType)
                throw new Error("issueType is required");
            await ensureConnected(5000);
            const result = await findSimilarElements(issueType);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    catch (error) {
        console.error(`❌ Error in ${name}:`, error);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: error.message,
                        tool: name,
                        timestamp: new Date().toISOString(),
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
});
// ============================================================================
// Main Entry Point
// ============================================================================
async function main() {
    // Start MCP server FIRST to establish stdio transport
    const transport = new StdioServerTransport();
    // Connect MCP server before doing anything else
    await server.connect(transport);
    // NOW start the WebSocket server for native host connections
    try {
        await startNativeBridge(9224);
    }
    catch (error) {
        console.error('Failed to start native bridge:', error);
        process.exit(1);
    }
    console.error("🚀 DevTools Bridge MCP Server running");
    // Graceful shutdown
    const shutdown = () => {
        console.error("🛑 Shutting down...");
        stopNativeBridge();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((error) => {
    console.error("Fatal error:", error);
    stopNativeBridge();
    process.exit(1);
});
