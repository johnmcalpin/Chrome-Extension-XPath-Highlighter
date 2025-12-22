// XPath Highlighter Background Service Worker

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Store state per tab
const tabStates = new Map();

// Get state for a tab
function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      isActive: false,
      currentXPath: '',
      matchCount: 0
    });
  }
  return tabStates.get(tabId);
}

// Set state for a tab
function setTabState(tabId, updates) {
  const state = getTabState(tabId);
  Object.assign(state, updates);
  tabStates.set(tabId, state);
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'XPATH_GENERATED':
      // Store state and relay to popup
      if (tabId) {
        setTabState(tabId, {
          currentXPath: message.xpath,
          matchCount: message.count
        });
      }
      // Broadcast to popup (if open)
      chrome.runtime.sendMessage(message).catch(() => {
        // Popup might be closed, that's okay
      });
      break;

    case 'GET_PERSISTED_STATE':
      // Popup asking for persisted state
      if (message.tabId) {
        const state = getTabState(message.tabId);
        sendResponse(state);
      } else {
        sendResponse({ isActive: false, currentXPath: '', matchCount: 0 });
      }
      return true;

    case 'SET_PERSISTED_STATE':
      // Popup updating persisted state
      if (message.tabId) {
        setTabState(message.tabId, message.state);
      }
      sendResponse({ success: true });
      return true;

    case 'CONTENT_SCRIPT_READY':
      // Content script loaded, restore state if needed
      if (tabId) {
        const state = getTabState(tabId);
        if (state.isActive) {
          // Re-activate the content script
          chrome.tabs.sendMessage(tabId, {
            type: 'SET_ACTIVE',
            isActive: true
          }).catch(() => {});

          // Re-highlight if there was an xpath
          if (state.currentXPath) {
            chrome.tabs.sendMessage(tabId, {
              type: 'HIGHLIGHT_XPATH',
              xpath: state.currentXPath
            }).catch(() => {});
          }
        }
        sendResponse(state);
      } else {
        sendResponse({ isActive: false, currentXPath: '', matchCount: 0 });
      }
      return true;
  }

  return true;
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

// Deactivate when sidepanel closes
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    port.onDisconnect.addListener(async () => {
      // Sidepanel closed, deactivate all tabs
      for (const [tabId, state] of tabStates) {
        if (state.isActive) {
          setTabState(tabId, { isActive: false, currentXPath: '', matchCount: 0 });
          // Tell content script to deactivate
          chrome.tabs.sendMessage(tabId, {
            type: 'SET_ACTIVE',
            isActive: false
          }).catch(() => {});
          chrome.tabs.sendMessage(tabId, {
            type: 'CLEAR_HIGHLIGHTS'
          }).catch(() => {});
        }
      }
    });
  }
});

// Clean up state when tab navigates to new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Page is reloading, keep isActive but clear xpath/highlights
    const state = getTabState(tabId);
    if (state.isActive) {
      setTabState(tabId, {
        currentXPath: '',
        matchCount: 0
      });
    }
  }
});
