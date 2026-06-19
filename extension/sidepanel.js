const statusEl = document.querySelector('#status');
const hostNameEl = document.querySelector('#host-name');
const lastCheckedEl = document.querySelector('#last-checked');
const errorEl = document.querySelector('#error');
const bypassCspEl = document.querySelector('#bypass-csp');
const bridgePortEl = document.querySelector('#bridge-port');
const savePortBtn = document.querySelector('#save-port-btn');
// Unused settings checkboxes removed from UI
const enableRuntimeApprovalEl = document.querySelector('#enable-runtime-approval');

const permissionCard = document.querySelector('#permission-card');
const permissionDetails = document.querySelector('#permission-details');
const permAllowBtn = document.querySelector('#perm-allow-btn');
const permSessionAllowBtn = document.querySelector('#perm-session-allow-btn');
const permDenyBtn = document.querySelector('#perm-deny-btn');

const disclaimerScreen = document.querySelector('#disclaimer-screen');
const mainContent = document.querySelector('#main-content');
const agreeBtn = document.querySelector('#agree-btn');
const declineBtn = document.querySelector('#decline-btn');
const declineWarning = document.querySelector('#decline-warning');

document.querySelector('#refresh').addEventListener('click', refresh);

// Check user agreement status on load
chrome.storage.local.get('agreedToDisclaimer').then(result => {
  if (result.agreedToDisclaimer === true) {
    disclaimerScreen.style.display = 'none';
    mainContent.style.display = 'block';
    initializePanel();
  } else {
    disclaimerScreen.style.display = 'flex';
    mainContent.style.display = 'none';
  }
});

agreeBtn.addEventListener('click', async () => {
  try {
    await chrome.permissions.request({
      permissions: ['tabs', 'tabGroups', 'downloads']
    });
  } catch (e) {
    console.error('Failed to request optional permissions:', e);
  }
  await chrome.storage.local.set({ agreedToDisclaimer: true });
  disclaimerScreen.style.display = 'none';
  mainContent.style.display = 'block';
  initializePanel();
});

declineBtn.addEventListener('click', () => {
  declineWarning.style.display = 'block';
});

let activePrompts = [];
let currentPrompt = null;

function showNextPrompt() {
  if (currentPrompt) return;
  if (activePrompts.length === 0) {
    permissionCard.style.display = 'none';
    return;
  }

  currentPrompt = activePrompts.shift();
  permissionDetails.innerHTML = `
    <strong>Method/操作:</strong> <code>${currentPrompt.method}</code><br>
    <strong>Description/说明:</strong><br>
    中: ${currentPrompt.labels.zh}<br>
    En: ${currentPrompt.labels.en}<br>
    <strong>Params/参数:</strong> <pre style="font-size:10px; margin: 4px 0 0; max-height:80px; padding:4px; overflow:auto; background:var(--button-hover); border:1px solid var(--border-color); border-radius:4px;">${JSON.stringify(currentPrompt.params, null, 2)}</pre>
  `;
  permissionCard.style.display = 'block';
}

function resolveCurrentPrompt(responseValue) {
  if (!currentPrompt) return;
  chrome.runtime.sendMessage({
    type: 'PERMISSION_RESPONSE',
    promptId: currentPrompt.promptId,
    response: responseValue
  }).catch(() => {});

  currentPrompt = null;
  showNextPrompt();
}

function getCategoryLabel(category) {
  return {
    'read_tabs': {
      zh: '读取标签页列表 (获取您当前打开的所有标签页标题和网址)',
      en: 'Read tab list (access titles and URLs of all your open tabs)'
    },
    'read_history': {
      zh: '搜索浏览器历史记录与书签 (读取历史和书签数据库)',
      en: 'Search browser history and bookmarks (access local history and bookmarks databases)'
    },
    'read_downloads': {
      zh: '读取浏览器下载记录 (获取您已下载的文件列表和路径)',
      en: 'Read downloads history (access list of downloaded files and local paths)'
    },
    'page_screenshot': {
      zh: '截取网页视觉截图或 DOM 结构树快照',
      en: 'Capture visual screenshot or DOM tree snapshots of the page'
    },
    'page_logs': {
      zh: '读取当前网页的控制台报错与网络请求日志',
      en: 'Read console logs and network request summaries of the current page'
    }
  }[category] || { zh: category, en: category };
}

let initialized = false;
function initializePanel() {
  if (initialized) return;
  initialized = true;

  // Load settings on open
  chrome.runtime.sendMessage({ type: 'GET_CSP_BYPASS' }).then(response => {
    if (response && 'enabled' in response) {
      bypassCspEl.checked = response.enabled;
    }
  });

  // Load bridge port on open
  chrome.storage.local.get('bridgePort').then(response => {
    if (response && 'bridgePort' in response) {
      bridgePortEl.value = response.bridgePort;
    } else {
      bridgePortEl.value = 8765;
    }
  });

  // Load reading settings on open
  chrome.storage.local.get(['enableRuntimeApproval']).then(response => {
    enableRuntimeApprovalEl.checked = response.enableRuntimeApproval !== false;
  });

  // Update settings when toggled
  bypassCspEl.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_CSP_BYPASS',
      enabled: bypassCspEl.checked
    });
  });

  // System permissions requested dynamically in agreeBtn handler

  enableRuntimeApprovalEl.addEventListener('change', async () => {
    await chrome.storage.local.set({ enableRuntimeApproval: enableRuntimeApprovalEl.checked });
  });

  savePortBtn.addEventListener('click', async () => {
    const port = parseInt(bridgePortEl.value, 10);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      await chrome.storage.local.set({ bridgePort: port });
      chrome.runtime.reload();
    } else {
      alert('Please enter a valid port number between 1024 and 65535.');
    }
  });

  permAllowBtn.addEventListener('click', () => resolveCurrentPrompt('allow'));
  permSessionAllowBtn.addEventListener('click', () => resolveCurrentPrompt('session_allow'));
  permDenyBtn.addEventListener('click', () => resolveCurrentPrompt('deny'));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING_SIDEPANEL') {
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'NATIVE_STATUS_CHANGED') {
      renderStatus(message.status);
    }
    if (message?.type === 'PROMPT_PERMISSION') {
      const labels = getCategoryLabel(message.category);
      activePrompts.push({
        promptId: message.promptId,
        category: message.category,
        method: message.method,
        params: message.params,
        labels
      });
      showNextPrompt();
    }
  });

  refresh();
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_NATIVE_STATUS' });
  renderStatus(response.status);
}

function renderStatus(status) {
  const connected = status?.state === 'connected';
  statusEl.textContent = connected ? 'Connected' : 'Disconnected';
  statusEl.classList.toggle('connected', connected);
  statusEl.classList.toggle('disconnected', !connected);
  hostNameEl.textContent = status?.hostName || '-';
  lastCheckedEl.textContent = status?.lastChecked ? new Date(status.lastChecked).toLocaleString() : '-';
  errorEl.textContent = status?.error || '-';
}
