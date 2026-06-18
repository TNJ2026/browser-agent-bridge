const statusEl = document.querySelector('#status');
const hostNameEl = document.querySelector('#host-name');
const lastCheckedEl = document.querySelector('#last-checked');
const errorEl = document.querySelector('#error');
const bypassCspEl = document.querySelector('#bypass-csp');
const bypassCorsEl = document.querySelector('#bypass-cors');
const bypassXfoEl = document.querySelector('#bypass-xfo');

document.querySelector('#refresh').addEventListener('click', refresh);

// Load settings on open
chrome.runtime.sendMessage({ type: 'GET_CSP_BYPASS' }).then(response => {
  if (response && 'enabled' in response) {
    bypassCspEl.checked = response.enabled;
  }
});
chrome.runtime.sendMessage({ type: 'GET_CORS_BYPASS' }).then(response => {
  if (response && 'enabled' in response) {
    bypassCorsEl.checked = response.enabled;
  }
});
chrome.runtime.sendMessage({ type: 'GET_XFO_BYPASS' }).then(response => {
  if (response && 'enabled' in response) {
    bypassXfoEl.checked = response.enabled;
  }
});

// Update settings when toggled
bypassCspEl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SET_CSP_BYPASS',
    enabled: bypassCspEl.checked
  });
});
bypassCorsEl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SET_CORS_BYPASS',
    enabled: bypassCorsEl.checked
  });
});
bypassXfoEl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SET_XFO_BYPASS',
    enabled: bypassXfoEl.checked
  });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'NATIVE_STATUS_CHANGED') renderStatus(message.status);
});

refresh();

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
