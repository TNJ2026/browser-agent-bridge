const statusEl = document.querySelector('#status');
const hostNameEl = document.querySelector('#host-name');
const lastCheckedEl = document.querySelector('#last-checked');
const errorEl = document.querySelector('#error');
const bypassCspEl = document.querySelector('#bypass-csp');

document.querySelector('#refresh').addEventListener('click', refresh);

// Load CSP setting on open
chrome.runtime.sendMessage({ type: 'GET_CSP_BYPASS' }).then(response => {
  if (response && 'enabled' in response) {
    bypassCspEl.checked = response.enabled;
  }
});

// Update setting when toggled
bypassCspEl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SET_CSP_BYPASS',
    enabled: bypassCspEl.checked
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
