// DOM Elements
const activateToggle = document.getElementById('activateToggle');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = statusIndicator.querySelector('.status-text');
const xpathInput = document.getElementById('xpathInput');
const highlightBtn = document.getElementById('highlightBtn');
const clearBtn = document.getElementById('clearBtn');
const matchInfo = document.getElementById('matchInfo');
const matchCount = document.getElementById('matchCount');
const copyBtn = document.getElementById('copyBtn');
const copyFeedback = document.getElementById('copyFeedback');

let debounceTimer = null;
let currentTabId = null;

// Initialize side panel state
async function init() {
  console.log('[Sidepanel] Initializing...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;
    console.log('[Sidepanel] Current tab ID:', currentTabId);

    // Ensure content script is loaded first
    await ensureContentScript();

    // Get persisted state from background script
    const persistedState = await chrome.runtime.sendMessage({
      type: 'GET_PERSISTED_STATE',
      tabId: currentTabId
    });
    console.log('[Sidepanel] Persisted state:', persistedState);

    // Get current state from content script
    const contentState = await sendMessageToContentScript({ type: 'GET_STATE' });
    console.log('[Sidepanel] Content state:', contentState);

    // Use persisted state for isActive, content state for current xpath/count
    const isActive = persistedState?.isActive || false;
    const currentXPath = contentState?.currentXPath || persistedState?.currentXPath || '';
    const currentMatchCount = contentState?.matchCount ?? persistedState?.matchCount ?? 0;

    activateToggle.checked = isActive;
    updateStatusUI(isActive);

    if (currentXPath) {
      xpathInput.value = currentXPath;
      updateButtonStates();
    }

    updateMatchCount(currentMatchCount);
    console.log('[Sidepanel] Initialized with isActive:', isActive);

  } catch (error) {
    console.error('[Sidepanel] Failed to initialize:', error);
    updateMatchCount(0, 'Unable to connect to page');
  }
}

// Ensure content script is injected
async function ensureContentScript() {
  if (!currentTabId) return false;

  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(currentTabId, { type: 'GET_STATE' });
    return true;
  } catch (error) {
    // Content script not loaded, try to inject it
    console.log('[Sidepanel] Content script not found, injecting...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: currentTabId },
        files: ['content/content.css']
      });
      // Wait a bit for script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    } catch (injectError) {
      console.error('[Sidepanel] Cannot inject content script:', injectError);
      return false;
    }
  }
}

// Send message to content script
async function sendMessageToContentScript(message) {
  console.log('[Sidepanel] Sending to content script:', message);
  try {
    if (!currentTabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = tab.id;
    }

    // Ensure content script is loaded before sending
    const scriptReady = await ensureContentScript();
    if (!scriptReady) {
      console.error('[Sidepanel] Content script not available');
      return null;
    }

    const response = await chrome.tabs.sendMessage(currentTabId, message);
    console.log('[Sidepanel] Response from content script:', response);
    return response;
  } catch (error) {
    console.error('[Sidepanel] Message failed:', error);
    return null;
  }
}

// Persist state to background script
async function persistState(updates) {
  if (!currentTabId) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'SET_PERSISTED_STATE',
      tabId: currentTabId,
      state: updates
    });
  } catch (error) {
    console.error('Failed to persist state:', error);
  }
}

// Update status UI
function updateStatusUI(isActive) {
  if (isActive) {
    statusIndicator.classList.add('active');
    statusText.textContent = 'Active - Click elements to get XPath';
  } else {
    statusIndicator.classList.remove('active');
    statusText.textContent = 'Inactive';
  }
}

// Update button states based on input
function updateButtonStates() {
  const hasInput = xpathInput.value.trim().length > 0;
  highlightBtn.disabled = !hasInput;
  copyBtn.disabled = !hasInput;
}

// Update match count display
function updateMatchCount(count, errorMsg = null) {
  matchInfo.classList.remove('error', 'warning');

  if (errorMsg) {
    matchInfo.classList.add('error');
    matchCount.textContent = errorMsg;
  } else if (count === 0) {
    matchInfo.classList.add('warning');
    matchCount.textContent = 'No elements matched';
  } else {
    matchCount.textContent = `${count} element${count !== 1 ? 's' : ''} matched`;
  }
}

// Handle toggle change
activateToggle.addEventListener('change', async () => {
  const isActive = activateToggle.checked;
  updateStatusUI(isActive);

  // Persist state first
  await persistState({ isActive });

  // Then update content script
  const response = await sendMessageToContentScript({
    type: 'SET_ACTIVE',
    isActive
  });

  if (response && !isActive) {
    // Clear highlights when deactivating
    await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
    await persistState({ currentXPath: '', matchCount: 0 });
    updateMatchCount(0);
  }
});

// Handle highlight button click
highlightBtn.addEventListener('click', async () => {
  const xpath = xpathInput.value.trim();
  if (!xpath) return;

  const response = await sendMessageToContentScript({
    type: 'HIGHLIGHT_XPATH',
    xpath
  });

  if (response) {
    if (response.error) {
      updateMatchCount(0, response.error);
      await persistState({ currentXPath: xpath, matchCount: 0 });
    } else {
      updateMatchCount(response.count);
      await persistState({ currentXPath: xpath, matchCount: response.count });
    }
  }
});

// Handle clear button click
clearBtn.addEventListener('click', async () => {
  xpathInput.value = '';
  updateButtonStates();

  await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
  await persistState({ currentXPath: '', matchCount: 0 });
  updateMatchCount(0);
});

// Handle copy button click
copyBtn.addEventListener('click', async () => {
  const xpath = xpathInput.value.trim();
  if (!xpath) return;

  try {
    await navigator.clipboard.writeText(xpath);
    copyFeedback.classList.add('show');
    setTimeout(() => copyFeedback.classList.remove('show'), 2000);
  } catch (error) {
    console.error('Failed to copy:', error);
  }
});

// Handle input changes with debounce for live updates
xpathInput.addEventListener('input', () => {
  updateButtonStates();

  // Debounce live highlighting
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(async () => {
    const xpath = xpathInput.value.trim();

    if (xpath) {
      const response = await sendMessageToContentScript({
        type: 'HIGHLIGHT_XPATH',
        xpath
      });

      if (response) {
        if (response.error) {
          updateMatchCount(0, response.error);
          await persistState({ currentXPath: xpath, matchCount: 0 });
        } else {
          updateMatchCount(response.count);
          await persistState({ currentXPath: xpath, matchCount: response.count });
        }
      }
    } else {
      await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
      await persistState({ currentXPath: '', matchCount: 0 });
      updateMatchCount(0);
    }
  }, 300);
});

// Listen for messages from content script (when user clicks elements)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Sidepanel] Received message:', message);
  if (message.type === 'XPATH_GENERATED') {
    console.log('[Sidepanel] Got XPATH_GENERATED, xpath:', message.xpath, 'count:', message.count);
    xpathInput.value = message.xpath;
    updateButtonStates();
    updateMatchCount(message.count);
  }
  return true;
});

// Listen for tab changes to update state
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  await init();
});

// Establish connection to background script so it knows when sidepanel closes
const port = chrome.runtime.connect({ name: 'sidepanel' });

// Initialize on side panel open
init();
