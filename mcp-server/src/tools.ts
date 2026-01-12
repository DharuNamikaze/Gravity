/**
 * Additional DevTools Bridge Tools
 * 
 * Implements advanced diagnostic and inspection tools:
 * - highlight_element
 * - get_element_tree
 * - check_accessibility
 * - get_computed_layout
 * - find_overlapping_elements
 * - get_event_listeners
 * - screenshot_element
 * - check_responsive
 * - find_similar_elements
 */

import { sendCDPCommand, isNativeHostConnected, ensureConnected, reconnect } from "./native-bridge.js";

// ============================================================================
// Connection Helper with Retry Logic
// ============================================================================

/**
 * Ensure connection with automatic reconnection on failure
 * Tries to connect, and if that fails, attempts to reconnect
 */
async function ensureConnectionWithRetry(maxRetries: number = 2): Promise<void> {
  let connected = isNativeHostConnected();
  
  if (!connected) {
    // Try to ensure connection first
    connected = await ensureConnected(3000);
  }
  
  if (!connected && maxRetries > 0) {
    // Try to reconnect
    console.error('Connection lost, attempting to reconnect...');
    connected = await reconnect(5000);
  }
  
  if (!connected) {
    throw new Error('Browser extension not connected. Please click "Connect to Tab" in the extension popup.');
  }
}

// ============================================================================
// 1. Highlight Element
// ============================================================================

export async function highlightElement(
  selector: string,
  color: string = "red",
  duration: number = 3000
): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  
  // Highlight via CDP
  await sendCDPCommand("DOM.highlightNode", {
    nodeId,
    highlightConfig: {
      showInfo: true,
      contentColor: { r: 255, g: 0, b: 0, a: 0.3 },
      paddingColor: { r: 0, g: 255, b: 0, a: 0.3 },
      borderColor: { r: 0, g: 0, b: 255, a: 0.5 },
      marginColor: { r: 255, g: 255, b: 0, a: 0.3 }
    }
  });
  
  // Auto-hide after duration
  if (duration > 0) {
    setTimeout(async () => {
      try {
        await sendCDPCommand("DOM.hideHighlight", {});
      } catch (e) {
        // Ignore if already hidden
      }
    }, duration);
  }
  
  return {
    success: true,
    selector,
    message: `Element highlighted for ${duration}ms`,
    color
  };
}

// ============================================================================
// 2. Get Element Tree
// ============================================================================

export async function getElementTree(
  selector: string,
  depth: number = 3
): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  
  // Get parent chain
  const parents = await getParentChain(nodeId, depth);
  
  // Get children
  const children = await getChildren(nodeId, depth);
  
  // Get siblings
  const siblings = await getSiblings(nodeId);
  
  return {
    selector,
    element: {
      nodeId,
      nodeName: await getNodeName(nodeId)
    },
    parents,
    siblings,
    children,
    depth
  };
}

async function getParentChain(nodeId: number, maxDepth: number): Promise<any[]> {
  const chain = [];
  let currentId = nodeId;
  
  for (let i = 0; i < maxDepth; i++) {
    try {
      const parent = await sendCDPCommand("DOM.getParentNode", { nodeId: currentId });
      if (!parent || !parent.parentId) break;
      
      const node = await sendCDPCommand("DOM.describeNode", { nodeId: parent.parentId });
      chain.push({
        nodeId: parent.parentId,
        nodeName: node.node.nodeName,
        className: node.node.attributes?.find((a: string, i: number) => a === "class") 
          ? node.node.attributes[i + 1] 
          : undefined
      });
      
      currentId = parent.parentId;
    } catch (e) {
      break;
    }
  }
  
  return chain;
}

async function getChildren(nodeId: number, maxDepth: number): Promise<any[]> {
  try {
    const result = await sendCDPCommand("DOM.requestChildNodes", { nodeId, depth: maxDepth });
    const node = await sendCDPCommand("DOM.describeNode", { nodeId });
    
    return (node.node.children || []).map((child: any) => {
      const classIndex = child.attributes?.findIndex((a: string) => a === "class");
      return {
        nodeId: child.nodeId,
        nodeName: child.nodeName,
        className: classIndex !== undefined && classIndex >= 0 ? child.attributes[classIndex + 1] : undefined
      };
    });
  } catch (e) {
    return [];
  }
}

async function getSiblings(nodeId: number): Promise<any[]> {
  try {
    const parent = await sendCDPCommand("DOM.getParentNode", { nodeId });
    if (!parent?.parentId) return [];
    
    const node = await sendCDPCommand("DOM.describeNode", { nodeId: parent.parentId });
    const siblings = (node.node.children || [])
      .filter((child: any) => child.nodeId !== nodeId)
      .map((child: any) => {
        const classIndex = child.attributes?.findIndex((a: string) => a === "class");
        return {
          nodeId: child.nodeId,
          nodeName: child.nodeName,
          className: classIndex !== undefined && classIndex >= 0 ? child.attributes[classIndex + 1] : undefined
        };
      });
    
    return siblings;
  } catch (e) {
    return [];
  }
}

// ============================================================================
// 3. Check Accessibility
// ============================================================================

export async function checkAccessibility(selector: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  const node = await sendCDPCommand("DOM.describeNode", { nodeId });
  const styles = await sendCDPCommand("CSS.getComputedStyleForNode", { nodeId });
  
  const issues = [];
  const styleMap = new Map(styles.computedStyle.map((s: any) => [s.name, s.value]));
  
  // Check ARIA attributes
  const ariaLabelIndex = node.node.attributes?.findIndex((a: string) => a === "aria-label");
  const ariaLabel = ariaLabelIndex !== undefined && ariaLabelIndex >= 0 ? node.node.attributes[ariaLabelIndex + 1] : null;
  
  const ariaRoleIndex = node.node.attributes?.findIndex((a: string) => a === "role");
  const ariaRole = ariaRoleIndex !== undefined && ariaRoleIndex >= 0 ? node.node.attributes[ariaRoleIndex + 1] : null;
  
  if (!ariaLabel && !ariaRole && ["BUTTON", "A", "INPUT"].includes(node.node.nodeName)) {
    issues.push({
      type: "missing-aria",
      severity: "high",
      message: `${node.node.nodeName} element missing aria-label or role`,
      suggestion: "Add aria-label or role attribute for screen readers"
    });
  }
  
  // Check color contrast (simplified)
  const color = styleMap.get("color");
  const backgroundColor = styleMap.get("background-color");
  if (color && backgroundColor) {
    issues.push({
      type: "contrast-check",
      severity: "medium",
      message: "Manual contrast check recommended",
      suggestion: "Use WebAIM contrast checker to verify WCAG AA compliance",
      color,
      backgroundColor
    });
  }
  
  // Check focus visibility
  const outline = styleMap.get("outline");
  if (outline === "none") {
    issues.push({
      type: "no-focus-outline",
      severity: "medium",
      message: "Element has outline: none (may hide focus indicator)",
      suggestion: "Provide alternative focus indicator via box-shadow or border"
    });
  }
  
  return {
    selector,
    nodeName: node.node.nodeName,
    ariaLabel,
    ariaRole,
    issues,
    summary: {
      totalIssues: issues.length,
      highSeverity: issues.filter(i => i.severity === "high").length,
      mediumSeverity: issues.filter(i => i.severity === "medium").length
    }
  };
}

// ============================================================================
// 4. Get Computed Layout
// ============================================================================

export async function getComputedLayout(selector: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  const boxModel = await sendCDPCommand("DOM.getBoxModel", { nodeId });
  const styles = await sendCDPCommand("CSS.getComputedStyleForNode", { nodeId });
  
  const styleMap = new Map(styles.computedStyle.map((s: any) => [s.name, s.value]));
  
  const model = boxModel.model;
  
  return {
    selector,
    boxModel: {
      content: {
        width: model.width,
        height: model.height
      },
      padding: {
        top: model.padding[1],
        right: model.padding[2],
        bottom: model.padding[5],
        left: model.padding[0]
      },
      border: {
        top: model.border[1],
        right: model.border[2],
        bottom: model.border[5],
        left: model.border[0]
      },
      margin: {
        top: model.margin[1],
        right: model.margin[2],
        bottom: model.margin[5],
        left: model.margin[0]
      }
    },
    display: styleMap.get("display"),
    position: styleMap.get("position"),
    flexbox: {
      display: styleMap.get("display"),
      flexDirection: styleMap.get("flex-direction"),
      justifyContent: styleMap.get("justify-content"),
      alignItems: styleMap.get("align-items"),
      gap: styleMap.get("gap")
    },
    grid: {
      display: styleMap.get("display"),
      gridTemplateColumns: styleMap.get("grid-template-columns"),
      gridTemplateRows: styleMap.get("grid-template-rows"),
      gap: styleMap.get("gap")
    }
  };
}

// ============================================================================
// 5. Find Overlapping Elements
// ============================================================================

export async function findOverlappingElements(selector: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  const boxModel = await sendCDPCommand("DOM.getBoxModel", { nodeId });
  const bounds = boxModel.model;
  
  // Get all elements and check for overlap
  const doc = await sendCDPCommand("DOM.getDocument", { depth: -1 });
  const allElements = await getAllElements(doc.root.nodeId);
  
  const overlapping = [];
  
  for (const elem of allElements) {
    if (elem.nodeId === nodeId) continue;
    
    try {
      const elemBox = await sendCDPCommand("DOM.getBoxModel", { nodeId: elem.nodeId });
      const elemBounds = elemBox.model;
      
      // Check if overlaps
      if (checkOverlap(bounds, elemBounds)) {
        const zIndex = await getZIndex(elem.nodeId);
        overlapping.push({
          nodeId: elem.nodeId,
          nodeName: elem.nodeName,
          className: elem.className,
          zIndex,
          bounds: {
            left: elemBounds.content[0],
            top: elemBounds.content[1],
            width: elemBounds.width,
            height: elemBounds.height
          }
        });
      }
    } catch (e) {
      // Skip elements that can't be measured
    }
  }
  
  return {
    selector,
    targetBounds: {
      left: bounds.content[0],
      top: bounds.content[1],
      width: bounds.width,
      height: bounds.height
    },
    overlappingElements: overlapping.sort((a, b) => {
      const aZ = typeof a.zIndex === 'number' ? a.zIndex : 0;
      const bZ = typeof b.zIndex === 'number' ? b.zIndex : 0;
      return bZ - aZ;
    }),
    count: overlapping.length
  };
}

function checkOverlap(bounds1: any, bounds2: any): boolean {
  const left1 = bounds1.content[0];
  const top1 = bounds1.content[1];
  const right1 = left1 + bounds1.width;
  const bottom1 = top1 + bounds1.height;
  
  const left2 = bounds2.content[0];
  const top2 = bounds2.content[1];
  const right2 = left2 + bounds2.width;
  const bottom2 = top2 + bounds2.height;
  
  return !(right1 < left2 || right2 < left1 || bottom1 < top2 || bottom2 < top1);
}

// ============================================================================
// 6. Get Event Listeners
// ============================================================================

export async function getEventListeners(selector: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  
  try {
    const listeners = await sendCDPCommand("DOMDebugger.getEventListeners", { objectId: nodeId.toString() });
    
    return {
      selector,
      nodeId,
      listeners: listeners.listeners || [],
      summary: {
        totalListeners: (listeners.listeners || []).length,
        byType: groupBy(listeners.listeners || [], (l: any) => l.type)
      }
    };
  } catch (e) {
    // Fallback: return empty if DOMDebugger not available
    return {
      selector,
      nodeId,
      listeners: [],
      message: "Event listeners not available via CDP",
      suggestion: "Use browser DevTools to inspect event listeners"
    };
  }
}

// ============================================================================
// 7. Screenshot Element
// ============================================================================

export async function screenshotElement(selector: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const nodeId = await getNodeId(selector);
  const boxModel = await sendCDPCommand("DOM.getBoxModel", { nodeId });
  
  const bounds = boxModel.model;
  const clip = {
    x: bounds.content[0],
    y: bounds.content[1],
    width: bounds.width,
    height: bounds.height,
    scale: 1
  };
  
  try {
    const screenshot = await sendCDPCommand("Page.captureScreenshot", {
      clip,
      format: "png"
    });
    
    return {
      selector,
      success: true,
      screenshot: `data:image/png;base64,${screenshot.data}`,
      bounds: {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height
      }
    };
  } catch (e) {
    return {
      selector,
      success: false,
      error: "Screenshot capture failed",
      suggestion: "Element may be off-screen or not renderable"
    };
  }
}

// ============================================================================
// 8. Check Responsive
// ============================================================================

export async function checkResponsive(
  selector: string,
  breakpoints: number[] = [320, 768, 1024, 1920]
): Promise<any> {
  await ensureConnectionWithRetry();
  
  const results = [];
  
  for (const width of breakpoints) {
    try {
      // Set viewport
      await sendCDPCommand("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
        hasTouch: false
      });
      
      // Get element bounds at this viewport
      const nodeId = await getNodeId(selector);
      const boxModel = await sendCDPCommand("DOM.getBoxModel", { nodeId });
      const viewport = await sendCDPCommand("Page.getLayoutMetrics", {});
      
      const bounds = boxModel.model;
      const issues = [];
      
      // Check if offscreen at this breakpoint
      if (bounds.content[0] + bounds.width > viewport.layoutViewport.clientWidth) {
        issues.push({
          type: "offscreen-right",
          message: `Element extends beyond viewport at ${width}px`
        });
      }
      
      results.push({
        breakpoint: width,
        bounds: {
          left: bounds.content[0],
          top: bounds.content[1],
          width: bounds.width,
          height: bounds.height
        },
        issues
      });
    } catch (e) {
      results.push({
        breakpoint: width,
        error: "Failed to test breakpoint"
      });
    }
  }
  
  // Reset viewport
  await sendCDPCommand("Emulation.clearDeviceMetricsOverride", {});
  
  return {
    selector,
    breakpoints: results,
    summary: {
      totalBreakpoints: results.length,
      breakpointsWithIssues: results.filter(r => (r.issues?.length || 0) > 0).length
    }
  };
}

// ============================================================================
// 9. Find Similar Elements
// ============================================================================

export async function findSimilarElements(issueType: string): Promise<any> {
  await ensureConnectionWithRetry();
  
  const doc = await sendCDPCommand("DOM.getDocument", { depth: -1 });
  const allElements = await getAllElements(doc.root.nodeId);
  
  const similar = [];
  
  for (const elem of allElements) {
    try {
      const boxModel = await sendCDPCommand("DOM.getBoxModel", { nodeId: elem.nodeId });
      const styles = await sendCDPCommand("CSS.getComputedStyleForNode", { nodeId: elem.nodeId });
      const viewport = await sendCDPCommand("Page.getLayoutMetrics", {});
      
      const bounds = boxModel.model;
      const styleMap = new Map<string, string>(styles.computedStyle.map((s: any) => [s.name, s.value]));
      
      // Check if element has the same issue
      if (hasIssue(bounds, styleMap, viewport.layoutViewport, issueType)) {
        similar.push({
          nodeId: elem.nodeId,
          nodeName: elem.nodeName,
          className: elem.className,
          issue: issueType
        });
      }
    } catch (e) {
      // Skip
    }
  }
  
  return {
    issueType,
    similarElements: similar,
    count: similar.length,
    suggestion: `Found ${similar.length} elements with ${issueType} issue`
  };
}

function hasIssue(bounds: any, styleMap: Map<string, string>, viewport: any, issueType: string): boolean {
  const THRESHOLD = 2;
  
  switch (issueType) {
    case "offscreen-right":
      return bounds.content[0] + bounds.width > viewport.clientWidth + THRESHOLD;
    case "offscreen-left":
      return bounds.content[0] < -THRESHOLD;
    case "offscreen-top":
      return bounds.content[1] < -THRESHOLD;
    case "offscreen-bottom":
      return bounds.content[1] + bounds.height > viewport.clientHeight + THRESHOLD;
    case "hidden-display":
      return styleMap.get("display") === "none";
    case "hidden-visibility":
      return styleMap.get("visibility") === "hidden";
    case "hidden-opacity":
      return parseFloat(styleMap.get("opacity") || "1") === 0;
    default:
      return false;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function getNodeId(selector: string): Promise<number> {
  const doc = await sendCDPCommand("DOM.getDocument", { depth: -1 });
  const result = await sendCDPCommand("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector
  });
  
  if (!result.nodeId) {
    throw new Error(`Element not found: ${selector}`);
  }
  
  return result.nodeId;
}

async function getNodeName(nodeId: number): Promise<string> {
  const node = await sendCDPCommand("DOM.describeNode", { nodeId });
  return node.node.nodeName;
}

async function getZIndex(nodeId: number): Promise<number | string> {
  try {
    const styles = await sendCDPCommand("CSS.getComputedStyleForNode", { nodeId });
    const styleMap = new Map(styles.computedStyle.map((s: any) => [s.name, s.value]));
    const zIndexStr = (styleMap.get("z-index") as string) || "auto";
    const parsed = parseInt(zIndexStr, 10);
    return isNaN(parsed) ? "auto" : parsed;
  } catch (e) {
    return "auto";
  }
}

async function getAllElements(nodeId: number, elements: any[] = []): Promise<any[]> {
  try {
    const node = await sendCDPCommand("DOM.describeNode", { nodeId });
    
    const classIndex = node.node.attributes?.findIndex((a: string) => a === "class");
    const className = classIndex !== undefined && classIndex >= 0 ? node.node.attributes[classIndex + 1] : undefined;
    
    elements.push({
      nodeId: node.node.nodeId,
      nodeName: node.node.nodeName,
      className
    });
    
    if (node.node.children) {
      for (const child of node.node.children) {
        await getAllElements(child.nodeId, elements);
      }
    }
  } catch (e) {
    // Skip
  }
  
  return elements;
}

function groupBy(arr: any[], fn: (item: any) => any): Record<string, number> {
  return arr.reduce((acc, item) => {
    const key = fn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
