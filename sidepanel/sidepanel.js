// DOM Elements
const activateToggle = document.getElementById('activateToggle');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = statusIndicator.querySelector('.status-text');
const xpathInput = document.getElementById('xpathInput');
const cssInput = document.getElementById('cssInput');
const clearBtn = document.getElementById('clearBtn');
const matchInfo = document.getElementById('matchInfo');
const matchCount = document.getElementById('matchCount');
const copyXpathBtn = document.getElementById('copyXpathBtn');
const copyCssBtn = document.getElementById('copyCssBtn');
const copyFeedback = document.getElementById('copyFeedback');
const xpathNote = document.getElementById('xpathNote');
const cssNote = document.getElementById('cssNote');

let debounceTimer = null;
let currentTabId = null;
let isUpdatingField = false; // prevents feedback loops between the two fields

// ─── XPath ↔ CSS conversion ──────────────────────────────────────────────────

function xpathSegToCSS(seg) {
  seg = seg.trim();
  if (!seg) return null;
  if (seg === '*') return '*';

  // Plain tag: div, span, a …
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(seg)) return seg;

  // tag[@id="val"] or *[@id='val']
  const idM = seg.match(/^([a-zA-Z*][a-zA-Z0-9-]*)\[@id=["']([^"']+)["']\]$/);
  if (idM) {
    const tag = idM[1] === '*' ? '' : idM[1];
    return tag + '#' + CSS.escape(idM[2]);
  }

  // tag[@class="val"] — exact class-attribute value (single or multiple classes)
  const clsM = seg.match(/^([a-zA-Z*][a-zA-Z0-9-]*)\[@class=["']([^"']+)["']\]$/);
  if (clsM) {
    const tag = clsM[1] === '*' ? '' : clsM[1];
    return tag + clsM[2].trim().split(/\s+/).map(c => '.' + CSS.escape(c)).join('');
  }

  // tag[N] — positional index → :nth-of-type
  const nthM = seg.match(/^([a-zA-Z][a-zA-Z0-9-]*)\[(\d+)\]$/);
  if (nthM) return `${nthM[1]}:nth-of-type(${nthM[2]})`;

  return null; // cannot convert this segment
}

function xpathToCSS(xpath) {
  if (!xpath || !xpath.trim()) return '';
  xpath = xpath.trim();
  if (!xpath.startsWith('/')) return null;

  // Strip leading // or /
  const remaining = xpath.startsWith('//') ? xpath.slice(2) : xpath.slice(1);
  if (!remaining) return null;

  // Split on / and // while keeping the separators
  const parts = remaining.split(/(\/\/|\/)/);
  let result = '';

  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (!seg) continue;
    const cssSeg = xpathSegToCSS(seg);
    if (cssSeg === null) return null; // un-convertible segment

    if (!result) {
      result = cssSeg;
    } else {
      const sep = parts[i - 1]; // separator before this segment
      result += (sep === '//' ? ' ' : ' > ') + cssSeg;
    }
  }

  return result || null;
}

function cssSegToXPath(sel) {
  let rem = sel.trim();
  let tag = '*';
  const preds = [];

  const tagM = rem.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagM) { tag = tagM[1]; rem = rem.slice(tagM[0].length); }

  while (rem.length > 0) {
    let matched = false;

    const idM = rem.match(/^#([-\w]+)/);
    if (idM) { preds.push(`@id="${idM[1]}"`); rem = rem.slice(idM[0].length); matched = true; }

    if (!matched) {
      const clsM = rem.match(/^\.([-\w]+)/);
      if (clsM) {
        preds.push(`contains(concat(' ',normalize-space(@class),' '),' ${clsM[1]} ')`);
        rem = rem.slice(clsM[0].length); matched = true;
      }
    }

    if (!matched) {
      const attrM = rem.match(/^\[([^\]]+)\]/);
      if (attrM) {
        const attr = attrM[1];
        const eqM = attr.match(/^([\w-]+)\s*=\s*["']?([^"'\]]+)["']?$/);
        preds.push(eqM ? `@${eqM[1]}="${eqM[2]}"` : `@${attr}`);
        rem = rem.slice(attrM[0].length); matched = true;
      }
    }

    if (!matched) {
      const nthM = rem.match(/^:nth-of-type\((\d+)\)/);
      if (nthM) { preds.push(`position()=${nthM[1]}`); rem = rem.slice(nthM[0].length); matched = true; }
    }

    if (!matched) {
      if (rem.startsWith(':first-child')) { preds.push('position()=1'); rem = rem.slice(12); matched = true; }
      else if (rem.startsWith(':last-child')) { preds.push('position()=last()'); rem = rem.slice(11); matched = true; }
    }

    if (!matched) return null; // unknown pseudo/token
  }

  return preds.length ? `${tag}[${preds.join(' and ')}]` : tag;
}

function cssToXPath(css) {
  if (!css || !css.trim()) return '';
  css = css.trim();

  // Multiple selectors joined by comma
  if (css.includes(',')) {
    const parts = css.split(',').map(s => cssToXPath(s.trim()));
    if (parts.some(p => p === null)) return null;
    return parts.join(' | ');
  }

  const tokens = [];
  const re = /\s*(>|\+|~)\s*|\s+/g;
  let lastIdx = 0, prevComb = null, m;

  while ((m = re.exec(css)) !== null) {
    const seg = css.slice(lastIdx, m.index).trim();
    if (seg) tokens.push({ sel: seg, comb: prevComb });
    prevComb = m[0].trim() || ' ';
    lastIdx = m.index + m[0].length;
  }
  const last = css.slice(lastIdx).trim();
  if (last) tokens.push({ sel: last, comb: prevComb });

  if (!tokens.length) return null;

  let xpath = '';
  for (const { sel, comb } of tokens) {
    const xseg = cssSegToXPath(sel);
    if (xseg === null) return null;

    if (!xpath) {
      xpath = '//' + xseg;
    } else if (comb === '>') {
      xpath += '/' + xseg;
    } else if (comb === '+') {
      xpath += `/following-sibling::*[1][self::${xseg}]`;
    } else if (comb === '~') {
      xpath += `/following-sibling::${xseg}`;
    } else {
      xpath += '//' + xseg; // descendant (space)
    }
  }

  return xpath || null;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    currentTabId = tab.id;

    await ensureContentScript();

    const persistedState = await chrome.runtime.sendMessage({
      type: 'GET_PERSISTED_STATE',
      tabId: currentTabId
    });

    const contentState = await sendMessageToContentScript({ type: 'GET_STATE' });

    const isActive = persistedState?.isActive || false;
    const restoredXPath = contentState?.currentXPath || persistedState?.currentXPath || '';
    const restoredCount = contentState?.matchCount ?? persistedState?.matchCount ?? 0;

    activateToggle.checked = isActive;
    updateStatusUI(isActive);

    const restoredCSS = persistedState?.currentCSS || '';

    if (restoredXPath) {
      xpathInput.value = restoredXPath;
      const css = xpathToCSS(restoredXPath);
      cssInput.value = css || restoredCSS || '';
      if (!css) setCssNote('Cannot convert to CSS');
      updateButtonStates();
    } else if (restoredCSS) {
      cssInput.value = restoredCSS;
      const xpath = cssToXPath(restoredCSS);
      xpathInput.value = xpath || '';
      if (!xpath) setXpathNote('Cannot convert to XPath');
      updateButtonStates();
    }

    updateMatchCount(restoredCount);
  } catch (error) {
    console.error('[Sidepanel] Failed to initialize:', error);
    updateMatchCount(0, 'Unable to connect to page');
  }
}

async function ensureContentScript() {
  if (!currentTabId) return false;
  try {
    await chrome.tabs.sendMessage(currentTabId, { type: 'GET_STATE' });
    return true; // Content script already running — don't inject again
  } catch {
    // Not loaded — fall through to inject
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: currentTabId }, files: ['content/content.css'] });
    await new Promise(resolve => setTimeout(resolve, 150));
    return true;
  } catch {
    return false;
  }
}

async function sendMessageToContentScript(message) {
  if (!currentTabId) return null;
  try {
    return await chrome.tabs.sendMessage(currentTabId, message);
  } catch {
    const injected = await ensureContentScript();
    if (!injected) return null;
    try {
      return await chrome.tabs.sendMessage(currentTabId, message);
    } catch {
      return null;
    }
  }
}

async function persistState(updates) {
  if (!currentTabId) return;
  try {
    await chrome.runtime.sendMessage({ type: 'SET_PERSISTED_STATE', tabId: currentTabId, state: updates });
  } catch {}
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function updateStatusUI(isActive) {
  if (isActive) {
    statusIndicator.classList.add('active');
    statusText.textContent = 'Active - Click elements to get XPath';
  } else {
    statusIndicator.classList.remove('active');
    statusText.textContent = 'Inactive';
  }
}

function updateButtonStates() {
  copyXpathBtn.disabled = xpathInput.value.trim().length === 0;
  copyCssBtn.disabled = cssInput.value.trim().length === 0;
}

function updateMatchCount(count, errorMsg = null, visibleCount = null) {
  matchInfo.classList.remove('error', 'warning');

  if (errorMsg) {
    matchInfo.classList.add('error');
    matchCount.textContent = errorMsg;
  } else if (count === 0) {
    matchInfo.classList.add('warning');
    matchCount.textContent = 'No elements matched';
  } else if (visibleCount !== null && visibleCount === 0) {
    matchInfo.classList.add('warning');
    matchCount.textContent = `${count} element${count !== 1 ? 's' : ''} found — not visible on page`;
  } else {
    matchCount.textContent = `${count} element${count !== 1 ? 's' : ''} matched`;
  }
}

function setXpathNote(msg) {
  xpathNote.textContent = msg;
  xpathNote.classList.toggle('unavailable', !!msg);
}

function setCssNote(msg) {
  cssNote.textContent = msg;
  cssNote.classList.toggle('unavailable', !!msg);
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.classList.add('show');
    setTimeout(() => copyFeedback.classList.remove('show'), 2000);
  } catch {}
}

// ─── Event handlers ───────────────────────────────────────────────────────────

activateToggle.addEventListener('change', async () => {
  const isActive = activateToggle.checked;
  updateStatusUI(isActive);
  await persistState({ isActive });
  await sendMessageToContentScript({ type: 'SET_ACTIVE', isActive });

  if (!isActive) {
    await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
    await persistState({ currentXPath: '', currentCSS: '', matchCount: 0 });
    updateMatchCount(0);
  }
});

clearBtn.addEventListener('click', async () => {
  xpathInput.value = '';
  cssInput.value = '';
  setXpathNote('');
  setCssNote('');
  updateButtonStates();
  await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
  await persistState({ currentXPath: '', currentCSS: '', matchCount: 0 });
  updateMatchCount(0);
});

copyXpathBtn.addEventListener('click', () => copyToClipboard(xpathInput.value.trim()));
copyCssBtn.addEventListener('click', () => copyToClipboard(cssInput.value.trim()));

// XPath field input
xpathInput.addEventListener('input', () => {
  if (isUpdatingField) return;
  updateButtonStates();
  clearTimeout(debounceTimer);

  debounceTimer = setTimeout(async () => {
    const xpath = xpathInput.value.trim();

    // Update CSS field from XPath conversion
    isUpdatingField = true;
    if (xpath) {
      const css = xpathToCSS(xpath);
      cssInput.value = css || '';
      setCssNote(css ? '' : 'Cannot convert this XPath to CSS');
    } else {
      cssInput.value = '';
      setCssNote('');
    }
    setXpathNote('');
    updateButtonStates();
    isUpdatingField = false;

    // Highlight
    if (xpath) {
      const response = await sendMessageToContentScript({ type: 'HIGHLIGHT_XPATH', xpath });
      if (response) {
        if (response.error) {
          updateMatchCount(0, response.error);
          await persistState({ currentXPath: xpath, currentCSS: '', matchCount: 0 });
        } else {
          updateMatchCount(response.count, null, response.visibleCount);
          await persistState({ currentXPath: xpath, currentCSS: '', matchCount: response.count });
        }
      }
    } else {
      await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
      await persistState({ currentXPath: '', matchCount: 0 });
      updateMatchCount(0);
    }
  }, 300);
});

// CSS field input
cssInput.addEventListener('input', () => {
  if (isUpdatingField) return;
  updateButtonStates();
  clearTimeout(debounceTimer);

  debounceTimer = setTimeout(async () => {
    const css = cssInput.value.trim();

    // Update XPath field from CSS conversion
    isUpdatingField = true;
    if (css) {
      const xpath = cssToXPath(css);
      xpathInput.value = xpath || '';
      setXpathNote(xpath ? '' : 'Cannot convert this CSS to XPath');
    } else {
      xpathInput.value = '';
      setXpathNote('');
    }
    setCssNote('');
    updateButtonStates();
    isUpdatingField = false;

    // Highlight using native CSS evaluation (more accurate than converted XPath)
    if (css) {
      const response = await sendMessageToContentScript({ type: 'HIGHLIGHT_CSS', css });
      if (response) {
        if (response.error) {
          updateMatchCount(0, response.error);
        } else {
          updateMatchCount(response.count, null, response.visibleCount);
          await persistState({
            currentCSS: css,
            currentXPath: xpathInput.value.trim(), // save derived XPath too if available
            matchCount: response.count
          });
        }
      }
    } else {
      await sendMessageToContentScript({ type: 'CLEAR_HIGHLIGHTS' });
      updateMatchCount(0);
    }
  }, 300);
});

// When user clicks an element on the page → XPath is generated by content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'XPATH_GENERATED') {
    xpathInput.value = message.xpath;
    isUpdatingField = true;
    const css = xpathToCSS(message.xpath);
    cssInput.value = css || '';
    setCssNote(css ? '' : 'Cannot convert to CSS');
    setXpathNote('');
    isUpdatingField = false;
    updateButtonStates();
    updateMatchCount(message.count, null, message.visibleCount);
  }
  return true;
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  await init();
});

// Keep sidepanel connection alive so background knows when it closes
const port = chrome.runtime.connect({ name: 'sidepanel' });

init();
