const NATIVE_HOST = 'com.local.browser_agent_bridge';
const CDP_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 30000;
const SESSION_STORAGE_KEY = 'browserAgentBridgeSessions';
const POLICY_STORAGE_KEY = 'browserAgentBridgePolicy';
const RECORDINGS_STORAGE_KEY = 'browserAgentBridgeRecordings';

let nativePort = null;
let nextRequestId = 1;
let reconnectTimer = null;
let nativeStatus = {
  state: 'disconnected',
  hostName: NATIVE_HOST,
  lastChecked: Date.now()
};
const pendingNativeRequests = new Map();
const attachedTabs = new Set();
const cdpEvents = [];
const networkEventsByTab = new Map();
const consoleEventsByTab = new Map();
const recordings = new Map();
let recordingsLoaded = false;
let recordingsSaveTimer = null;
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
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  connectNative();
  await initCspBypass().catch(err => console.error(err));
});

chrome.runtime.onStartup.addListener(async () => {
  connectNative();
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

chrome.tabs.onRemoved.addListener(tabId => {
  networkEventsByTab.delete(tabId);
  consoleEventsByTab.delete(tabId);
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

connectNative();
initCspBypass().catch(err => console.error(err));

function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
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
    setNativeStatus('disconnected', error);
    scheduleReconnect();
  });

  sendNativeNotification('extension.ready', {
    version: chrome.runtime.getManifest().version
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNative, 3000);
}

function setNativeStatus(state, error) {
  nativeStatus = {
    state,
    hostName: NATIVE_HOST,
    lastChecked: Date.now(),
    ...(error ? { error } : {})
  };
  chrome.storage.local.set({ nativeStatus }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'NATIVE_STATUS_CHANGED', status: nativeStatus }).catch(() => {});
}

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case 'GET_NATIVE_STATUS':
      connectNative();
      return { ok: nativeStatus.state === 'connected', status: nativeStatus };
    case 'GET_CSP_BYPASS':
      return { ok: true, enabled: (await chrome.storage.local.get('bypassCSP')).bypassCSP !== false };
    case 'SET_CSP_BYPASS': {
      const bypass = message.enabled !== false;
      await chrome.storage.local.set({ bypassCSP: bypass });
      await updateCspRuleset(bypass);
      return { ok: true };
    }
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

async function handleRpc(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('Invalid JSON-RPC request');
  }
  await assertMethodAllowed(request.method);
  const params = request.params || {};
  switch (request.method) {
    case 'extension.info':
      return extensionInfo();
    case 'extension.reload':
      return extensionReload();
    case 'extension.getCspBypass':
      return extensionGetCspBypass();
    case 'extension.setCspBypass':
      return extensionSetCspBypass(params);
    case 'native.status':
      return nativeStatus;
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
      'extension.setCspBypass',
      'native.status',
      'tabs.list',
      'tabs.create',
      'tabs.activate',
      'tabs.close',
      'tabs.group',
      'session.start',
      'session.list',
      'session.get',
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
      'computer.click',
      'computer.drag',
      'computer.type',
      'computer.key',
      'computer.scroll',
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
  await updateCspRuleset(bypass);
}

async function updateCspRuleset(enabled) {
  const rulesetId = 'ruleset_1';
  if (enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [rulesetId]
    }).catch(err => console.error('Error enabling CSP ruleset:', err));
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [rulesetId]
    }).catch(err => console.error('Error disabling CSP ruleset:', err));
  }
}

async function extensionGetCspBypass() {
  const result = await chrome.storage.local.get('bypassCSP');
  return { enabled: result.bypassCSP !== false };
}

async function extensionSetCspBypass(params) {
  const bypass = params.enabled !== false;
  await chrome.storage.local.set({ bypassCSP: bypass });
  await updateCspRuleset(bypass);
  return { success: true };
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
  const tab = await chrome.tabs.create({
    url: params.url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
  });
  
  if (typeof tab.id === 'number') {
    try {
      const groups = await chrome.tabGroups.query({ title: 'Agent', windowId: tab.windowId });
      if (groups.length > 0) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id });
      } else {
        const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, { title: 'Agent', color: 'cyan' });
      }
    } catch (e) {
      console.warn('Failed to auto-group agent tab:', e);
    }
  }

  return { tab: normalizeTab(tab) };
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
  return { groupId };
}

async function sessionStart(params) {
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Agent';
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  if (url !== 'about:blank') await assertUrlAllowed(url, 'session.start');
  const tab = await chrome.tabs.create({
    url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
  });
  if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: params.color || 'cyan'
  }).catch(() => {});
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
  return { session, tab: normalizeTab(tab) };
}

async function sessionList() {
  return { sessions: Object.values(await loadSessions()) };
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
  await indicatorSet({ tabId, visible: true, x, y, label: 'click' }).catch(() => {});
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
  await indicatorSet({ tabId, visible: true, x: toX, y: toY, label: 'drag' }).catch(() => {});
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

async function computerKey(params) {
  const tabId = assertTabId(params.tabId);
  await assertTabAllowed(tabId, 'computer.key');
  assertString(params.key, 'key');
  await attachDebugger(tabId);
  const key = params.key;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    text: key.length === 1 ? key : undefined
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key
  });
  await recordAction(tabId, 'computer.key', { key });
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
  const tabId = params.tabId == null ? null : assertTabId(params.tabId);
  const hasExplicitGroup = typeof params.groupId === 'number';
  const groupId = hasExplicitGroup ? params.groupId : tabId == null ? null : (await chrome.tabs.get(tabId)).groupId;
  if (tabId == null && groupId == null) throw new Error('recording.start requires tabId or groupId');
  const recording = {
    id: crypto.randomUUID(),
    name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Recording',
    scope: hasExplicitGroup ? 'group' : 'tab',
    tabId,
    groupId,
    captureScreenshots: params.captureScreenshots === true,
    isRecording: true,
    startedAt: new Date().toISOString(),
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
  const recording = requireRecording(params.recordingId);
  recording.isRecording = false;
  recording.stoppedAt = new Date().toISOString();
  await saveRecordingsNow();
  return { recording: summarizeRecording(recording) };
}

async function recordingStatus(params) {
  await ensureRecordingsLoaded();
  if (params.recordingId) {
    return { recording: summarizeRecording(requireRecording(params.recordingId)) };
  }
  return { recordings: Array.from(recordings.values()).map(summarizeRecording) };
}

async function recordingExport(params) {
  await ensureRecordingsLoaded();
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
    pendingNativeRequests.set(id, { resolve, reject });
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
  const alwaysAllowed = new Set(['extension.info', 'native.status', 'policy.get', 'policy.set', 'policy.checkUrl']);
  if (alwaysAllowed.has(method)) return;
  const policy = await loadPolicy();
  if (!isMethodAllowedByPolicy(method, policy)) {
    const pattern = firstMatchingPattern(method, policy.blockedMethods);
    throw new Error(`Method blocked by policy: ${method}${pattern ? ` (matched ${pattern})` : ''}`);
  }
}

async function assertTabAllowed(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
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
      input,
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
  if (Array.isArray(stored)) {
    for (const recording of stored) {
      if (recording && typeof recording.id === 'string') recordings.set(recording.id, normalizeRecording(recording));
    }
  }
  recordingsLoaded = true;
}

function normalizeRecording(recording) {
  return {
    id: recording.id,
    name: typeof recording.name === 'string' ? recording.name : 'Recording',
    scope: recording.scope === 'group' ? 'group' : 'tab',
    tabId: Number.isInteger(recording.tabId) ? recording.tabId : null,
    groupId: typeof recording.groupId === 'number' ? recording.groupId : null,
    captureScreenshots: recording.captureScreenshots === true,
    isRecording: recording.isRecording === true,
    startedAt: typeof recording.startedAt === 'string' ? recording.startedAt : new Date().toISOString(),
    stoppedAt: typeof recording.stoppedAt === 'string' ? recording.stoppedAt : null,
    updatedAt: typeof recording.updatedAt === 'string' ? recording.updatedAt : null,
    actions: Array.isArray(recording.actions) ? recording.actions : []
  };
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
    isRecording: recording.isRecording,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt,
    updatedAt: recording.updatedAt,
    actionCount: recording.actions.length
  };
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
