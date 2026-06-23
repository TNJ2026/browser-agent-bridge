const permissionDetails = document.querySelector('#permission-details');
const permAllowBtn = document.querySelector('#perm-allow-btn');
const permSessionAllowBtn = document.querySelector('#perm-session-allow-btn');
const permDenyBtn = document.querySelector('#perm-deny-btn');

let activePrompts = [];
let currentPrompt = null;
let initialPromptsLoaded = false;

function appendLabeledValue(parent, label, value, valueTag = 'span') {
  const strong = document.createElement('strong');
  strong.textContent = label;
  parent.appendChild(strong);
  const valueEl = document.createElement(valueTag);
  valueEl.textContent = value;
  parent.appendChild(valueEl);
  parent.appendChild(document.createElement('br'));
}

function getCategoryLabel(category) {
  return {
    read_tabs: {
      zh: '读取标签页列表 (获取您当前打开的所有标签页标题和网址)',
      en: 'Read tab list (access titles and URLs of all your open tabs)'
    },
    tab_control: {
      zh: '关闭或停止 Agent 管理的标签页/会话',
      en: 'Close tabs or stop browser sessions managed by the Agent'
    },
    read_downloads: {
      zh: '读取浏览器下载记录 (获取您已下载的文件列表和路径)',
      en: 'Read downloads history (access list of downloaded files and local paths)'
    },
    page_script: {
      zh: '在当前网页中执行自定义 JavaScript',
      en: 'Run custom JavaScript in the current page'
    },
    page_screenshot: {
      zh: '截取网页视觉截图或 DOM 结构树快照',
      en: 'Capture visual screenshot or DOM tree snapshots of the page'
    },
    page_input: {
      zh: '向当前网页输入文本或发送键盘快捷键',
      en: 'Type text or send keyboard shortcuts to the current page'
    },
    page_action: {
      zh: '在当前网页中点击、拖拽或选择控件',
      en: 'Click, drag, or select controls in the current page'
    },
    page_logs: {
      zh: '读取当前网页的控制台报错与网络请求日志',
      en: 'Read console logs and network request summaries of the current page'
    },
    policy_admin: {
      zh: '修改本地安全策略 (允许/阻止 URL 或 RPC 方法)',
      en: 'Modify local security policy (allow/block URLs or RPC methods)'
    },
    recording_data: {
      zh: '读取或导出已录制的网页操作历史 (包含步骤截图)',
      en: 'Access or export recorded page action history (includes step screenshots)'
    }
  }[category] || { zh: category, en: category };
}

function renderPrompt(prompt) {
  const labels = getCategoryLabel(prompt.category);
  permissionDetails.textContent = '';
  appendLabeledValue(permissionDetails, 'Method/操作: ', prompt.method, 'code');

  const descriptionLabel = document.createElement('strong');
  descriptionLabel.textContent = 'Description/说明:';
  permissionDetails.appendChild(descriptionLabel);
  permissionDetails.appendChild(document.createElement('br'));
  permissionDetails.appendChild(document.createTextNode(`中: ${labels.zh}`));
  permissionDetails.appendChild(document.createElement('br'));
  permissionDetails.appendChild(document.createTextNode(`En: ${labels.en}`));
  permissionDetails.appendChild(document.createElement('br'));

  const paramsLabel = document.createElement('strong');
  paramsLabel.textContent = 'Params/参数:';
  permissionDetails.appendChild(paramsLabel);
  const paramsPre = document.createElement('pre');
  paramsPre.className = 'permission-params';
  paramsPre.textContent = JSON.stringify(prompt.params, null, 2);
  permissionDetails.appendChild(paramsPre);
}

function showNextPrompt() {
  if (currentPrompt) return;
  currentPrompt = activePrompts.shift() || null;
  if (!currentPrompt) {
    permissionDetails.textContent = 'No pending approval requests.';
    if (initialPromptsLoaded) window.close();
    return;
  }
  renderPrompt(currentPrompt);
}

function enqueuePrompt(prompt) {
  if (currentPrompt?.promptId === prompt.promptId) return;
  if (activePrompts.some(item => item.promptId === prompt.promptId)) return;
  activePrompts.push(prompt);
  showNextPrompt();
}

async function resolveCurrentPrompt(responseValue) {
  if (!currentPrompt) return;
  const prompt = currentPrompt;
  currentPrompt = null;
  await chrome.runtime.sendMessage({
    type: 'PERMISSION_RESPONSE',
    promptId: prompt.promptId,
    response: responseValue
  }).catch(() => {});
  showNextPrompt();
}

permAllowBtn.addEventListener('click', () => resolveCurrentPrompt('allow'));
permSessionAllowBtn.addEventListener('click', () => resolveCurrentPrompt('session_allow'));
permDenyBtn.addEventListener('click', () => resolveCurrentPrompt('deny'));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PROMPT_PERMISSION') {
    enqueuePrompt({
      promptId: message.promptId,
      category: message.category,
      method: message.method,
      params: message.params
    });
  }
});

chrome.runtime.sendMessage({ type: 'GET_PENDING_PERMISSION_PROMPTS' }).then(response => {
  for (const prompt of response?.prompts || []) {
    enqueuePrompt(prompt);
  }
  initialPromptsLoaded = true;
  showNextPrompt();
}).catch(() => {});
