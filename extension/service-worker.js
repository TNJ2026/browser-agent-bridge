const NATIVE_HOST = 'com.local.browser_agent_bridge';
const CDP_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 30000;
const PERMISSION_PROMPT_TIMEOUT_MS = 60000;
const CSP_BYPASS_DYNAMIC_RULE_ID = 10001;
const CSP_BYPASS_ALARM = 'clear-temporary-csp-bypass';
const DEFAULT_CSP_BYPASS_TTL_MS = 3 * 60 * 1000;
const APPROVAL_NOTIFICATION_ID = 'browser-agent-bridge-permission-approval';
const APPROVAL_POPUP_PATH = 'approval.html';
const DEFAULT_RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECORDING_MAX_ACTIONS = 500;
const MAX_RECORDING_MAX_ACTIONS = 5000;
const SESSION_STORAGE_KEY = 'browserAgentBridgeSessions';
const AGENT_TAB_GROUPS_STORAGE_KEY = 'browserAgentBridgeAgentTabGroups';
const POLICY_STORAGE_KEY = 'browserAgentBridgePolicy';
const RECORDINGS_STORAGE_KEY = 'browserAgentBridgeRecordings';

let nativePort = null;
let nextRequestId = 1;
let reconnectTimer = null;
let bridgeEnabledCache = false;
let nativeStatus = {
  state: 'stopped',
  hostName: NATIVE_HOST,
  bridgeEnabled: false,
  lastChecked: Date.now()
};
const pendingNativeRequests = new Map();
const attachedTabs = new Set();
const cdpEvents = [];
const networkEventsByTab = new Map();
const consoleEventsByTab = new Map();
const recordings = new Map();
let recordingsLoaded = false;
let nextPromptId = 1;
const pendingPrompts = new Map();
let approvalPopupWindowId = null;
let recordingsSaveTimer = null;
let cspBypassTimer = null;
let activeCspBypass = null;
const DEFAULT_POLICY = {
  blockedUrlPatterns: [
    'chrome://*',
    'chrome-extension://*',
    'chromewebstore.google.com/*'
  ],
  allowedUrlPatterns: [],
  blockedMethods: [],
  allowedMethods: []
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(['sessionPermissions', AGENT_TAB_GROUPS_STORAGE_KEY, SESSION_STORAGE_KEY]).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await initializeBridgeEnabled().catch(err => console.error(err));
  await connectNative();
  await initCspBypass().catch(err => console.error(err));
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.remove(['sessionPermissions', AGENT_TAB_GROUPS_STORAGE_KEY, SESSION_STORAGE_KEY]).catch(() => {});
  await initializeBridgeEnabled().catch(err => console.error(err));
  await connectNative();
  await initCspBypass().catch(err => console.error(err));
});

chrome.action.onClicked.addListener(async tab => {
  if (tab.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-side-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CSP_BYPASS_ALARM) {
    clearTemporaryCspBypass().catch(err => console.error('Error clearing temporary CSP bypass:', err));
  }
});

chrome.notifications.onClicked.addListener(notificationId => {
  if (notificationId === APPROVAL_NOTIFICATION_ID) {
    openApprovalPopup().catch(err => console.error('Error opening approval popup:', err));
    chrome.notifications.clear(notificationId).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender).then(sendResponse, error => {
    sendResponse({ ok: false, error: errorMessage(error) });
  });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const event = { source, method, params, timestamp: Date.now() };
  cdpEvents.push(event);
  if (cdpEvents.length > 1000) cdpEvents.shift();
  if (typeof tabId === 'number') {
    if (method.startsWith('Network.')) pushLimited(networkEventsByTab, tabId, event, 500);
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
      pushLimited(consoleEventsByTab, tabId, event, 200);
    }
  }
  sendNativeNotification('cdp.event', event);
});

chrome.debugger.onDetach.addListener(source => {
  if (typeof source.tabId === 'number') attachedTabs.delete(source.tabId);
});

chrome.windows.onRemoved.addListener(windowId => {
  if (windowId === approvalPopupWindowId) {
    approvalPopupWindowId = null;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  networkEventsByTab.delete(tabId);
  consoleEventsByTab.delete(tabId);
  loadSessions().then(async sessions => {
    let changed = false;
    for (const session of Object.values(sessions)) {
      if (!Array.isArray(session.tabIds) || !session.tabIds.includes(tabId)) continue;
      session.tabIds = session.tabIds.filter(id => id !== tabId);
      if (session.mainTabId === tabId) session.mainTabId = session.tabIds[0] || null;
      session.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await saveSessions(sessions);
  }).catch(() => {});
  ensureRecordingsLoaded().then(() => {
    let changed = false;
    for (const recording of recordings.values()) {
      if (recording.isRecording && recording.scope === 'tab' && recording.tabId === tabId) {
        recording.isRecording = false;
        recording.stoppedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) scheduleRecordingsSave();
  }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.agreedToDisclaimer?.newValue === true) {
      connectNative();
    }
    if (changes.bridgeEnabled !== undefined) {
      bridgeEnabledCache = changes.bridgeEnabled.newValue === true;
    }
    if (changes.enableRuntimeApproval !== undefined) {
      pushSettingsToNative();
    }
  }
});

initializeBridgeEnabled().then(connectNative).catch(err => console.error(err));
initCspBypass().catch(err => console.error(err));

async function initializeBridgeEnabled() {
  const result = await chrome.storage.local.get('bridgeEnabled');
  if (result.bridgeEnabled === undefined) {
    bridgeEnabledCache = false;
    await chrome.storage.local.set({ bridgeEnabled: false });
  } else {
    bridgeEnabledCache = result.bridgeEnabled === true;
  }
}

async function getBridgeEnabled() {
  const result = await chrome.storage.local.get('bridgeEnabled');
  bridgeEnabledCache = result.bridgeEnabled === true;
  return bridgeEnabledCache;
}

async function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);

  const result = await chrome.storage.local.get('agreedToDisclaimer');
  if (result.agreedToDisclaimer !== true) {
    setNativeStatus('disconnected', 'Pending disclaimer agreement');
    return;
  }
  if (!await getBridgeEnabled()) {
    setNativeStatus('stopped', 'Bridge stopped');
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    setNativeStatus('disconnected', errorMessage(error));
    scheduleReconnect();
    return;
  }

  setNativeStatus('connected');
  nativePort.onMessage.addListener(message => {
    if (message && message.jsonrpc === '2.0' && 'id' in message && !('method' in message)) {
      settleNativeResponse(message);
      return;
    }
    if (message && message.jsonrpc === '2.0' && message.method) {
      handleRpc(message).then(
        result => nativePort?.postMessage({ jsonrpc: '2.0', id: message.id, result }),
        error => nativePort?.postMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: errorMessage(error) }
        })
      );
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    nativePort = null;
    rejectPendingNativeRequests(error || 'Native host disconnected');
    getBridgeEnabled().then(enabled => {
      if (enabled) {
        setNativeStatus('disconnected', error);
        scheduleReconnect();
      } else {
        setNativeStatus('stopped', 'Bridge stopped');
      }
    }).catch(() => {
      setNativeStatus('disconnected', error);
    });
  });

  const portResult = await chrome.storage.local.get('bridgePort');
  const port = Number.isInteger(portResult.bridgePort) ? portResult.bridgePort : 8765;

  sendNativeNotification('extension.ready', {
    version: chrome.runtime.getManifest().version,
    port: port
  });

  await pushSettingsToNative();
}

async function pushSettingsToNative() {
  const result = await chrome.storage.local.get(['enableRuntimeApproval']);
  sendNativeNotification('extension.settings', {
    allowReadTabs: true,
    enableRuntimeApproval: result.enableRuntimeApproval !== false
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (await getBridgeEnabled()) {
      await connectNative();
    } else {
      setNativeStatus('stopped', 'Bridge stopped');
    }
  }, 3000);
}

function setNativeStatus(state, error) {
  nativeStatus = {
    state,
    hostName: NATIVE_HOST,
    bridgeEnabled: bridgeEnabledCache,
    lastChecked: Date.now(),
    ...(error ? { error } : {})
  };
  chrome.storage.local.set({ nativeStatus }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'NATIVE_STATUS_CHANGED', status: nativeStatus }).catch(() => {});
}

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case 'GET_NATIVE_STATUS':
      if (await getBridgeEnabled()) await connectNative();
      return { ok: nativeStatus.state === 'connected', status: nativeStatus };
    case 'START_BRIDGE':
      return { ok: true, status: await startBridge() };
    case 'STOP_BRIDGE':
      return { ok: true, status: await stopBridge() };
    case 'GET_CSP_BYPASS':
      return { ok: true, ...(await extensionGetCspBypass()) };
    case 'SET_CSP_BYPASS': {
      const bypass = message.enabled !== false;
      await chrome.storage.local.set({ bypassCSP: bypass });
      if (!bypass) await clearTemporaryCspBypass();
      return { ok: true };
    }
    case 'PERMISSION_RESPONSE': {
      const { promptId, response } = message;
      const pending = pendingPrompts.get(promptId);
      if (pending) {
        pending.resolve(response);
      }
      return { ok: true };
    }
    case 'GET_PENDING_PERMISSION_PROMPTS':
      return {
        ok: true,
        prompts: Array.from(pendingPrompts.entries()).map(([promptId, prompt]) => ({
          promptId,
          category: prompt.category,
          method: prompt.method,
          params: prompt.params
        }))
      };
    case 'RPC':
      return { ok: true, result: await handleRpc(message.request, sender) };
    case 'CONTENT_ACCESSIBILITY_TREE':
      return { ok: true, result: message.tree };
    case 'VISUAL_INDICATOR_READY':
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

async function startBridge() {
  await chrome.storage.local.set({ bridgeEnabled: true });
  bridgeEnabledCache = true;
  await connectNative();
  return nativeStatus;
}

async function stopBridge() {
  clearTimeout(reconnectTimer);
  await chrome.storage.local.set({ bridgeEnabled: false });
  bridgeEnabledCache = false;
  if (nativePort) {
    const port = nativePort;
    nativePort = null;
    port.disconnect();
  }
  rejectPendingNativeRequests('Bridge stopped by user');
  setNativeStatus('stopped', 'Bridge stopped');
  return nativeStatus;
}

async function handleRpc(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('Invalid JSON-RPC request');
  }
  await assertMethodAllowed(request.method);
  const params = request.params || {};
  await assertOptionalPermissions(request.method, params);
  await assertRpcTabIsolation(request.method, params);
  await checkPermission(request.method, params);
  switch (request.method) {
    case 'permission.check':
      return { allowed: true };
    case 'extension.info':
      return extensionInfo();
    case 'extension.reload':
      return extensionReload();
    case 'extension.getCspBypass':
      return extensionGetCspBypass();
    case 'native.status':
      return nativeStatus;
    case 'native.sitePatterns':
      return nativeRequest('native.sitePatterns', params);
    case 'tabs.list':
      return tabsList(params);
    case 'tabs.create':
      return tabsCreate(params);
    case 'tabs.activate':
      return tabsActivate(params);
    case 'tabs.close':
      return tabsClose(params);
    case 'tabs.group':
      return tabsGroup(params);
    case 'session.start':
      return sessionStart(params);
    case 'session.list':
      return sessionList();
    case 'session.get':
      return sessionGet(params);
    case 'session.createTab':
      return sessionCreateTab(params);
    case 'session.addTab':
      return sessionAddTab(params);
    case 'session.closeTab':
      return sessionCloseTab(params);
    case 'session.stop':
      return sessionStop(params);
    case 'page.navigate':
      return pageNavigate(params);
    case 'page.waitForLoad':
      return pageWaitForLoad(params);
    case 'page.waitForSelector':
      return pageWaitForSelector(params);
    case 'page.waitForText':
      return pageWaitForText(params);
    case 'page.readText':
      return pageReadText(params);
    case 'page.accessibilityTree':
      return pageAccessibilityTree(params);
    case 'page.screenshot':
      return pageScreenshot(params);
    case 'page.executeJavaScript':
      return pageExecuteJavaScript(params);
    case 'page.domSnapshot':
      return pageDomSnapshot(params);
    case 'dom.query':
      return domQuery(params);
    case 'dom.click':
      return domClick(params);
    case 'dom.type':
      return domType(params);
    case 'dom.select':
      return domSelect(params);
    case 'dom.hover':
      return domHover(params);
    case 'dom.scroll':
      return domScroll(params);
    case 'computer.click':
      return computerClick(params);
    case 'computer.drag':
      return computerDrag(params);
    case 'computer.type':
      return computerType(params);
    case 'computer.key':
      return computerKey(params);
    case 'computer.scroll':
      return computerScroll(params);
    case 'computer.hover':
      return computerHover(params);
    case 'console.read':
      return consoleRead(params);
    case 'network.read':
      return networkRead(params);
    case 'downloads.list':
      return downloadsList(params);
    case 'recording.start':
      return recordingStart(params);
    case 'recording.stop':
      return recordingStop(params);
    case 'recording.status':
      return recordingStatus(params);
    case 'recording.export':
      return recordingExport(params);
    case 'recording.clear':
      return recordingClear(params);
    case 'indicator.set':
      return indicatorSet(params);
    case 'policy.get':
      return policyGet();
    case 'policy.set':
      return policySet(params);
    case 'policy.checkUrl':
      return policyCheckUrl(params);
    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

async function extensionInfo() {
  return {
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    nativeStatus,
    tools: [
      'extension.info',
      'extension.reload',
      'extension.getCspBypass',
      'native.status',
      'native.sitePatterns',
      'tabs.list',
      'tabs.create',
      'tabs.activate',
      'tabs.close',
      'tabs.group',
      'session.start',
      'session.list',
      'session.get',
      'session.createTab',
      'session.addTab',
      'session.closeTab',
      'session.stop',
      'page.navigate',
      'page.waitForLoad',
      'page.waitForSelector',
      'page.waitForText',
      'page.readText',
      'page.accessibilityTree',
      'page.screenshot',
      'page.executeJavaScript',
      'page.domSnapshot',
      'dom.query',
      'dom.click',
      'dom.type',
      'dom.select',
      'dom.hover',
      'dom.scroll',
      'computer.click',
      'computer.drag',
      'computer.type',
      'computer.key',
      'computer.scroll',
      'computer.hover',
      'console.read',
      'network.read',
      'downloads.list',
      'recording.start',
      'recording.stop',
      'recording.status',
      'recording.export',
      'recording.clear',
      'indicator.set',
      'policy.get',
      'policy.set',
      'policy.checkUrl'
    ]
  };
}

async function initCspBypass() {
  const result = await chrome.storage.local.get('bypassCSP');
  let bypass = result.bypassCSP;
  if (bypass === undefined) {
    bypass = true;
    await chrome.storage.local.set({ bypassCSP: true });
  }
  await disableStaticCspRuleset();
  await clearTemporaryCspBypass();
}

async function disableStaticCspRuleset() {
  const rulesetId = 'ruleset_1';
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    disableRulesetIds: [rulesetId]
  }).catch(() => {});
}

async function extensionGetCspBypass() {
  const result = await chrome.storage.local.get('bypassCSP');
  const activeResult = await chrome.storage.local.get('cspBypassActive');
  return {
    enabled: result.bypassCSP === true,
    mode: 'temporary-origin',
    active: activeCspBypass || activeResult.cspBypassActive || null
  };
}

function cspBypassResponseHeaders() {
  return [
    { header: 'content-security-policy', operation: 'remove' },
    { header: 'content-security-policy-report-only', operation: 'remove' },
    { header: 'x-webkit-csp', operation: 'remove' },
    { header: 'x-content-security-policy', operation: 'remove' }
  ];
}

function cspBypassResourceTypes() {
  return [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other'
  ];
}

function cspBypassUrlFilter(origin) {
  return `|${origin}/*`;
}

function normalizeCspBypassTtl(value) {
  if (!Number.isFinite(value)) return DEFAULT_CSP_BYPASS_TTL_MS;
  return Math.max(10 * 1000, Math.min(Math.trunc(value), 10 * 60 * 1000));
}

async function maybeEnableTemporaryCspBypass(tabId, params = {}) {
  const tab = await chrome.tabs.get(tabId);
  return maybeEnableTemporaryCspBypassForUrl(tab.url || '', params);
}

async function maybeEnableTemporaryCspBypassForUrl(urlString, params = {}) {
  const result = await chrome.storage.local.get('bypassCSP');
  if (result.bypassCSP !== true || params.bypassCSP === false) return null;

  let url;
  try {
    url = new URL(urlString);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const ttlMs = normalizeCspBypassTtl(params.cspBypassTtlMs);
  const expiresAt = Date.now() + ttlMs;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CSP_BYPASS_DYNAMIC_RULE_ID],
    addRules: [{
      id: CSP_BYPASS_DYNAMIC_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: cspBypassResponseHeaders()
      },
      condition: {
        urlFilter: cspBypassUrlFilter(url.origin),
        resourceTypes: cspBypassResourceTypes()
      }
    }]
  });

  activeCspBypass = {
    origin: url.origin,
    ruleId: CSP_BYPASS_DYNAMIC_RULE_ID,
    expiresAt,
    ttlMs
  };
  await chrome.storage.local.set({ cspBypassActive: activeCspBypass });
  clearTimeout(cspBypassTimer);
  cspBypassTimer = setTimeout(() => {
    clearTemporaryCspBypass().catch(err => console.error('Error clearing temporary CSP bypass:', err));
  }, ttlMs);
  await chrome.alarms.create(CSP_BYPASS_ALARM, { when: expiresAt });
  return activeCspBypass;
}

async function clearTemporaryCspBypass() {
  clearTimeout(cspBypassTimer);
  cspBypassTimer = null;
  activeCspBypass = null;
  await chrome.storage.local.remove('cspBypassActive').catch(() => {});
  await chrome.alarms.clear(CSP_BYPASS_ALARM).catch(() => {});
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CSP_BYPASS_DYNAMIC_RULE_ID]
  }).catch(err => console.error('Error removing temporary CSP bypass rule:', err));
}

async function extensionReload() {
  setTimeout(() => chrome.runtime.reload(), 50);
  return { reloading: true };
}

async function tabsList(params) {
  const tabs = await chrome.tabs.query(params.query || {});
  return {
    tabs: tabs.map(tab => ({
      id: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      active: tab.active,
      highlighted: tab.highlighted,
      pinned: tab.pinned,
      title: tab.title,
      url: tab.url,
      status: tab.status,
      favIconUrl: tab.favIconUrl
    }))
  };
}

async function tabsCreate(params) {
  assertString(params.url, 'url');
  await assertUrlAllowed(params.url, 'tabs.create');
  await maybeEnableTemporaryCspBypassForUrl(params.url, params);
  const tab = await chrome.tabs.create({
    url: params.url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
  });
  if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  
  try {
    if (!chrome.tabGroups || !chrome.tabs.group) {
      throw new Error('Chrome tab groups API is unavailable');
    }
    const groups = await chrome.tabGroups.query({ title: '🤖 Agent', windowId: tab.windowId });
    const managedGroups = await loadAgentTabGroups();
    const group = groups.find(item => managedGroups.has(item.id));
    if (group) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: '🤖 Agent', color: 'green' });
      await rememberAgentTabGroup(groupId);
    }
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(`Failed to create Agent-managed tab: ${errorMessage(e)}`);
  }

  return { tab: normalizeTab(await chrome.tabs.get(tab.id)) };
}

async function tabsActivate(params) {
  const tabId = assertTabId(params.tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { tab: normalizeTab(tab) };
}

async function tabsClose(params) {
  const tabIds = Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
  await chrome.tabs.remove(tabIds);
  return { closed: tabIds };
}

async function tabsGroup(params) {
  const tabIds = Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
  const options = { tabIds };
  if (typeof params.groupId === 'number') {
    options.groupId = params.groupId;
  }
  const groupId = await chrome.tabs.group(options);
  if (params.title || params.color) {
    await chrome.tabGroups.update(groupId, {
      ...(params.title ? { title: String(params.title) } : {}),
      ...(params.color ? { color: params.color } : {})
    });
  }
  await rememberAgentTabGroup(groupId).catch(() => {});
  return { groupId };
}

async function sessionStart(params) {
  let name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Agent';
  if (!name.startsWith('🤖')) {
    name = `🤖 ${name}`;
  }
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  if (url !== 'about:blank') await assertUrlAllowed(url, 'session.start');
  if (url !== 'about:blank') await maybeEnableTemporaryCspBypassForUrl(url, params);
  const tab = await chrome.tabs.create({
    url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
  });
  if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  
  let groupId = null;
  try {
    if (!chrome.tabGroups || !chrome.tabs.group) {
      throw new Error('Chrome tab groups API is unavailable');
    }
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, {
      title: name,
      color: params.color || 'green'
    }).catch(() => {});
    await rememberAgentTabGroup(groupId);
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(`Failed to create Agent session tab group: ${errorMessage(e)}`);
  }

  const session = {
    id: crypto.randomUUID(),
    name,
    groupId,
    mainTabId: tab.id,
    tabIds: [tab.id],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const sessions = await loadSessions();
  sessions[session.id] = session;
  await saveSessions(sessions);
  return { session, tab: normalizeTab(await chrome.tabs.get(tab.id)) };
}

async function sessionList() {
  const sessions = [];
  for (const session of Object.values(await loadSessions())) {
    if (await isSessionManaged(session)) sessions.push(session);
  }
  return { sessions };
}

async function sessionGet(params) {
  const session = await requireSession(params.sessionId);
  const tabs = [];
  for (const tabId of session.tabIds || []) {
    try {
      tabs.push(normalizeTab(await chrome.tabs.get(tabId)));
    } catch {}
  }
  return { session, tabs };
}

function uniqueTabIds(tabIds) {
  return Array.from(new Set(tabIds.filter(Number.isInteger)));
}

async function sessionCreateTab(params) {
  const session = await requireSession(params.sessionId);
  let windowId = undefined;
  if (typeof session.groupId === 'number' && chrome.tabGroups) {
    try {
      const group = await chrome.tabGroups.get(session.groupId);
      if (group) windowId = group.windowId;
    } catch (e) {
      console.warn('Failed to get session tab group:', e);
    }
  }
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  if (url !== 'about:blank') await assertUrlAllowed(url, 'session.createTab');
  if (url !== 'about:blank') await maybeEnableTemporaryCspBypassForUrl(url, params);
  const tab = await chrome.tabs.create({
    url,
    active: params.active !== false,
    ...(windowId !== undefined ? { windowId } : {})
  });
  if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  try {
    if (typeof session.groupId !== 'number' || !chrome.tabs.group) {
      throw new Error('Session has no Agent-managed tab group');
    }
    await chrome.tabs.group({ tabIds: [tab.id], groupId: session.groupId });
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(`Failed to add created tab to session group: ${errorMessage(e)}`);
  }
  const sessions = await loadSessions();
  const storedSession = sessions[session.id];
  storedSession.tabIds = uniqueTabIds([...(storedSession.tabIds || []), tab.id]);
  storedSession.updatedAt = new Date().toISOString();
  await saveSessions(sessions);
  return { session: storedSession, tab: normalizeTab(await chrome.tabs.get(tab.id)) };
}

async function sessionAddTab(params) {
  const session = await requireSession(params.sessionId);
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'session.addTab');
  const tab = await chrome.tabs.get(tabId);
  if (typeof session.groupId === 'number' && chrome.tabGroups) {
    try {
      const group = await chrome.tabGroups.get(session.groupId);
      if (group && tab.windowId !== group.windowId) {
        throw new Error(`Tab ${tabId} is in a different window from session ${session.id}`);
      }
    } catch (e) {
      console.warn('Failed to check session tab group window:', e);
    }
  }
  if (typeof session.groupId === 'number' && chrome.tabs.group) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId }).catch(e => {
      console.warn('Failed to add tab to session group:', e);
    });
  }
  const sessions = await loadSessions();
  const storedSession = sessions[session.id];
  storedSession.tabIds = uniqueTabIds([...(storedSession.tabIds || []), tabId]);
  storedSession.updatedAt = new Date().toISOString();
  await saveSessions(sessions);
  return { session: storedSession, tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

async function sessionCloseTab(params) {
  const session = await requireSession(params.sessionId);
  const tabId = assertTabId(params.tabId);
  if (!Array.isArray(session.tabIds) || !session.tabIds.includes(tabId)) {
    throw new Error(`Tab ${tabId} is not part of session ${session.id}`);
  }
  const sessions = await loadSessions();
  const storedSession = sessions[session.id];
  storedSession.tabIds = (storedSession.tabIds || []).filter(id => id !== tabId);
  storedSession.updatedAt = new Date().toISOString();
  if (storedSession.mainTabId === tabId) {
    storedSession.mainTabId = storedSession.tabIds[0] || null;
  }
  await saveSessions(sessions);
  await chrome.tabs.remove(tabId);
  return { session: storedSession, closed: tabId };
}

async function sessionStop(params) {
  const session = await requireSession(params.sessionId);
  if (params.closeTabs === true && Array.isArray(session.tabIds) && session.tabIds.length > 0) {
    await chrome.tabs.remove(session.tabIds).catch(() => {});
  } else if (Array.isArray(session.tabIds) && chrome.tabs.ungroup) {
    await chrome.tabs.ungroup(session.tabIds).catch(() => {});
  }
  const sessions = await loadSessions();
  delete sessions[session.id];
  await saveSessions(sessions);
  return { stopped: session.id };
}

async function pageNavigate(params) {
  const tabId = assertTabId(params.tabId);
  assertString(params.url, 'url');
  await assertUrlAllowed(params.url, 'page.navigate');
  await maybeEnableTemporaryCspBypassForUrl(params.url, params);
  await recordAction(tabId, 'navigate.start', { url: params.url });
  const tab = await chrome.tabs.update(tabId, { url: params.url });
  if (params.wait !== false) await waitForTabComplete(tabId, params.timeoutMs);
  const result = { tab: normalizeTab(await chrome.tabs.get(tabId)) };
  await recordAction(tabId, 'navigate.complete', { url: params.url }, result);
  return result;
}

async function pageWaitForLoad(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.waitForLoad');
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== 'complete') await waitForTabComplete(tabId, params.timeoutMs);
  return { tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

async function pageWaitForSelector(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.waitForSelector');
  assertString(params.selector, 'selector');
  const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
  const visible = params.visible === true;
  const started = Date.now();
  let last = null;

  while (Date.now() - started <= timeoutMs) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, visible, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = root.querySelector(selector);
        if (!element) return { found: false };
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        return {
          found: visible ? isVisible : true,
          visible: isVisible,
          tagName: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || '').trim().slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };

        function resolveDomRoot(frameSelector) {
          if (!frameSelector) return document;
          const frame = document.querySelector(frameSelector);
          if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
          try {
            if (!frame.contentDocument) throw new Error('Frame document is not accessible');
            return frame.contentDocument;
          } catch {
            throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
          }
        }
      },
      args: [params.selector, visible, params.frameSelector || null],
      world: 'MAIN'
    });
    last = result;
    if (result?.found) return { ok: true, element: result, elapsedMs: Date.now() - started };
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for selector: ${params.selector}${last?.visible === false ? ' (found but not visible)' : ''}`);
}

async function pageWaitForText(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.waitForText');
  assertString(params.text, 'text');
  const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
  const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;
  const exact = params.exact === true;
  const caseSensitive = params.caseSensitive === true;
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (text, selector, exact, caseSensitive, frameSelector) => {
        const doc = resolveDomRoot(frameSelector);
        const root = selector ? doc.querySelector(selector) : doc.body;
        if (!root) return { found: false, selectorFound: false };
        const source = root.innerText || root.textContent || '';
        const haystack = caseSensitive ? source : source.toLowerCase();
        const needle = caseSensitive ? text : text.toLowerCase();
        const found = exact ? haystack.trim() === needle : haystack.includes(needle);
        return {
          found,
          selectorFound: true,
          textLength: source.length,
          preview: source.trim().slice(0, 500)
        };

        function resolveDomRoot(frameSelector) {
          if (!frameSelector) return document;
          const frame = document.querySelector(frameSelector);
          if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
          try {
            if (!frame.contentDocument) throw new Error('Frame document is not accessible');
            return frame.contentDocument;
          } catch {
            throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
          }
        }
      },
      args: [params.text, selector, exact, caseSensitive, params.frameSelector || null],
      world: 'MAIN'
    });
    if (result?.found) return { ok: true, match: result, elapsedMs: Date.now() - started };
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for text: ${params.text}`);
}

async function pageReadText(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.readText');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: location.href,
      title: document.title,
      text: document.body?.innerText || '',
      selection: String(getSelection?.() || '')
    })
  });
  return result;
}

async function pageAccessibilityTree(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.accessibilityTree');
  
  await ensureContentScripts(tabId, 0);
  const mainResponse = await chrome.tabs.sendMessage(tabId, {
    type: 'GET_ACCESSIBILITY_TREE',
    maxNodes: params.maxNodes || 1000
  }, { frameId: 0 });
  
  if (!mainResponse?.ok) throw new Error(mainResponse?.error || 'Failed to read accessibility tree');
  
  const tree = mainResponse.tree;
  const collectedIframes = tree.iframes || [];
  
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    frames.sort((a, b) => a.frameId - b.frameId);
    
    for (const frame of frames) {
      if (frame.frameId === 0) continue;
      
      const match = collectedIframes.find(sub => {
        if (!sub.src || !frame.url) return false;
        try {
          const subUrl = new URL(sub.src, frame.url).href;
          return subUrl === frame.url || frame.url.startsWith(subUrl) || subUrl.startsWith(frame.url);
        } catch {
          return sub.src.includes(frame.url) || frame.url.includes(sub.src);
        }
      });
      
      if (match) {
        await ensureContentScripts(tabId, frame.frameId);
        const subResponse = await chrome.tabs.sendMessage(tabId, {
          type: 'GET_ACCESSIBILITY_TREE',
          maxNodes: params.maxNodes || 1000,
          offsetX: match.x,
          offsetY: match.y
        }, { frameId: frame.frameId });
        
        if (subResponse?.ok && subResponse.tree?.nodes) {
          tree.nodes.push(...subResponse.tree.nodes);
          if (subResponse.tree.iframes) {
            collectedIframes.push(...subResponse.tree.iframes);
          }
        }
      }
    }
  } catch (e) {
    console.warn('Subframe accessibility tree collection failed:', e);
  }
  
  delete tree.iframes;
  return tree;
}

async function pageScreenshot(params) {
  const tabId = assertTabId(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  await assertUrlAllowed(tab.url || '', 'page.screenshot');
  const dataUrl = await captureTabScreenshot(tabId, params);
  return { dataUrl };
}

async function pageExecuteJavaScript(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.executeJavaScript');
  await maybeEnableTemporaryCspBypass(tabId, params);
  assertString(params.script, 'script');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: script => {
      return Promise.resolve((0, eval)(script));
    },
    args: [params.script],
    world: params.world === 'isolated' ? 'ISOLATED' : 'MAIN'
  });
  return { value: result };
}

async function pageDomSnapshot(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'page.domSnapshot');
  await attachDebugger(tabId);
  const result = await cdp(tabId, 'DOMSnapshot.captureSnapshot', {
    computedStyles: Array.isArray(params.computedStyles) ? params.computedStyles : [],
    includeDOMRects: params.includeDOMRects !== false,
    includePaintOrder: params.includePaintOrder === true
  });
  return result;
}

async function domQuery(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.query');
  assertString(params.selector, 'selector');
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 200) : 50;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, limit, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      return Array.from(root.querySelectorAll(selector)).slice(0, limit).map((element, index) => summarizeElement(element, index));

      function summarizeElement(element, index) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          index,
          tagName: element.tagName.toLowerCase(),
          id: element.id || '',
          name: element.getAttribute('name') || '',
          placeholder: element.getAttribute('placeholder') || '',
          role: element.getAttribute('role') || '',
          type: element.getAttribute('type') || '',
          text: (element.innerText || element.textContent || '').trim().slice(0, 500),
          value: 'value' in element ? String(element.value).slice(0, 500) : '',
          ariaLabel: element.getAttribute('aria-label') || '',
          href: element.href || '',
          disabled: Boolean(element.disabled),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        };
      }

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector, limit, params.frameSelector || null],
    world: 'MAIN'
  });
  return { elements: result || [] };
}

async function domClick(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.click');
  assertString(params.selector, 'selector');
  const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, index, scroll, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      const element = root.querySelectorAll(selector)[index];
      if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
      if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof element.focus === 'function') element.focus({ preventScroll: true });
      element.click();
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || '').trim().slice(0, 500),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector, index, params.scrollIntoView !== false, params.frameSelector || null],
    world: 'MAIN'
  });
  await recordAction(tabId, 'dom.click', { selector: params.selector, index, frameSelector: params.frameSelector || null }, result);
  return { ok: true, element: result };
}

async function domType(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.type');
  assertString(params.selector, 'selector');
  assertString(params.text, 'text');
  const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
  const replace = params.replace !== false;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, index, text, replace, scroll, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      const element = root.querySelectorAll(selector)[index];
      if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
      if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof element.focus === 'function') element.focus({ preventScroll: true });
      if (element.isContentEditable) {
        if (replace) element.textContent = text;
        else element.textContent = `${element.textContent || ''}${text}`;
      } else if ('value' in element) {
        element.value = replace ? text : `${element.value || ''}${text}`;
      } else {
        throw new Error('Element is not editable');
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        value: 'value' in element ? String(element.value) : element.textContent || '',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector, index, params.text, replace, params.scrollIntoView !== false, params.frameSelector || null],
    world: 'MAIN'
  });
  await recordAction(tabId, 'dom.type', { selector: params.selector, index, text: params.text, replace, frameSelector: params.frameSelector || null }, result);
  return { ok: true, element: result };
}

async function domSelect(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.select');
  assertString(params.selector, 'selector');
  assertString(params.value, 'value');
  const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, index, value, scroll, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      const element = root.querySelectorAll(selector)[index];
      if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
      if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a select');
      if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const option = element.selectedOptions[0] || null;
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        value: element.value,
        text: option ? option.textContent : '',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector, index, params.value, params.scrollIntoView !== false, params.frameSelector || null],
    world: 'MAIN'
  });
  await recordAction(tabId, 'dom.select', { selector: params.selector, index, value: params.value, frameSelector: params.frameSelector || null }, result);
  return { ok: true, element: result };
}

async function domHover(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.hover');
  assertString(params.selector, 'selector');
  const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, index, scroll, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      const element = root.querySelectorAll(selector)[index];
      if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
      if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
      
      // Dispatch mouseover/mouseenter events to simulate hover
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || '').trim().slice(0, 500),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector, index, params.scrollIntoView !== false, params.frameSelector || null],
    world: 'MAIN'
  });
  await recordAction(tabId, 'dom.hover', { selector: params.selector, index, frameSelector: params.frameSelector || null }, result);
  return { ok: true, element: result };
}

async function domScroll(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'dom.scroll');
  const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
  const x = typeof params.x === 'number' ? params.x : 0;
  const y = typeof params.y === 'number' ? params.y : 0;
  const mode = params.mode === 'scrollTo' ? 'scrollTo' : 'scrollBy';
  const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, index, x, y, mode, behavior, frameSelector) => {
      const root = resolveDomRoot(frameSelector);
      let target;
      if (selector) {
        target = root.querySelectorAll(selector)[index];
        if (!target) throw new Error(`Element not found: ${selector} at index ${index}`);
      } else {
        target = frameSelector ? root.defaultView || root : window;
      }

      if (target.scrollBy || target.scrollTo) {
        target[mode]({ left: x, top: y, behavior });
      } else if (target.document && (target.document.documentElement || target.document.body)) {
        const docEl = target.document.documentElement || target.document.body;
        docEl[mode]({ left: x, top: y, behavior });
      } else {
        target[mode]({ left: x, top: y, behavior });
      }

      let currentX = 0;
      let currentY = 0;
      if (target === window || target.defaultView) {
        currentX = window.scrollX;
        currentY = window.scrollY;
      } else if (target) {
        currentX = target.scrollLeft;
        currentY = target.scrollTop;
      }

      return {
        scrolled: true,
        scrollLeft: currentX,
        scrollTop: currentY
      };

      function resolveDomRoot(frameSelector) {
        if (!frameSelector) return document;
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
        try {
          if (!frame.contentDocument) throw new Error('Frame document is not accessible');
          return frame.contentDocument;
        } catch {
          throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
        }
      }
    },
    args: [params.selector || null, index, x, y, mode, behavior, params.frameSelector || null],
    world: 'MAIN'
  });

  await recordAction(tabId, 'dom.scroll', { selector: params.selector || null, index, x, y, mode, behavior, frameSelector: params.frameSelector || null }, result);
  return { ok: true, result };
}

async function computerClick(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.click');
  await attachDebugger(tabId);
  const x = assertNumber(params.x, 'x');
  const y = assertNumber(params.y, 'y');
  const button = params.button || 'left';
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount: params.clickCount || 1
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount: params.clickCount || 1
  });
  if (params.showIndicator === true) {
    await indicatorSet({ tabId, visible: true, x, y, label: params.indicatorLabel || 'click' }).catch(() => {});
  }
  await recordAction(tabId, 'computer.click', { x, y, button, clickCount: params.clickCount || 1 });
  return { ok: true };
}

async function computerDrag(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.drag');
  await attachDebugger(tabId);
  const fromX = assertNumber(params.fromX, 'fromX');
  const fromY = assertNumber(params.fromY, 'fromY');
  const toX = assertNumber(params.toX, 'toX');
  const toY = assertNumber(params.toY, 'toY');
  const button = params.button || 'left';
  const steps = Number.isInteger(params.steps) && params.steps > 0 ? params.steps : 12;
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
      button,
      buttons: 1
    });
  }
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, clickCount: 1 });
  if (params.showIndicator === true) {
    await indicatorSet({ tabId, visible: true, x: toX, y: toY, label: params.indicatorLabel || 'drag' }).catch(() => {});
  }
  await recordAction(tabId, 'computer.drag', { fromX, fromY, toX, toY, button, steps });
  return { ok: true };
}

async function computerType(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.type');
  assertString(params.text, 'text');
  await attachDebugger(tabId);
  await cdp(tabId, 'Input.insertText', { text: params.text });
  await recordAction(tabId, 'computer.type', { text: params.text });
  return { ok: true };
}

function parseKeyModifiers(keyString) {
  let modifiers = 0;
  let key = keyString;
  const parts = keyString.split('+');
  if (parts.length > 1) {
    key = parts.pop();
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'alt') modifiers |= 1;
      else if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
      else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers |= 4;
      else if (lower === 'shift') modifiers |= 8;
    }
  }
  return { key, modifiers };
}

async function computerKey(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.key');
  assertString(params.key, 'key');
  await attachDebugger(tabId);
  
  const { key, modifiers } = parseKeyModifiers(params.key);
  
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    modifiers,
    text: key.length === 1 ? key : undefined
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    modifiers
  });
  await recordAction(tabId, 'computer.key', { key: params.key });
  return { ok: true };
}

async function computerScroll(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.scroll');
  await attachDebugger(tabId);
  const x = typeof params.x === 'number' ? params.x : 400;
  const y = typeof params.y === 'number' ? params.y : 400;
  const deltaX = typeof params.deltaX === 'number' ? params.deltaX : 0;
  const deltaY = typeof params.deltaY === 'number' ? params.deltaY : 500;
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY
  });
  await recordAction(tabId, 'computer.scroll', { x, y, deltaX, deltaY });
  return { ok: true };
}

async function computerHover(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.hover');
  await attachDebugger(tabId);
  const x = assertNumber(params.x, 'x');
  const y = assertNumber(params.y, 'y');
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  });
  if (params.showIndicator === true) {
    await indicatorSet({ tabId, visible: true, x, y, label: params.indicatorLabel || 'hover' }).catch(() => {});
  }
  await recordAction(tabId, 'computer.hover', { x, y });
  return { ok: true };
}

async function consoleRead(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'console.read');
  await attachDebugger(tabId);
  await cdp(tabId, 'Runtime.enable').catch(() => {});
  return { events: (consoleEventsByTab.get(tabId) || []).slice(-(params.limit || 100)) };
}

async function networkRead(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'network.read');
  await attachDebugger(tabId);
  await cdp(tabId, 'Network.enable').catch(() => {});
  return { events: (networkEventsByTab.get(tabId) || []).slice(-(params.limit || 100)) };
}

async function downloadsList(params) {
  const query = {
    limit: Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50,
    orderBy: ['-startTime'],
    ...(typeof params.query === 'string' && params.query ? { query: [params.query] } : {}),
    ...(typeof params.filenameRegex === 'string' ? { filenameRegex: params.filenameRegex } : {}),
    ...(typeof params.urlRegex === 'string' ? { urlRegex: params.urlRegex } : {})
  };
  const items = await chrome.downloads.search(query);
  return {
    items: items.map(item => ({
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      state: item.state,
      danger: item.danger,
      exists: item.exists,
      paused: item.paused,
      startTime: item.startTime,
      endTime: item.endTime,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes
    }))
  };
}

async function recordingStart(params) {
  await ensureRecordingsLoaded();
  await pruneExpiredRecordings();
  const tabId = params.tabId == null ? null : assertTabId(params.tabId);
  const hasExplicitGroup = typeof params.groupId === 'number';
  const groupId = hasExplicitGroup ? params.groupId : tabId == null ? null : (await chrome.tabs.get(tabId)).groupId;
  if (tabId == null && groupId == null) throw new Error('recording.start requires tabId or groupId');
  const retentionMs = normalizeRecordingRetention(params.retentionMs);
  const maxActions = normalizeRecordingMaxActions(params.maxActions);
  const now = Date.now();
  const recording = {
    id: crypto.randomUUID(),
    name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Recording',
    scope: hasExplicitGroup ? 'group' : 'tab',
    tabId,
    groupId,
    captureScreenshots: params.captureScreenshots === true,
    includeText: params.includeText === true,
    maxActions,
    retentionMs,
    expiresAt: new Date(now + retentionMs).toISOString(),
    isRecording: true,
    startedAt: new Date(now).toISOString(),
    stoppedAt: null,
    actions: []
  };
  recordings.set(recording.id, recording);
  await saveRecordingsNow();
  if (tabId != null && recording.captureScreenshots) {
    await recordAction(tabId, 'recording.initial_state', {}, undefined, recording.id);
  }
  return { recording: summarizeRecording(recording) };
}

async function recordingStop(params) {
  await ensureRecordingsLoaded();
  await pruneExpiredRecordings();
  const recording = requireRecording(params.recordingId);
  recording.isRecording = false;
  recording.stoppedAt = new Date().toISOString();
  await saveRecordingsNow();
  return { recording: summarizeRecording(recording) };
}

async function recordingStatus(params) {
  await ensureRecordingsLoaded();
  await pruneExpiredRecordings();
  if (params.recordingId) {
    return { recording: summarizeRecording(requireRecording(params.recordingId)) };
  }
  return { recordings: Array.from(recordings.values()).map(summarizeRecording) };
}

async function recordingExport(params) {
  await ensureRecordingsLoaded();
  await pruneExpiredRecordings();
  const recording = requireRecording(params.recordingId);
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    recording
  };
  if (params.download === true) {
    const filename = safeFilename(params.filename || `${recording.name}-${recording.id}.json`);
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: params.saveAs === true });
    return { downloadId, recording: summarizeRecording(recording) };
  }
  return payload;
}

async function recordingClear(params) {
  await ensureRecordingsLoaded();
  await pruneExpiredRecordings();
  if (params.recordingId) {
    recordings.delete(params.recordingId);
    await saveRecordingsNow();
    return { cleared: [params.recordingId] };
  }
  const ids = Array.from(recordings.keys());
  recordings.clear();
  await saveRecordingsNow();
  return { cleared: ids };
}

async function indicatorSet(params) {
  const tabId = assertTabId(params.tabId);
  await ensureContentScripts(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'SET_VISUAL_INDICATOR',
    state: {
      visible: params.visible !== false,
      x: typeof params.x === 'number' ? params.x : null,
      y: typeof params.y === 'number' ? params.y : null,
      label: params.label || 'agent'
    }
  });
  if (!response?.ok) throw new Error(response?.error || 'Failed to update indicator');
  return { ok: true };
}

async function policyGet() {
  return await loadPolicy();
}

async function policySet(params) {
  const policy = {
    blockedUrlPatterns: normalizePatternList(params.blockedUrlPatterns),
    allowedUrlPatterns: normalizePatternList(params.allowedUrlPatterns),
    blockedMethods: normalizePatternList(params.blockedMethods),
    allowedMethods: normalizePatternList(params.allowedMethods)
  };
  await chrome.storage.local.set({ [POLICY_STORAGE_KEY]: policy });
  return { policy };
}

async function policyCheckUrl(params) {
  if (typeof params.url !== 'string' && typeof params.method !== 'string') {
    throw new Error('policy.checkUrl requires url or method');
  }
  const policy = await loadPolicy();
  return {
    url: params.url,
    method: params.method,
    allowed: (typeof params.url === 'string' ? isUrlAllowedByPolicy(params.url, policy) : true)
      && (typeof params.method === 'string' ? isMethodAllowedByPolicy(params.method, policy) : true),
    matchedBlockedPattern: typeof params.url === 'string' ? firstMatchingPattern(params.url, policy.blockedUrlPatterns) : null,
    matchedAllowedPattern: typeof params.url === 'string' ? firstMatchingPattern(params.url, policy.allowedUrlPatterns) : null,
    matchedBlockedMethod: typeof params.method === 'string' ? firstMatchingPattern(params.method, policy.blockedMethods) : null,
    matchedAllowedMethod: typeof params.method === 'string' ? firstMatchingPattern(params.method, policy.allowedMethods) : null
  };
}

async function attachDebugger(tabId) {
  // Ensure the tab window is focused and the tab is active
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) {
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
      }
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (err) {
    console.error('Error focusing tab/window:', err);
  }

  if (attachedTabs.has(tabId)) return;
  await withTimeout(chrome.debugger.attach({ tabId }, CDP_VERSION), DEFAULT_TIMEOUT_MS, 'debugger.attach');
  attachedTabs.add(tabId);
  await cdp(tabId, 'Runtime.enable').catch(() => {});
  await cdp(tabId, 'Network.enable').catch(() => {});
}

async function cdp(tabId, method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), timeoutMs, method);
}

async function ensureContentScripts(tabId, frameId = 0) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING_AGENT_BRIDGE_CONTENT' }, { frameId });
    if (response?.ok) return;
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ['content/accessibility-tree.js', 'content/visual-indicator.js']
  });
}

function waitForTabComplete(tabId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for tab load')), timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sendNativeNotification(method, params) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ jsonrpc: '2.0', method, params });
  } catch {}
}

function settleNativeResponse(message) {
  const pending = pendingNativeRequests.get(String(message.id));
  if (!pending) return;
  pendingNativeRequests.delete(String(message.id));
  if (message.error) pending.reject(new Error(message.error.message || 'Native request failed'));
  else pending.resolve(message.result);
}

function rejectPendingNativeRequests(message) {
  for (const pending of pendingNativeRequests.values()) pending.reject(new Error(message));
  pendingNativeRequests.clear();
}

function nativeRequest(method, params) {
  if (!nativePort) throw new Error('Native host is not connected');
  const id = String(nextRequestId++);
  nativePort.postMessage({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingNativeRequests.delete(id);
      reject(new Error(`Native request timed out: ${method}`));
    }, 30000);
    pendingNativeRequests.set(id, {
      resolve: value => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  });
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active,
    title: tab.title,
    url: tab.url,
    status: tab.status
  };
}

async function loadSessions() {
  const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  return result[SESSION_STORAGE_KEY] && typeof result[SESSION_STORAGE_KEY] === 'object' ? result[SESSION_STORAGE_KEY] : {};
}

async function saveSessions(sessions) {
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: sessions });
}

async function requireSession(sessionId) {
  assertString(sessionId, 'sessionId');
  const sessions = await loadSessions();
  const session = sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

function sessionGroupIds(sessions) {
  return new Set(
    Object.values(sessions)
      .map(session => session && session.groupId)
      .filter(groupId => typeof groupId === 'number')
  );
}

async function loadAgentTabGroups() {
  const result = await chrome.storage.local.get(AGENT_TAB_GROUPS_STORAGE_KEY);
  const groupIds = result[AGENT_TAB_GROUPS_STORAGE_KEY];
  return new Set(Array.isArray(groupIds) ? groupIds.filter(groupId => typeof groupId === 'number') : []);
}

async function rememberAgentTabGroup(groupId) {
  if (typeof groupId !== 'number' || groupId < 0) return;
  const groupIds = await loadAgentTabGroups();
  groupIds.add(groupId);
  await chrome.storage.local.set({ [AGENT_TAB_GROUPS_STORAGE_KEY]: Array.from(groupIds) });
}

async function isAgentManagedGroupId(groupId, sessions = null) {
  if (typeof groupId !== 'number' || groupId < 0) return false;
  const knownGroupIds = sessionGroupIds(sessions || await loadSessions());
  if (knownGroupIds.has(groupId)) return true;
  return (await loadAgentTabGroups()).has(groupId);
}

async function areAgentManagedTabs(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return false;
  const sessions = await loadSessions();
  for (const tabId of tabIds) {
    if (typeof tabId !== 'number') return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const isManaged = tab ? await isAgentManagedGroupId(tab.groupId, sessions) : false;
    if (!isManaged) return false;
  }
  return true;
}

async function loadPolicy() {
  const result = await chrome.storage.local.get(POLICY_STORAGE_KEY);
  const stored = result[POLICY_STORAGE_KEY];
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_POLICY };
  return {
    blockedUrlPatterns: normalizePatternList(stored.blockedUrlPatterns, DEFAULT_POLICY.blockedUrlPatterns),
    allowedUrlPatterns: normalizePatternList(stored.allowedUrlPatterns),
    blockedMethods: normalizePatternList(stored.blockedMethods, DEFAULT_POLICY.blockedMethods),
    allowedMethods: normalizePatternList(stored.allowedMethods, DEFAULT_POLICY.allowedMethods)
  };
}

async function assertMethodAllowed(method) {

  const alwaysAllowed = new Set(['extension.info', 'native.status', 'policy.get', 'policy.checkUrl', 'permission.check']);
  if (alwaysAllowed.has(method)) return;
  const policy = await loadPolicy();
  if (!isMethodAllowedByPolicy(method, policy)) {
    const pattern = firstMatchingPattern(method, policy.blockedMethods);
    throw new Error(`Method blocked by policy: ${method}${pattern ? ` (matched ${pattern})` : ''}`);
  }
}

async function assertRpcTabIsolation(method, params = {}) {
  if (method === 'tabs.list') {
    if (typeof params.query?.groupId !== 'number') {
      throw new Error('Access denied: tabs.list requires query.groupId for an Agent-managed tab group');
    }
    await assertAgentManagedGroup(params.query.groupId, method);
    return;
  }

  if (method === 'tabs.activate') {
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
    return;
  }

  if (method === 'tabs.close') {
    await assertAgentManagedTabs(tabIdsFromParams(params), method);
    return;
  }

  if (method === 'tabs.group') {
    await assertAgentManagedTabs(tabIdsFromParams(params), method);
    if (typeof params.groupId === 'number') {
      await assertAgentManagedGroup(params.groupId, method);
    }
    return;
  }

  if (method === 'session.addTab') {
    await assertSessionManaged(params.sessionId, method);
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
    return;
  }

  if (method === 'session.get' || method === 'session.createTab' || method === 'session.closeTab' || method === 'session.stop') {
    await assertSessionManaged(params.sessionId, method);
    return;
  }

  if (method === 'recording.start') {
    if (typeof params.groupId === 'number') {
      await assertAgentManagedGroup(params.groupId, method);
      return;
    }
    if (params.tabId != null) {
      await assertAgentManagedTabs([assertTabId(params.tabId)], method);
      return;
    }
    return;
  }



  if (method === 'indicator.set') {
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
    return;
  }

  if (
    method.startsWith('page.') ||
    method.startsWith('dom.') ||
    method.startsWith('computer.') ||
    method === 'console.read' ||
    method === 'network.read'
  ) {
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
  }
}

function tabIdsFromParams(params) {
  return Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
}

async function assertAgentManagedTabs(tabIds, action) {
  if (!await areAgentManagedTabs(tabIds)) {
    throw new Error(`Access denied: ${action} is limited to tabs in Agent-managed tab groups`);
  }
}

async function assertAgentManagedGroup(groupId, action) {
  if (!await isAgentManagedGroupId(groupId)) {
    throw new Error(`Access denied: ${action} is limited to Agent-managed tab groups`);
  }
}



async function assertSessionManaged(sessionId, action) {
  const session = await requireSession(sessionId);
  if (await isSessionManaged(session)) return;
  throw new Error(`Access denied: ${action} session is not scoped to an Agent-managed tab group`);
}

async function isSessionManaged(session) {
  if (!session || typeof session !== 'object') return false;
  if (typeof session.groupId === 'number') return isAgentManagedGroupId(session.groupId);
  return Array.isArray(session.tabIds) && session.tabIds.length > 0 && await areAgentManagedTabs(session.tabIds);
}



async function assertTabAllowed(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
  await assertAgentManagedGroup(tab.groupId, action);
  await assertUrlAllowed(tab.url || '', action);
}

async function assertUrlAllowed(url, action) {
  if (!url || url === 'about:blank') return;
  const policy = await loadPolicy();
  if (!isUrlAllowedByPolicy(url, policy)) {
    const pattern = firstMatchingPattern(url, policy.blockedUrlPatterns);
    throw new Error(`${action} blocked by policy for ${url}${pattern ? ` (matched ${pattern})` : ''}`);
  }
}

async function recordAction(tabId, type, input = {}, result, forcedRecordingId) {
  await ensureRecordingsLoaded();
  const matching = [];
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  for (const recording of recordings.values()) {
    if (!recording.isRecording) continue;
    if (forcedRecordingId && recording.id !== forcedRecordingId) continue;
    if (!forcedRecordingId && recording.scope === 'tab' && recording.tabId !== tabId) continue;
    if (!forcedRecordingId && recording.scope === 'group' && recording.groupId !== tab.groupId) continue;
    matching.push(recording);
  }
  for (const recording of matching) {
    const action = {
      index: recording.actions.length,
      type,
      timestamp: new Date().toISOString(),
      tab: normalizeTab(tab),
      input: sanitizeRecordingInput(input, recording),
      ...(result !== undefined ? { result: compactResult(result) } : {})
    };
    if (recording.captureScreenshots && tab.url && isUrlAllowedByPolicy(tab.url, await loadPolicy())) {
      try {
        action.screenshot = await captureTabScreenshot(tabId, { format: 'jpeg', quality: 60 });
      } catch (error) {
        action.screenshotError = errorMessage(error);
      }
    }
    recording.actions.push(action);
    if (recording.actions.length > recording.maxActions) {
      recording.actions.splice(0, recording.actions.length - recording.maxActions);
      recording.actions.forEach((item, index) => {
        item.index = index;
      });
    }
    recording.updatedAt = new Date().toISOString();
  }
  if (matching.length > 0) scheduleRecordingsSave();
}

async function captureTabScreenshot(tabId, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.windowId !== 'number') throw new Error('Tab has no windowId');
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return chrome.tabs.captureVisibleTab(tab.windowId, {
    format: options.format === 'jpeg' ? 'jpeg' : 'png',
    ...(typeof options.quality === 'number' ? { quality: options.quality } : {})
  });
}

function requireRecording(recordingId) {
  assertString(recordingId, 'recordingId');
  const recording = recordings.get(recordingId);
  if (!recording) throw new Error(`Recording not found: ${recordingId}`);
  return recording;
}

async function ensureRecordingsLoaded() {
  if (recordingsLoaded) return;
  const result = await chrome.storage.local.get(RECORDINGS_STORAGE_KEY);
  recordings.clear();
  const stored = result[RECORDINGS_STORAGE_KEY];
  let pruned = false;
  if (Array.isArray(stored)) {
    for (const recording of stored) {
      if (!recording || typeof recording.id !== 'string') continue;
      const normalized = normalizeRecording(recording);
      if (isRecordingExpired(normalized)) {
        pruned = true;
        continue;
      }
      recordings.set(normalized.id, normalized);
    }
  }
  recordingsLoaded = true;
  if (pruned) await saveRecordingsNow();
}

function normalizeRecording(recording) {
  const startedAtTimestamp = Date.parse(recording.startedAt);
  const startedAt = Number.isFinite(startedAtTimestamp) ? recording.startedAt : new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const retentionMs = normalizeRecordingRetention(recording.retentionMs);
  const expiresAt = Number.isFinite(Date.parse(recording.expiresAt))
    ? recording.expiresAt
    : new Date(startedAtMs + retentionMs).toISOString();
  return {
    id: recording.id,
    name: typeof recording.name === 'string' ? recording.name : 'Recording',
    scope: recording.scope === 'group' ? 'group' : 'tab',
    tabId: Number.isInteger(recording.tabId) ? recording.tabId : null,
    groupId: typeof recording.groupId === 'number' ? recording.groupId : null,
    captureScreenshots: recording.captureScreenshots === true,
    includeText: recording.includeText === true,
    maxActions: normalizeRecordingMaxActions(recording.maxActions),
    retentionMs,
    expiresAt,
    isRecording: recording.isRecording === true,
    startedAt,
    stoppedAt: typeof recording.stoppedAt === 'string' ? recording.stoppedAt : null,
    updatedAt: typeof recording.updatedAt === 'string' ? recording.updatedAt : null,
    actions: Array.isArray(recording.actions) ? recording.actions : []
  };
}

function normalizeRecordingRetention(value) {
  if (!Number.isFinite(value)) return DEFAULT_RECORDING_RETENTION_MS;
  return Math.max(60 * 1000, Math.min(Math.trunc(value), MAX_RECORDING_RETENTION_MS));
}

function normalizeRecordingMaxActions(value) {
  if (!Number.isInteger(value)) return DEFAULT_RECORDING_MAX_ACTIONS;
  return Math.max(1, Math.min(value, MAX_RECORDING_MAX_ACTIONS));
}

function isRecordingExpired(recording) {
  return typeof recording.expiresAt === 'string' && Date.parse(recording.expiresAt) <= Date.now();
}

function pruneExpiredRecordingsSync() {
  for (const [id, recording] of recordings.entries()) {
    if (isRecordingExpired(recording)) recordings.delete(id);
  }
}

async function pruneExpiredRecordings() {
  const before = recordings.size;
  pruneExpiredRecordingsSync();
  if (recordings.size !== before) await saveRecordingsNow();
}

function scheduleRecordingsSave() {
  clearTimeout(recordingsSaveTimer);
  recordingsSaveTimer = setTimeout(() => {
    saveRecordingsNow().catch(() => {});
  }, 500);
}

async function saveRecordingsNow() {
  clearTimeout(recordingsSaveTimer);
  recordingsSaveTimer = null;
  pruneExpiredRecordingsSync();
  await chrome.storage.local.set({
    [RECORDINGS_STORAGE_KEY]: Array.from(recordings.values())
  });
}

function summarizeRecording(recording) {
  return {
    id: recording.id,
    name: recording.name,
    scope: recording.scope,
    tabId: recording.tabId,
    groupId: recording.groupId,
    captureScreenshots: recording.captureScreenshots,
    includeText: recording.includeText,
    maxActions: recording.maxActions,
    retentionMs: recording.retentionMs,
    isRecording: recording.isRecording,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt,
    expiresAt: recording.expiresAt,
    updatedAt: recording.updatedAt,
    actionCount: recording.actions.length
  };
}

function sanitizeRecordingInput(input, recording) {
  if (!input || typeof input !== 'object') return input;
  const sanitized = {};
  for (const [key, value] of Object.entries(input)) {
    if ((key === 'text' || key === 'value' || key === 'key') && typeof value === 'string' && !recording.includeText) {
      sanitized[key] = {
        redacted: true,
        length: value.length,
        empty: value.length === 0
      };
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function compactResult(result) {
  try {
    const json = JSON.stringify(result);
    if (json.length <= 2000) return result;
    return { truncated: true, preview: json.slice(0, 2000) };
  } catch {
    return { unserializable: true };
  }
}

function safeFilename(value) {
  return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'recording.json';
}

function isUrlAllowedByPolicy(url, policy) {
  const allowed = firstMatchingPattern(url, policy.allowedUrlPatterns);
  if (allowed) return true;
  return !firstMatchingPattern(url, policy.blockedUrlPatterns);
}

function isMethodAllowedByPolicy(method, policy) {
  const allowed = firstMatchingPattern(method, policy.allowedMethods);
  if (allowed) return true;
  return !firstMatchingPattern(method, policy.blockedMethods);
}

function firstMatchingPattern(url, patterns) {
  for (const pattern of patterns || []) {
    if (urlPatternMatches(url, pattern)) return pattern;
  }
  return null;
}

function urlPatternMatches(url, pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function normalizePatternList(value, fallback = []) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [...fallback];
}

function pushLimited(map, key, value, limit) {
  const values = map.get(key) || [];
  values.push(value);
  while (values.length > limit) values.shift();
  map.set(key, values);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertTabId(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('tabId must be a non-negative integer');
  return value;
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function assertNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function optionalPermissionsForMethod(method, params = {}) {
  if (method === 'tabs.create') return ['tabs', 'tabGroups'];
  if (method === 'tabs.group') return ['tabs', 'tabGroups'];
  if (method.startsWith('tabs.')) return ['tabs'];
  if (method.startsWith('session.')) return ['tabs', 'tabGroups'];
  if (method === 'downloads.list' || method === 'downloads.download') return ['downloads'];
  if (method === 'recording.export' && params.download === true) return ['downloads'];
  if (
    method.startsWith('page.') ||
    method.startsWith('dom.') ||
    method.startsWith('computer.') ||
    method === 'console.read' ||
    method === 'network.read' ||
    method === 'recording.start'
  ) {
    return ['tabs'];
  }
  return [];
}

async function assertOptionalPermissions(method, params = {}) {
  const permissions = optionalPermissionsForMethod(method, params);
  if (permissions.length === 0) return;
  const granted = await chrome.permissions.contains({ permissions });
  if (!granted) {
    throw new Error(
      `Missing Chrome optional permissions for ${method}: ${permissions.join(', ')}. ` +
      'Open the side panel and grant permissions.'
    );
  }
}

function getMethodCategory(method, params = {}) {
  if (method === 'tabs.list' || method === 'session.list' || method === 'session.get') {
    return 'read_tabs';
  }
  if (method === 'tabs.close' || method === 'session.closeTab' || method === 'session.stop') {
    return 'tab_control';
  }
  if (method === 'downloads.list' || method === 'downloads.download') {
    return 'read_downloads';
  }
  if (method === 'page.executeJavaScript') {
    return 'page_script';
  }
  if (method === 'page.screenshot' || method === 'page.domSnapshot') {
    return 'page_screenshot';
  }
  if (method === 'dom.type' || method === 'computer.type' || method === 'computer.key') {
    return 'page_input';
  }
  if (
    method === 'dom.click' ||
    method === 'dom.select' ||
    method === 'computer.click' ||
    method === 'computer.drag'
  ) {
    return 'page_action';
  }
  if (method === 'console.read' || method === 'network.read') {
    return 'page_logs';
  }
  if (
    method === 'recording.status' ||
    method === 'recording.stop' ||
    method === 'recording.export' ||
    method === 'recording.clear'
  ) {
    return 'recording_data';
  }
  if (method === 'policy.set') {
    return 'policy_admin';
  }
  return null;
}

async function isAgentTabGroupOperation(method, params = {}) {
  if (method === 'session.list') return true;
  if (method === 'session.get' || method === 'session.closeTab' || method === 'session.stop') {
    return typeof params.sessionId === 'string' && params.sessionId.length > 0;
  }
  if (method === 'tabs.list' && typeof params.query?.groupId === 'number') {
    return isAgentManagedGroupId(params.query.groupId);
  }
  if (method === 'tabs.close') {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds : [params.tabId];
    return areAgentManagedTabs(tabIds);
  }
  return false;
}

async function isSidepanelOpen() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PING_SIDEPANEL' });
    return response && response.ok === true;
  } catch (e) {
    return false;
  }
}

async function openApprovalPopup() {
  const popupUrl = chrome.runtime.getURL(APPROVAL_POPUP_PATH);
  if (approvalPopupWindowId !== null) {
    try {
      await chrome.windows.update(approvalPopupWindowId, { focused: true });
      return;
    } catch (e) {
      approvalPopupWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    width: 520,
    height: 560,
    focused: true
  });
  approvalPopupWindowId = win.id ?? null;
}

async function closeApprovalPopupIfIdle() {
  if (pendingPrompts.size > 0 || approvalPopupWindowId === null) return;
  const windowId = approvalPopupWindowId;
  approvalPopupWindowId = null;
  await chrome.windows.remove(windowId).catch(() => {});
  await chrome.notifications.clear(APPROVAL_NOTIFICATION_ID).catch(() => {});
}

async function notifyApprovalPrompt(category, method) {
  await chrome.notifications.create(APPROVAL_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Browser Agent Bridge approval needed',
    message: `${method} needs approval (${category}). A review window has been opened.`
  }).catch(() => {});
}

async function showApprovalFallback(category, method) {
  await notifyApprovalPrompt(category, method);
  await openApprovalPopup().catch(err => console.error('Error opening approval popup:', err));
}

async function broadcastPermissionPrompt(promptId, category, method, params) {
  await chrome.runtime.sendMessage({
    type: 'PROMPT_PERMISSION',
    promptId,
    category,
    method,
    params
  }).catch(() => {});
}

async function checkPermission(method, params) {
  if (method === 'permission.check') return;

  const category = getMethodCategory(method, params);
  if (!category) return; // not a sensitive method requiring approval
  if (await isAgentTabGroupOperation(method, params)) return;

  const result = await chrome.storage.local.get([
    'enableRuntimeApproval',
    'sessionPermissions'
  ]);

  // If runtime approval is disabled, allow
  if (result.enableRuntimeApproval === false) {
    return;
  }

  const sessionPermissions = result.sessionPermissions || {};
  if (sessionPermissions[category] === 'allow') {
    return;
  }
  if (sessionPermissions[category] === 'deny') {
    throw new Error(`Permission denied by user for this session: ${category}`);
  }

  const promptId = nextPromptId++;
  const response = await new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pendingPrompts.delete(promptId);
      resolve(value);
      closeApprovalPopupIfIdle().catch(() => {});
    };
    const timer = setTimeout(() => {
      finish('timeout');
    }, PERMISSION_PROMPT_TIMEOUT_MS);

    pendingPrompts.set(promptId, { resolve: finish, category, method, params });
    (async () => {
      const open = await isSidepanelOpen();
      if (!open) {
        await showApprovalFallback(category, method);
      }
      await broadcastPermissionPrompt(promptId, category, method, params);
    })().catch(() => {
      finish('deny');
    });
  });

  if (response === 'allow') {
    return;
  } else if (response === 'session_allow') {
    sessionPermissions[category] = 'allow';
    await chrome.storage.local.set({ sessionPermissions });
    return;
  } else if (response === 'timeout') {
    throw new Error(`Permission approval timed out after ${PERMISSION_PROMPT_TIMEOUT_MS / 1000}s: ${category}`);
  } else {
    sessionPermissions[category] = 'deny';
    await chrome.storage.local.set({ sessionPermissions });
    throw new Error(`Permission denied by user: ${category}`);
  }
}
