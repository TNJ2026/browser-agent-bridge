import { createLocatorHandlers } from './sw/locator.js';
import { createDomHandlers } from './sw/dom.js';
import { createComputerHandlers } from './sw/computer.js';
import { createPageHandlers } from './sw/page.js';
import { createDevtoolsHandlers } from './sw/devtools.js';
import { createDownloadsHandlers } from './sw/downloads.js';
import { CSP_BYPASS_ALARM, createCspHandlers } from './sw/csp.js';
import { createRecordingHandlers } from './sw/recording.js';
import { createSessionHandlers, SESSION_STORAGE_KEY, AGENT_TAB_GROUPS_STORAGE_KEY } from './sw/sessions.js';
import { createPolicyHandlers } from './sw/policy.js';
import { createTraceHandlers } from './sw/tracing.js';
import { createFrameTargetResolver } from './sw/frames.js';
import { createKeyboardDispatcher, createKeyboardHandlers } from './sw/keyboard.js';
import { createNetworkInterceptorController } from './sw/network-interceptors.js';
import { isTabTargetedMethod } from './sw/tab-scope.js';
import { getMethodCategory, optionalPermissionsForMethod } from './sw/method-policy.js';

const NATIVE_HOST = 'com.local.browser_agent_bridge';
const CDP_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 30000;
const PERMISSION_PROMPT_TIMEOUT_MS = 60000;
const APPROVAL_NOTIFICATION_ID = 'browser-agent-bridge-permission-approval';
const APPROVAL_POPUP_PATH = 'approval.html';
const NATIVE_HEARTBEAT_ALARM = 'browser-agent-bridge-native-heartbeat';
const NATIVE_HEARTBEAT_PERIOD_MINUTES = 0.5;
const NATIVE_HEARTBEAT_STALE_MS = 90000;

let nativePort = null;
let nextRequestId = 1;
let reconnectTimer = null;
let bridgeEnabledCache = false;
let lastNativePongAt = null;
let nativeStatus = {
  state: 'stopped',
  hostName: NATIVE_HOST,
  bridgeEnabled: false,
  lastChecked: Date.now()
};
const pendingNativeRequests = new Map();
const attachedTabs = new Set();
const networkEventsByTab = new Map();
const consoleEventsByTab = new Map();
const dialogsByTab = new Map();
const networkActivityWaitersByTab = new Map();
const dialogActivityWaitersByTab = new Map();
const cdpEventForwarding = {
  all: false,
  tabIds: new Set()
};
let nextPromptId = 1;
const pendingPrompts = new Map();
let approvalPopupWindowId = null;
const cspHandlers = createCspHandlers({});
const policyHandlers = createPolicyHandlers({});
const traceHandlers = createTraceHandlers({
  assertString,
  errorMessage,
  captureFailureContext
});
const frameTargetResolver = createFrameTargetResolver({});
const keyboardDispatcher = createKeyboardDispatcher({ cdp, sleep });

const sessionsHandlers = createSessionHandlers({
  assertString,
  assertTabId,
  assertUrlAllowed: policyHandlers.assertUrlAllowed,
  assertTabAllowed,
  normalizeTab,
  errorMessage,
  maybeEnableTemporaryCspBypassForUrl: cspHandlers.maybeEnableTemporaryCspBypassForUrl,
  detachDebugger
});

const recordingHandlers = createRecordingHandlers({
  assertTabId,
  assertString,
  normalizeTab,
  captureTabScreenshot,
  loadPolicy: policyHandlers.loadPolicy,
  isUrlAllowedByPolicy: policyHandlers.isUrlAllowedByPolicy,
  errorMessage
});

const locatorHandlers = createLocatorHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction: recordingHandlers.recordAction,
  attachDebugger,
  cdp,
  captureElementScreenshot,
  resolveFrameTarget: frameTargetResolver.resolveFrameTarget,
  ensureContentScripts,
  keyboardDispatcher,
  sleep,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS
});

const domHandlers = createDomHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction: recordingHandlers.recordAction,
  attachDebugger,
  cdp,
  resolveFrameTarget: frameTargetResolver.resolveFrameTarget,
  sleep,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS
});

const computerHandlers = createComputerHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  assertNumber,
  attachDebugger,
  cdp,
  indicatorSet,
  recordAction: recordingHandlers.recordAction,
  keyboardDispatcher
});

const keyboardHandlers = createKeyboardHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  attachDebugger,
  recordAction: recordingHandlers.recordAction,
  dispatcher: keyboardDispatcher
});

const pageHandlers = createPageHandlers({
  assertTabId,
  assertString,
  assertTabAllowed,
  assertUrlAllowed: policyHandlers.assertUrlAllowed,
  maybeEnableTemporaryCspBypassForUrl: cspHandlers.maybeEnableTemporaryCspBypassForUrl,
  maybeEnableTemporaryCspBypass: cspHandlers.maybeEnableTemporaryCspBypass,
  recordAction: recordingHandlers.recordAction,
  normalizeTab,
  waitForTabComplete,
  sleep,
  ensureContentScripts,
  captureTabScreenshot,
  attachDebugger,
  cdp,
  resolveFrameTarget: frameTargetResolver.resolveFrameTarget,
  networkEventsByTab,
  dialogsByTab,
  waitForNetworkActivity,
  waitForDialogActivity,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS
});

const fetchInterceptorsByTab = new Map();
const networkInterceptorController = createNetworkInterceptorController({
  cdp,
  fetchInterceptorsByTab,
  onHit: hit => { traceHandlers.traceNetworkEvent(hit).catch(() => {}); }
});

const devtoolsHandlers = createDevtoolsHandlers({
  assertTabId,
  assertTabAllowed,
  attachDebugger,
  cdp,
  consoleEventsByTab,
  networkEventsByTab,
  fetchInterceptorsByTab,
  interceptorStatus: networkInterceptorController.status,
  clearInterceptors: networkInterceptorController.clear,
  interceptorEvents: networkInterceptorController.events,
  clearInterceptorEvents: networkInterceptorController.clearEvents
});

const downloadsHandlers = createDownloadsHandlers({});
downloadsHandlers.initDownloadEvents();

const rpcRouter = {
  'permission.check': () => ({ allowed: true }),
  'extension.info': () => extensionInfo(),
  'extension.reload': () => extensionReload(),
  'extension.getCspBypass': () => cspHandlers.extensionGetCspBypass(),
  'native.status': () => nativeStatus,
  'native.sitePatterns': (params) => nativeRequest('native.sitePatterns', params),

  // sessions / tabs
  'tabs.list': (params) => sessionsHandlers.tabsList(params),
  'tabs.create': (params) => sessionsHandlers.tabsCreate(params),
  'tabs.activate': (params) => sessionsHandlers.tabsActivate(params),
  'tabs.close': (params) => sessionsHandlers.tabsClose(params),
  'tabs.group': (params) => sessionsHandlers.tabsGroup(params),
  'session.start': (params) => sessionsHandlers.sessionStart(params),
  'session.list': () => sessionsHandlers.sessionList(),
  'session.get': (params) => sessionsHandlers.sessionGet(params),
  'session.createTab': (params) => sessionsHandlers.sessionCreateTab(params),
  'session.addTab': (params) => sessionsHandlers.sessionAddTab(params),
  'session.closeTab': (params) => sessionsHandlers.sessionCloseTab(params),
  'session.stop': (params) => sessionsHandlers.sessionStop(params),

  // page
  'page.navigate': (params) => pageHandlers.pageNavigate(params),
  'page.reload': (params) => pageHandlers.pageReload(params),
  'page.goBack': (params) => pageHandlers.pageGoBack(params),
  'page.goForward': (params) => pageHandlers.pageGoForward(params),
  'page.waitForLoad': (params) => pageHandlers.pageWaitForLoad(params),
  'page.waitForNavigation': (params) => pageHandlers.pageWaitForNavigation(params),
  'page.waitForResponse': (params) => pageHandlers.pageWaitForResponse(params),
  'page.waitForRequest': (params) => pageHandlers.pageWaitForRequest(params),
  'page.waitForURL': (params) => pageHandlers.pageWaitForURL(params),
  'page.waitForPopup': (params) => pageHandlers.pageWaitForPopup(params),
  'page.waitForNetworkIdle': (params) => pageHandlers.pageWaitForNetworkIdle(params),
  'page.waitForDialog': (params) => pageHandlers.pageWaitForDialog(params),
  'page.acceptDialog': (params) => pageHandlers.pageAcceptDialog(params),
  'page.dismissDialog': (params) => pageHandlers.pageDismissDialog(params),
  'page.frames': (params) => pageHandlers.pageFrames(params),
  'page.waitForSelector': (params) => pageHandlers.pageWaitForSelector(params),
  'page.waitForText': (params) => pageHandlers.pageWaitForText(params),
  'page.waitForFunction': (params) => pageHandlers.pageWaitForFunction(params),
  'expect.page.toHaveTitle': (params) => pageHandlers.pageExpectTitle(params),
  'page.addInitScript': (params) => pageHandlers.pageAddInitScript(params),
  'page.removeInitScript': (params) => pageHandlers.pageRemoveInitScript(params),
  'page.readText': (params) => pageHandlers.pageReadText(params),
  'page.accessibilityTree': (params) => pageHandlers.pageAccessibilityTree(params),
  'page.ariaSnapshot': (params) => pageHandlers.pageAriaSnapshot(params),
  'expect.page.toMatchAriaSnapshot': (params) => pageHandlers.pageExpectAriaSnapshot(params),
  'page.screenshot': (params) => pageHandlers.pageScreenshot(params),
  'page.pdf': (params) => pageHandlers.pagePdf(params),
  'page.executeJavaScript': (params) => pageHandlers.pageExecuteJavaScript(params),
  'page.domSnapshot': (params) => pageHandlers.pageDomSnapshot(params),
  'page.setViewport': (params) => pageHandlers.pageSetViewport(params),
  'page.emulateMedia': (params) => pageHandlers.pageEmulateMedia(params),
  'page.setGeolocation': (params) => pageHandlers.pageSetGeolocation(params),
  'page.setLocale': (params) => pageHandlers.pageSetLocale(params),
  'page.setOffline': (params) => pageHandlers.pageSetOffline(params),
  'page.clearEmulation': (params) => pageHandlers.pageClearEmulation(params),
  'page.setExtraHTTPHeaders': (params) => pageHandlers.pageSetExtraHTTPHeaders(params),
  'page.setUserAgent': (params) => pageHandlers.pageSetUserAgent(params),

  // dom
  'dom.query': (params) => domHandlers.domQuery(params),
  'dom.click': (params) => domHandlers.domClick(params),
  'dom.dragTo': (params) => domHandlers.domDragTo(params),
  'dom.dispatchDragDrop': (params) => domHandlers.domDispatchDragDrop(params),
  'dom.type': (params) => domHandlers.domType(params),
  'dom.select': (params) => domHandlers.domSelect(params),
  'dom.setInputFiles': (params) => domHandlers.domSetInputFiles(params),
  'dom.hover': (params) => domHandlers.domHover(params),
  'dom.scroll': (params) => domHandlers.domScroll(params),

  // locator
  'locator.count': (params) => locatorHandlers.locatorCount(params),
  'locator.textContent': (params) => locatorHandlers.locatorTextContent(params),
  'locator.allTextContents': (params) => locatorHandlers.locatorAllTextContents(params),
  'locator.allInnerTexts': (params) => locatorHandlers.locatorAllInnerTexts(params),
  'locator.getAttribute': (params) => locatorHandlers.locatorGetAttribute(params),
  'locator.nth': (params) => locatorHandlers.locatorNth(params),
  'locator.first': (params) => locatorHandlers.locatorFirst(params),
  'locator.last': (params) => locatorHandlers.locatorLast(params),
  'locator.waitFor': (params) => locatorHandlers.locatorWaitFor(params),
  'locator.boundingBox': (params) => locatorHandlers.locatorBoundingBox(params),
  'locator.focus': (params) => locatorHandlers.locatorFocus(params),

  // locator assertions
  'expect.locator.toBeVisible': (params) => locatorHandlers.expectLocatorToBeVisible(params),
  'expect.locator.toBeHidden': (params) => locatorHandlers.expectLocatorToBeHidden(params),
  'expect.locator.toBeEnabled': (params) => locatorHandlers.expectLocatorToBeEnabled(params),
  'expect.locator.toBeDisabled': (params) => locatorHandlers.expectLocatorToBeDisabled(params),
  'expect.locator.toBeEditable': (params) => locatorHandlers.expectLocatorToBeEditable(params),
  'expect.locator.toBeChecked': (params) => locatorHandlers.expectLocatorToBeChecked(params),
  'expect.locator.toHaveValue': (params) => locatorHandlers.expectLocatorToHaveValue(params),
  'expect.locator.toHaveCount': (params) => locatorHandlers.expectLocatorToHaveCount(params),
  'expect.locator.toHaveText': (params) => locatorHandlers.expectLocatorToHaveText(params),
  'expect.locator.toHaveAttribute': (params) => locatorHandlers.expectLocatorToHaveAttribute(params),

  // locator actions
  'locator.click': (params) => locatorHandlers.locatorClick(params),
  'locator.clickRef': (params) => locatorHandlers.locatorClickRef(params),
  'locator.dragTo': (params) => locatorHandlers.locatorDragTo(params),
  'locator.dispatchDragDrop': (params) => locatorHandlers.locatorDispatchDragDrop(params),
  'locator.screenshot': (params) => locatorHandlers.locatorScreenshot(params),
  'locator.fill': (params) => locatorHandlers.locatorFill(params),
  'locator.press': (params) => locatorHandlers.locatorPress(params),
  'locator.pressSequentially': (params) => locatorHandlers.locatorPressSequentially(params),
  'locator.check': (params) => locatorHandlers.locatorCheck(params),
  'locator.uncheck': (params) => locatorHandlers.locatorUncheck(params),
  'locator.selectOption': (params) => locatorHandlers.locatorSelectOption(params),
  'locator.setInputFiles': (params) => locatorHandlers.locatorSetInputFiles(params),

  // computer / OS input
  'computer.click': (params) => computerHandlers.computerClick(params),
  'computer.drag': (params) => computerHandlers.computerDrag(params),
  'computer.type': (params) => computerHandlers.computerType(params),
  'computer.key': (params) => computerHandlers.computerKey(params),
  'computer.scroll': (params) => computerHandlers.computerScroll(params),
  'computer.hover': (params) => computerHandlers.computerHover(params),

  // keyboard
  'keyboard.type': (params) => keyboardHandlers.keyboardType(params),
  'keyboard.compose': (params) => keyboardHandlers.keyboardCompose(params),
  'keyboard.press': (params) => keyboardHandlers.keyboardPress(params),
  'keyboard.down': (params) => keyboardHandlers.keyboardDown(params),
  'keyboard.up': (params) => keyboardHandlers.keyboardUp(params),

  // devtools / console / network
  'console.read': (params) => devtoolsHandlers.consoleRead(params),
  'network.read': (params) => devtoolsHandlers.networkRead(params),
  'cookies.get': (params) => devtoolsHandlers.cookiesGet(params),
  'network.getResponseBody': (params) => devtoolsHandlers.networkGetResponseBody(params),
  'network.setBlockedUrls': (params) => devtoolsHandlers.networkSetBlockedUrls(params),
  'network.setInterceptors': (params) => devtoolsHandlers.networkSetInterceptors(params),
  'network.routeFromHAR': (params) => devtoolsHandlers.networkRouteFromHAR(params),
  'network.interceptors.clear': (params) => devtoolsHandlers.networkInterceptorsClear(params),
  'network.interceptors.events': (params) => devtoolsHandlers.networkInterceptorsEvents(params),
  'network.interceptors.clearEvents': (params) => devtoolsHandlers.networkInterceptorsClearEvents(params),
  'network.interceptors.status': (params) => devtoolsHandlers.networkInterceptorsStatus(params),

  // downloads
  'downloads.list': (params) => downloadsHandlers.downloadsList(params),
  'downloads.waitFor': (params) => downloadsHandlers.downloadsWaitFor(params),

  // recording
  'recording.start': (params) => recordingHandlers.recordingStart(params),
  'recording.stop': (params) => recordingHandlers.recordingStop(params),
  'recording.status': (params) => recordingHandlers.recordingStatus(params),
  'recording.export': (params) => recordingHandlers.recordingExport(params),
  'recording.clear': (params) => recordingHandlers.recordingClear(params),

  // tracing
  'trace.start': (params) => traceHandlers.traceStart(params),
  'trace.stop': (params) => traceHandlers.traceStop(params),
  'trace.status': (params) => traceHandlers.traceStatus(params),
  'trace.export': (params) => traceHandlers.traceExport(params),
  'trace.exportHtml': (params) => traceHandlers.traceExportHtml(params),
  'trace.clear': (params) => traceHandlers.traceClear(params),

  // indicator
  'indicator.set': (params) => indicatorSet(params),

  // policy
  'policy.get': () => policyHandlers.policyGet(),
  'policy.set': (params) => policyHandlers.policySet(params),
  'policy.checkUrl': (params) => policyHandlers.policyCheckUrl(params)
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(['sessionPermissions', AGENT_TAB_GROUPS_STORAGE_KEY, SESSION_STORAGE_KEY]).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await initializeBridgeEnabled().catch(err => console.error(err));
  await connectNative();
  await cspHandlers.initCspBypass().catch(err => console.error(err));
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.remove(['sessionPermissions', AGENT_TAB_GROUPS_STORAGE_KEY, SESSION_STORAGE_KEY]).catch(() => {});
  await initializeBridgeEnabled().catch(err => console.error(err));
  await connectNative();
  await cspHandlers.initCspBypass().catch(err => console.error(err));
});

chrome.action.onClicked.addListener(async tab => {
  if (tab.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.permissions.onAdded.addListener(permissions => {
  if (permissions.permissions && permissions.permissions.includes('downloads')) {
    downloadsHandlers.initDownloadEvents();
  }
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-side-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CSP_BYPASS_ALARM) {
    cspHandlers.clearTemporaryCspBypass().catch(err => console.error('Error clearing temporary CSP bypass:', err));
  }
  if (alarm.name === NATIVE_HEARTBEAT_ALARM) {
    nativeHeartbeatTick().catch(err => console.error('Error running native heartbeat:', err));
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
    sendResponse({ ok: false, error: errorMessage(error), ...(errorData(error) ? { data: errorData(error) } : {}) });
  });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const event = { source, method, params, timestamp: Date.now() };
  if (typeof tabId === 'number') {
    if (method.startsWith('Network.')) {
      pushLimited(networkEventsByTab, tabId, event, 500);
      notifyActivityWaiters(networkActivityWaitersByTab, tabId);
    }
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
      pushLimited(consoleEventsByTab, tabId, event, 200);
    }
    if (method === 'Page.javascriptDialogOpening') {
      dialogsByTab.set(tabId, { ...params, timestamp: event.timestamp });
      notifyActivityWaiters(dialogActivityWaitersByTab, tabId);
    }
    if (method === 'Page.javascriptDialogClosed') {
      dialogsByTab.delete(tabId);
      notifyActivityWaiters(dialogActivityWaitersByTab, tabId);
    }
    if (method === 'Fetch.requestPaused') {
      networkInterceptorController.handleRequestPaused(tabId, params).catch(async err => {
        console.error('Error handling paused request:', err);
        await cdp(tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      });
    }
  }
  if (shouldForwardCdpEvent(event)) {
    sendNativeNotification('cdp.event', event);
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (typeof source.tabId === 'number') {
    attachedTabs.delete(source.tabId);
    networkInterceptorController.onDebuggerDetached(source.tabId);
  }
});

chrome.windows.onRemoved.addListener(windowId => {
  if (windowId === approvalPopupWindowId) {
    approvalPopupWindowId = null;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  networkEventsByTab.delete(tabId);
  consoleEventsByTab.delete(tabId);
  dialogsByTab.delete(tabId);
  notifyActivityWaiters(networkActivityWaitersByTab, tabId);
  notifyActivityWaiters(dialogActivityWaitersByTab, tabId);
  networkInterceptorController.onTabRemoved(tabId);
  sessionsHandlers.onTabRemoved(tabId).catch(() => {});
  recordingHandlers.onTabRemoved(tabId).catch(() => {});
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
cspHandlers.initCspBypass().catch(err => console.error(err));

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
    await clearNativeHeartbeatAlarm();
    setNativeStatus('disconnected', 'Pending disclaimer agreement');
    return;
  }
  if (!await getBridgeEnabled()) {
    await clearNativeHeartbeatAlarm();
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
    if (message && message.type === 'pong') {
      markNativePong();
      return;
    }
    if (message && message.jsonrpc === '2.0' && 'id' in message && !('method' in message)) {
      settleNativeResponse(message);
      return;
    }
    if (message && message.jsonrpc === '2.0' && message.method && !('id' in message)) {
      handleNativeNotification(message);
      return;
    }
    if (message && message.jsonrpc === '2.0' && message.method) {
      handleRpc(message).then(
        result => nativePort?.postMessage({ jsonrpc: '2.0', id: message.id, result }),
        error => nativePort?.postMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: errorMessage(error), ...(errorData(error) ? { data: errorData(error) } : {}) }
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
        clearNativeHeartbeatAlarm().catch(() => {});
        setNativeStatus('stopped', 'Bridge stopped');
      }
    }).catch(() => {
      setNativeStatus('disconnected', error);
    });
  });

  const portResult = await chrome.storage.local.get('bridgePort');
  const port = Number.isInteger(portResult.bridgePort) ? portResult.bridgePort : 8765;
  lastNativePongAt = Date.now();
  await ensureNativeHeartbeatAlarm();

  sendNativeNotification('extension.ready', {
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    port: port
  });

  await pushSettingsToNative();
  sendNativePing();
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

async function ensureNativeHeartbeatAlarm() {
  await chrome.alarms.create(NATIVE_HEARTBEAT_ALARM, { periodInMinutes: NATIVE_HEARTBEAT_PERIOD_MINUTES }).catch(() => {});
}

async function clearNativeHeartbeatAlarm() {
  await chrome.alarms.clear(NATIVE_HEARTBEAT_ALARM).catch(() => {});
}

async function nativeHeartbeatTick() {
  if (!await getBridgeEnabled()) {
    await clearNativeHeartbeatAlarm();
    return;
  }
  await connectNative();
  if (!nativePort) return;
  if (lastNativePongAt && Date.now() - lastNativePongAt > NATIVE_HEARTBEAT_STALE_MS) {
    setNativeStatus('disconnected', 'Native heartbeat timed out');
  }
  sendNativePing();
}

function sendNativePing() {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ type: 'ping', timestamp: Date.now() });
  } catch {}
}

function markNativePong() {
  lastNativePongAt = Date.now();
  nativeStatus = {
    ...nativeStatus,
    state: 'connected',
    lastChecked: lastNativePongAt,
    lastHeartbeatAt: lastNativePongAt
  };
  delete nativeStatus.error;
  chrome.storage.local.set({ nativeStatus }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'NATIVE_STATUS_CHANGED', status: nativeStatus }).catch(() => {});
}

function setNativeStatus(state, error) {
  nativeStatus = {
    state,
    hostName: NATIVE_HOST,
    bridgeEnabled: bridgeEnabledCache,
    lastChecked: Date.now(),
    ...(lastNativePongAt ? { lastHeartbeatAt: lastNativePongAt } : {}),
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
      return { ok: true, ...(await cspHandlers.extensionGetCspBypass()) };
    case 'SET_CSP_BYPASS': {
      const bypass = message.enabled !== false;
      await chrome.storage.local.set({ bypassCSP: bypass });
      if (!bypass) await cspHandlers.clearTemporaryCspBypass();
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
  await ensureNativeHeartbeatAlarm();
  await connectNative();
  return nativeStatus;
}

async function stopBridge() {
  clearTimeout(reconnectTimer);
  await clearNativeHeartbeatAlarm();
  await chrome.storage.local.set({ bridgeEnabled: false });
  bridgeEnabledCache = false;
  if (nativePort) {
    const port = nativePort;
    nativePort = null;
    port.disconnect();
  }
  rejectPendingNativeRequests('Bridge stopped by user');
  // Drop all CDP attachments so the "DevTools is debugging this browser" banner
  // clears when the user stops the bridge.
  await detachAllDebuggers();
  setNativeStatus('stopped', 'Bridge stopped');
  return nativeStatus;
}

async function handleRpc(request) {
  const traceToken = await traceHandlers.traceRpcStart(request);
  try {
    const result = await dispatchRpc(request);
    await traceHandlers.traceRpcEnd(traceToken, request, result);
    return result;
  } catch (error) {
    await traceHandlers.traceRpcError(traceToken, request, error);
    throw error;
  }
}

async function dispatchRpc(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('Invalid JSON-RPC request');
  }
  await policyHandlers.assertMethodAllowed(request.method);
  const params = request.params || {};
  await assertOptionalPermissions(request.method, params);
  await assertRpcTabIsolation(request.method, params);
  await checkPermission(request.method, params);
  const handler = Object.hasOwn(rpcRouter, request.method) ? rpcRouter[request.method] : null;
  if (!handler) {
    throw new Error(`Unknown method: ${request.method}`);
  }
  return handler(params);
}

async function extensionInfo() {
  return {
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    nativeStatus,
    tools: Object.keys(rpcRouter).filter(method => method !== 'permission.check')
  };
}

async function extensionReload() {
  setTimeout(() => chrome.runtime.reload(), 50);
  return { reloading: true };
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
}

function handleNativeNotification(message) {
  if (message.method === 'bridge.subscriptionStatus') {
    updateCdpEventForwarding(message.params?.cdpEvents);
  }
}

function updateCdpEventForwarding(status) {
  cdpEventForwarding.all = status?.all === true;
  cdpEventForwarding.tabIds.clear();
  if (Array.isArray(status?.tabIds)) {
    for (const tabId of status.tabIds) {
      if (Number.isInteger(tabId)) cdpEventForwarding.tabIds.add(tabId);
    }
  }
}

function shouldForwardCdpEvent(event) {
  if (cdpEventForwarding.all) return true;
  const tabId = event?.source?.tabId;
  return Number.isInteger(tabId) && cdpEventForwarding.tabIds.has(tabId);
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  // onDetach also clears attachedTabs + interceptor state; delete eagerly too.
  await chrome.debugger.detach({ tabId }).catch(() => {});
  attachedTabs.delete(tabId);
}

async function detachAllDebuggers() {
  await Promise.all(Array.from(attachedTabs).map(tabId => detachDebugger(tabId)));
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
    files: ['content/dom-a11y.js', 'content/accessibility-tree.js', 'content/visual-indicator.js']
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
    await sessionsHandlers.assertSessionManaged(params.sessionId, method);
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
    return;
  }

  if (method === 'session.get' || method === 'session.createTab' || method === 'session.closeTab' || method === 'session.stop') {
    await sessionsHandlers.assertSessionManaged(params.sessionId, method);
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

  if (isTabTargetedMethod(method)) {
    await assertAgentManagedTabs([assertTabId(params.tabId)], method);
  }
}

function tabIdsFromParams(params) {
  return Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
}

async function assertAgentManagedTabs(tabIds, action) {
  if (!await sessionsHandlers.areAgentManagedTabs(tabIds)) {
    throw new Error(`Access denied: ${action} is limited to tabs in Agent-managed tab groups`);
  }
}

async function assertAgentManagedGroup(groupId, action) {
  if (!await sessionsHandlers.isAgentManagedGroupId(groupId)) {
    throw new Error(`Access denied: ${action} is limited to Agent-managed tab groups`);
  }
}



async function assertTabAllowed(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
  await assertAgentManagedGroup(tab.groupId, action);
  await policyHandlers.assertUrlAllowed(tab.url || '', action);
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

async function captureElementScreenshot(tabId, rect, options = {}) {
  const dataUrl = await captureTabScreenshot(tabId, options);
  const scale = typeof options.deviceScaleFactor === 'number' && options.deviceScaleFactor > 0 ? options.deviceScaleFactor : 1;
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const crop = {
    x: Math.max(0, Math.floor(rect.x * scale)),
    y: Math.max(0, Math.floor(rect.y * scale)),
    width: Math.max(1, Math.ceil(rect.width * scale)),
    height: Math.max(1, Math.ceil(rect.height * scale))
  };
  crop.width = Math.min(crop.width, image.width - crop.x);
  crop.height = Math.min(crop.height, image.height - crop.y);
  if (crop.width <= 0 || crop.height <= 0) throw new Error('Element screenshot crop is outside the captured viewport');
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const format = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await canvas.convertToBlob({
    type: format,
    ...(typeof options.quality === 'number' ? { quality: options.quality / 100 } : {})
  });
  const base64 = await blobToBase64(blob);
  return `data:${format};base64,${base64}`;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

// Best-effort lightweight page snapshot attached to trace error events. Stays
// within the Agent boundary, never throws, and never blocks the error path for
// long. Captures url/title/a11y counts always; the free-text preview is gated
// by the trace's includeText flag downstream (via the sanitized `text` key).
async function captureFailureContext(request) {
  const tabId = request?.params?.tabId;
  if (!Number.isInteger(tabId)) return null;
  try {
    if (!await sessionsHandlers.areAgentManagedTabs([tabId])) return null;
    const [{ result } = {}] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        return {
          url: location.href,
          title: document.title,
          a11y: {
            headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
            links: document.querySelectorAll('a[href]').length,
            buttons: document.querySelectorAll('button,[role="button"]').length,
            inputs: document.querySelectorAll('input,textarea,select').length
          },
          text
        };
      }
    }), 2500, 'captureFailureContext');
    return result ? { tabId, ...result } : null;
  } catch {
    return null;
  }
}

function pushLimited(map, key, value, limit) {
  const values = map.get(key) || [];
  values.push(value);
  while (values.length > limit) values.shift();
  map.set(key, values);
}

function waitForNetworkActivity(tabId, timeoutMs) {
  return waitForActivity(networkActivityWaitersByTab, tabId, timeoutMs);
}

function waitForDialogActivity(tabId, timeoutMs) {
  return waitForActivity(dialogActivityWaitersByTab, tabId, timeoutMs);
}

function waitForActivity(waitersByTab, tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const waiters = waitersByTab.get(tabId);
      if (waiters) {
        waiters.delete(finish);
        if (waiters.size === 0) waitersByTab.delete(tabId);
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const waiters = waitersByTab.get(tabId) || new Set();
    waiters.add(finish);
    waitersByTab.set(tabId, waiters);
  });
}

function notifyActivityWaiters(waitersByTab, tabId) {
  const waiters = waitersByTab.get(tabId);
  if (!waiters) return;
  for (const finish of [...waiters]) finish();
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

function errorData(error) {
  if (!error || typeof error !== 'object') return null;
  const data = {};
  if (typeof error.code === 'string' && error.code) data.code = error.code;
  if (error.diagnostic && typeof error.diagnostic === 'object') data.diagnostic = error.diagnostic;
  return Object.keys(data).length > 0 ? data : null;
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

async function isAgentTabGroupOperation(method, params = {}) {
  if (method === 'session.list') return true;
  if (method === 'session.get' || method === 'session.closeTab' || method === 'session.stop') {
    return typeof params.sessionId === 'string' && params.sessionId.length > 0;
  }
  if (method === 'tabs.list' && typeof params.query?.groupId === 'number') {
    return sessionsHandlers.isAgentManagedGroupId(params.query.groupId);
  }
  if (method === 'tabs.close') {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds : [params.tabId];
    return sessionsHandlers.areAgentManagedTabs(tabIds);
  }
  if (isTabTargetedMethod(method)) {
    // cookies.get exposes sensitive httpOnly session tokens, so we never
    // auto-allow it in-boundary without prompting for approval.
    if (method === 'cookies.get') return false;
    if (params.tabId == null) return false;
    return sessionsHandlers.areAgentManagedTabs([params.tabId]);
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
