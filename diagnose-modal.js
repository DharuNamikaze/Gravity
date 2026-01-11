// Simple modal diagnostic script
// Run this in your browser console to diagnose the #modal element

function diagnoseModal() {
  const selector = '#modal';
  const element = document.querySelector(selector);
  
  if (!element) {
    console.error(`❌ Element not found: ${selector}`);
    return;
  }

  console.log(`🔍 Diagnosing: ${selector}`);
  
  const rect = element.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(element);
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight
  };

  // Check for layout issues
  const issues = [];
  const THRESHOLD = 2;

  console.log('📊 Element Position:', {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom)
  });

  console.log('📱 Viewport:', viewport);

  console.log('🎨 Computed Styles:', {
    display: computedStyle.display,
    position: computedStyle.position,
    width: computedStyle.width,
    height: computedStyle.height,
    overflow: computedStyle.overflow,
    zIndex: computedStyle.zIndex,
    visibility: computedStyle.visibility,
    opacity: computedStyle.opacity,
    transform: computedStyle.transform
  });

  // Check if element extends beyond viewport
  if (rect.right > viewport.width + THRESHOLD) {
    issues.push({
      type: "offscreen-right",
      severity: "🔴 HIGH",
      message: `Element extends ${Math.round(rect.right - viewport.width)}px beyond right edge of viewport`,
      pixels: Math.round(rect.right - viewport.width),
      suggestion: "Add max-width: 100% or use responsive units (vw, %, rem)"
    });
  }

  if (rect.bottom > viewport.height + THRESHOLD) {
    issues.push({
      type: "offscreen-bottom",
      severity: "🔴 HIGH",
      message: `Element extends ${Math.round(rect.bottom - viewport.height)}px beyond bottom edge of viewport`,
      pixels: Math.round(rect.bottom - viewport.height),
      suggestion: "Add max-height: 100vh or enable scrolling"
    });
  }

  if (rect.left < -THRESHOLD) {
    issues.push({
      type: "offscreen-left",
      severity: "🔴 HIGH",
      message: `Element starts ${Math.round(Math.abs(rect.left))}px to the left of viewport`,
      pixels: Math.round(Math.abs(rect.left)),
      suggestion: "Check left/margin-left values, ensure >= 0"
    });
  }

  if (rect.top < -THRESHOLD) {
    issues.push({
      type: "offscreen-top",
      severity: "🔴 HIGH",
      message: `Element starts ${Math.round(Math.abs(rect.top))}px above viewport`,
      pixels: Math.round(Math.abs(rect.top)),
      suggestion: "Check top/margin-top values, ensure >= 0"
    });
  }

  // Check for common modal issues
  if (computedStyle.position === 'fixed' || computedStyle.position === 'absolute') {
    const zIndex = computedStyle.zIndex;
    if (zIndex === 'auto' || parseInt(zIndex) < 1000) {
      issues.push({
        type: "low-z-index",
        severity: "🟡 MEDIUM",
        message: `Modal z-index is ${zIndex}, may be hidden behind other elements`,
        suggestion: "Set z-index to a high value (e.g., 9999) for modals"
      });
    }
  }

  // Check visibility
  if (computedStyle.display === 'none') {
    issues.push({
      type: "hidden-display",
      severity: "🔴 HIGH",
      message: "Element has display: none",
      suggestion: "Change display property to show the modal"
    });
  }

  if (computedStyle.visibility === 'hidden') {
    issues.push({
      type: "hidden-visibility",
      severity: "🔴 HIGH",
      message: "Element has visibility: hidden",
      suggestion: "Change visibility to 'visible'"
    });
  }

  if (parseFloat(computedStyle.opacity) === 0) {
    issues.push({
      type: "transparent",
      severity: "🟡 MEDIUM",
      message: "Element has opacity: 0",
      suggestion: "Increase opacity to make element visible"
    });
  }

  // Check for centering issues
  if (computedStyle.position === 'fixed' || computedStyle.position === 'absolute') {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportCenterX = viewport.width / 2;
    const viewportCenterY = viewport.height / 2;
    
    if (Math.abs(centerX - viewportCenterX) > 50) {
      issues.push({
        type: "not-centered-x",
        severity: "🟡 MEDIUM",
        message: `Modal is ${Math.round(Math.abs(centerX - viewportCenterX))}px off-center horizontally`,
        suggestion: "Use left: 50%; transform: translateX(-50%) for horizontal centering"
      });
    }
    
    if (Math.abs(centerY - viewportCenterY) > 50) {
      issues.push({
        type: "not-centered-y",
        severity: "🟡 MEDIUM",
        message: `Modal is ${Math.round(Math.abs(centerY - viewportCenterY))}px off-center vertically`,
        suggestion: "Use top: 50%; transform: translateY(-50%) for vertical centering"
      });
    }
  }

  console.log('\n🚨 ISSUES FOUND:');
  if (issues.length === 0) {
    console.log('✅ No layout issues detected - modal appears to be positioned correctly!');
  } else {
    issues.forEach((issue, index) => {
      console.log(`\n${index + 1}. ${issue.severity} ${issue.type.toUpperCase()}`);
      console.log(`   ${issue.message}`);
      console.log(`   💡 Suggestion: ${issue.suggestion}`);
    });
  }

  return {
    element: selector,
    position: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    viewport,
    issues
  };
}

// Run the diagnosis
diagnoseModal();