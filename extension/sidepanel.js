const statusEl = document.querySelector('#status');
const hostNameEl = document.querySelector('#host-name');
const lastCheckedEl = document.querySelector('#last-checked');
const errorEl = document.querySelector('#error');
const outputEl = document.querySelector('#output');

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#list-tabs').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({
    type: 'RPC',
    request: {
      jsonrpc: '2.0',
      id: 'sidepanel-tabs',
      method: 'tabs.list',
      params: {}
    }
  });
  outputEl.textContent = JSON.stringify(response, null, 2);
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
