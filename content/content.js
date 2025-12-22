// XPath Highlighter Content Script
(function() {
  'use strict';

  // State
  let isActive = false;
  let currentXPath = '';
  let highlightedElements = [];
  let hoveredElement = null;
  let tooltip = null;
  let overlay = null;

  // Generate XPath for an element
  function generateXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    // Check for ID (most specific)
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `//*[@id="${element.id}"]`;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document) {
      let selector = current.tagName.toLowerCase();

      // Check for unique ID at this level
      if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
        parts.unshift(`*[@id="${current.id}"]`);
        break;
      }

      // Add index if there are siblings with the same tag
      const parent = current.parentNode;
      if (parent && parent.children) {
        const siblings = Array.from(parent.children).filter(
          child => child.tagName === current.tagName
        );

        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `[${index}]`;
        }
      }

      parts.unshift(selector);
      current = current.parentNode;
    }

    // Build the full path - always start with //
    if (parts.length === 0) {
      return '//' + element.tagName.toLowerCase();
    }

    // Check if first part is an ID selector
    if (parts[0].startsWith('*[@id=')) {
      return '//' + parts.join('/');
    }

    // Otherwise build absolute path from html
    return '//' + parts.join('/');
  }

  // Evaluate XPath and return matching elements
  function evaluateXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );

      const elements = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node.nodeType === Node.ELEMENT_NODE) {
          elements.push(node);
        }
      }

      return { elements, error: null };
    } catch (error) {
      return { elements: [], error: `Invalid XPath: ${error.message}` };
    }
  }

  // Clear all highlights
  function clearHighlights() {
    highlightedElements.forEach(el => {
      el.classList.remove('xpath-highlight');
    });
    highlightedElements = [];
  }

  // Highlight elements matching XPath
  function highlightXPath(xpath) {
    console.log('[XPath Highlighter] highlightXPath called with:', xpath);
    clearHighlights();

    if (!xpath) {
      console.log('[XPath Highlighter] Empty xpath, returning 0');
      return { count: 0 };
    }

    const { elements, error } = evaluateXPath(xpath);

    if (error) {
      console.log('[XPath Highlighter] XPath error:', error);
      return { count: 0, error };
    }

    console.log('[XPath Highlighter] Found elements:', elements.length);

    elements.forEach(el => {
      el.classList.add('xpath-highlight');
      highlightedElements.push(el);
      console.log('[XPath Highlighter] Added highlight to:', el.tagName, el.className);
    });

    currentXPath = xpath;

    // Scroll first element into view if not visible
    if (elements.length > 0) {
      const firstEl = elements[0];
      const rect = firstEl.getBoundingClientRect();
      const isVisible = (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth
      );

      if (!isVisible) {
        firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    return { count: elements.length };
  }

  // Show/hide active overlay
  function toggleOverlay(show) {
    if (show) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'xpath-extension-active-overlay';
        overlay.textContent = 'XPath Highlighter Active';
        document.body.appendChild(overlay);
      }
    } else {
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
    }
  }

  // Show element tooltip
  function showTooltip(element, x, y) {
    hideTooltip();

    const tagName = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const classes = element.className && typeof element.className === 'string'
      ? '.' + element.className.trim().split(/\s+/).join('.')
      : '';

    let text = tagName;
    if (id) text += id;
    else if (classes && classes !== '.') text += classes;

    tooltip = document.createElement('div');
    tooltip.className = 'xpath-element-tooltip';
    tooltip.textContent = text;

    document.body.appendChild(tooltip);

    // Position tooltip
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = x - tooltipRect.width / 2;
    let top = y - tooltipRect.height - 15;

    // Keep within viewport
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top < 10) {
      top = y + 20;
      tooltip.style.transform = 'none';
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  // Hide tooltip
  function hideTooltip() {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }

  // Handle mouse move when active
  function handleMouseMove(event) {
    if (!isActive) return;

    const element = event.target;

    // Skip our own elements
    if (element.classList.contains('xpath-extension-active-overlay') ||
        element.classList.contains('xpath-element-tooltip')) {
      return;
    }

    // Remove hover from previous element
    if (hoveredElement && hoveredElement !== element) {
      hoveredElement.classList.remove('xpath-hover-highlight');
    }

    // Add hover to current element
    if (element !== document.body && element !== document.documentElement) {
      element.classList.add('xpath-hover-highlight');
      hoveredElement = element;
      showTooltip(element, event.clientX, event.clientY);
    }
  }

  // Handle mouse leave
  function handleMouseLeave(event) {
    if (hoveredElement) {
      hoveredElement.classList.remove('xpath-hover-highlight');
      hoveredElement = null;
    }
    hideTooltip();
  }

  // Handle click when active
  function handleClick(event) {
    if (!isActive) return;

    const element = event.target;

    // Skip our own elements
    if (element.classList.contains('xpath-extension-active-overlay') ||
        element.classList.contains('xpath-element-tooltip')) {
      return;
    }

    // Prevent default navigation and propagation
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Generate XPath
    const xpath = generateXPath(element);
    console.log('[XPath Highlighter] Click generated xpath:', xpath);

    // Highlight the element
    const result = highlightXPath(xpath);
    console.log('[XPath Highlighter] Click highlight result:', result);

    // Remove hover highlight (but keep the permanent highlight)
    if (hoveredElement) {
      hoveredElement.classList.remove('xpath-hover-highlight');
      hoveredElement = null;
    }

    // Hide tooltip after click
    hideTooltip();

    // Send XPath to sidepanel
    chrome.runtime.sendMessage({
      type: 'XPATH_GENERATED',
      xpath: xpath,
      count: result.count
    }).catch(err => console.log('[XPath Highlighter] Message send error:', err));

    return false;
  }

  // Prevent navigation on links when active
  function handleAuxClick(event) {
    if (!isActive) return;
    event.preventDefault();
    event.stopPropagation();
  }

  // Set active state
  function setActive(active) {
    isActive = active;
    toggleOverlay(active);

    if (active) {
      document.body.classList.add('xpath-extension-active');
    } else {
      document.body.classList.remove('xpath-extension-active');
      if (hoveredElement) {
        hoveredElement.classList.remove('xpath-hover-highlight');
        hoveredElement = null;
      }
      hideTooltip();
    }
  }

  // Initialize event listeners
  function init() {
    // Use capture phase to intercept events before they reach the page
    document.addEventListener('mousemove', handleMouseMove, { capture: true, passive: true });
    document.addEventListener('mouseleave', handleMouseLeave, { capture: true });
    document.addEventListener('click', handleClick, { capture: true });
    document.addEventListener('auxclick', handleAuxClick, { capture: true });

    // Prevent context menu when active
    document.addEventListener('contextmenu', (event) => {
      if (isActive) {
        event.preventDefault();
        handleClick(event);
      }
    }, { capture: true });

    // Prevent form submissions when active
    document.addEventListener('submit', (event) => {
      if (isActive) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { capture: true });
  }

  // Message handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[XPath Highlighter] Received message:', message.type, message);

    switch (message.type) {
      case 'GET_STATE':
        sendResponse({
          isActive,
          currentXPath,
          matchCount: highlightedElements.length
        });
        break;

      case 'SET_ACTIVE':
        setActive(message.isActive);
        sendResponse({ success: true });
        break;

      case 'HIGHLIGHT_XPATH':
        const result = highlightXPath(message.xpath);
        console.log('[XPath Highlighter] HIGHLIGHT_XPATH result:', result);
        sendResponse(result);
        break;

      case 'CLEAR_HIGHLIGHTS':
        clearHighlights();
        currentXPath = '';
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }

    return true; // Keep channel open for async response
  });

  // Initialize
  init();

  // Notify background script that content script is ready and get persisted state
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }).catch(() => {
    // Background might not be ready yet
  });
})();
