const statusEl = document.querySelector('#status');
const hostNameEl = document.querySelector('#host-name');
const lastCheckedEl = document.querySelector('#last-checked');
const errorEl = document.querySelector('#error');
const bypassCspEl = document.querySelector('#bypass-csp');
const bridgePortEl = document.querySelector('#bridge-port');
const savePortBtn = document.querySelector('#save-port-btn');

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
  await chrome.storage.local.set({ agreedToDisclaimer: true });
  disclaimerScreen.style.display = 'none';
  mainContent.style.display = 'block';
  initializePanel();
});

declineBtn.addEventListener('click', () => {
  declineWarning.style.display = 'block';
});

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

  // Update settings when toggled
  bypassCspEl.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_CSP_BYPASS',
      enabled: bypassCspEl.checked
    });
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

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'NATIVE_STATUS_CHANGED') renderStatus(message.status);
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
