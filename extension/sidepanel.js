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
const REQUIRED_OPTIONAL_PERMISSIONS = ['tabs', 'tabGroups', 'downloads'];

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
  declineWarning.style.display = 'none';
  let granted = false;
  try {
    granted = await chrome.permissions.request({
      permissions: REQUIRED_OPTIONAL_PERMISSIONS
    });
  } catch (e) {
    console.error('Failed to request optional permissions:', e);
    declineWarning.textContent = 'Chrome permissions request failed. Please try again.';
    declineWarning.style.display = 'block';
    return;
  }
  if (!granted) {
    declineWarning.textContent = 'Required Chrome permissions were not granted. The bridge cannot control tabs, tab groups, or downloads without them.';
    declineWarning.style.display = 'block';
    return;
  }
  await chrome.storage.local.set({
    agreedToDisclaimer: true,
    optionalPermissionsGranted: true
  });
  disclaimerScreen.style.display = 'none';
  mainContent.style.display = 'block';
  initializePanel();
});

declineBtn.addEventListener('click', () => {
  declineWarning.style.display = 'block';
});

let activePrompts = [];
let currentPrompt = null;

function appendLabeledValue(parent, label, value, valueTag = 'span') {
  const strong = document.createElement('strong');
  strong.textContent = label;
  parent.appendChild(strong);
  const valueEl = document.createElement(valueTag);
  valueEl.textContent = value;
  parent.appendChild(valueEl);
  parent.appendChild(document.createElement('br'));
}

function showNextPrompt() {
  if (currentPrompt) return;
  if (activePrompts.length === 0) {
    permissionCard.style.display = 'none';
    return;
  }

  currentPrompt = activePrompts.shift();
  permissionDetails.textContent = '';
  appendLabeledValue(permissionDetails, 'Method/操作: ', currentPrompt.method, 'code');

  const descriptionLabel = document.createElement('strong');
  descriptionLabel.textContent = 'Description/说明:';
  permissionDetails.appendChild(descriptionLabel);
  permissionDetails.appendChild(document.createElement('br'));
  permissionDetails.appendChild(document.createTextNode(`中: ${currentPrompt.labels.zh}`));
  permissionDetails.appendChild(document.createElement('br'));
  permissionDetails.appendChild(document.createTextNode(`En: ${currentPrompt.labels.en}`));
  permissionDetails.appendChild(document.createElement('br'));

  const paramsLabel = document.createElement('strong');
  paramsLabel.textContent = 'Params/参数:';
  permissionDetails.appendChild(paramsLabel);
  const paramsPre = document.createElement('pre');
  paramsPre.className = 'permission-params';
  paramsPre.textContent = JSON.stringify(currentPrompt.params, null, 2);
  permissionDetails.appendChild(paramsPre);
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
    },
    'policy_admin': {
      zh: '修改本地安全策略 (允许/阻止 URL 或 RPC 方法)',
      en: 'Modify local security policy (allow/block URLs or RPC methods)'
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
