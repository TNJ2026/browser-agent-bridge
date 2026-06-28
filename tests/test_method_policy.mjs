import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importModule() {
  const source = await readFile(new URL('../extension/sw/method-policy.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

// method -> approval category. null means "not sensitive, no prompt".
const CATEGORY = [
  ['cookies.get', 'cookies'],
  ['tabs.list', 'read_tabs'],
  ['session.list', 'read_tabs'],
  ['session.get', 'read_tabs'],
  ['tabs.close', 'tab_control'],
  ['session.closeTab', 'tab_control'],
  ['session.stop', 'tab_control'],
  ['downloads.list', 'read_downloads'],
  ['downloads.waitFor', 'read_downloads'],
  ['downloads.download', 'read_downloads'],
  ['page.executeJavaScript', 'page_script'],
  ['page.waitForFunction', 'page_script'],
  ['page.addInitScript', 'page_script'],
  ['page.removeInitScript', 'page_script'],
  ['page.screenshot', 'page_screenshot'],
  ['page.pdf', 'page_screenshot'],
  ['page.domSnapshot', 'page_screenshot'],
  ['locator.screenshot', 'page_screenshot'],
  ['dom.type', 'page_input'],
  ['locator.fill', 'page_input'],
  ['keyboard.type', 'page_input'],
  ['keyboard.press', 'page_input'],
  ['computer.type', 'page_input'],
  ['dom.click', 'page_action'],
  ['locator.click', 'page_action'],
  ['locator.clickRef', 'page_action'],
  ['locator.setInputFiles', 'page_action'],
  ['page.setExtraHTTPHeaders', 'page_action'],
  ['page.acceptDialog', 'page_action'],
  ['computer.drag', 'page_action'],
  ['network.setBlockedUrls', 'page_action'],
  ['network.setInterceptors', 'page_action'],
  ['network.routeFromHAR', 'page_action'],
  ['network.interceptors.clear', 'page_action'],
  ['console.read', 'page_logs'],
  ['network.read', 'page_logs'],
  ['network.getResponseBody', 'page_logs'],
  ['network.interceptors.status', 'page_logs'],
  ['recording.status', 'recording_data'],
  ['recording.stop', 'recording_data'],
  ['recording.export', 'recording_data'],
  ['recording.clear', 'recording_data'],
  ['trace.start', 'trace_data'],
  ['trace.export', 'trace_data'],
  ['trace.clear', 'trace_data'],
  ['policy.set', 'policy_admin']
];

// Methods that must NOT prompt (no category).
const NO_CATEGORY = [
  'extension.info', 'extension.reload', 'extension.getCspBypass',
  'native.status', 'native.sitePatterns', 'permission.check',
  'tabs.create', 'tabs.activate', 'tabs.group',
  'session.start', 'session.createTab', 'session.addTab',
  'page.navigate', 'page.reload', 'page.waitForPopup', 'page.ariaSnapshot',
  'locator.count', 'locator.waitFor', 'locator.boundingBox',
  'expect.locator.toBeVisible', 'expect.page.toHaveTitle',
  'policy.get', 'policy.checkUrl'
];

test('getMethodCategory maps each sensitive method to its category', async () => {
  const { getMethodCategory } = await importModule();
  for (const [method, category] of CATEGORY) {
    assert.equal(getMethodCategory(method), category, method);
  }
});

test('getMethodCategory returns null for non-sensitive methods', async () => {
  const { getMethodCategory } = await importModule();
  for (const method of NO_CATEGORY) {
    assert.equal(getMethodCategory(method), null, method);
  }
});

test('SECURITY: cookies.get is its own always-prompt category', async () => {
  const { getMethodCategory } = await importModule();
  assert.equal(getMethodCategory('cookies.get'), 'cookies');
});

test('optionalPermissionsForMethod: tab/group/session/download families', async () => {
  const { optionalPermissionsForMethod } = await importModule();
  assert.deepEqual(optionalPermissionsForMethod('cookies.get'), ['tabs']);
  assert.deepEqual(optionalPermissionsForMethod('tabs.create'), ['tabs', 'tabGroups']);
  assert.deepEqual(optionalPermissionsForMethod('tabs.group'), ['tabs', 'tabGroups']);
  assert.deepEqual(optionalPermissionsForMethod('tabs.activate'), ['tabs']);
  assert.deepEqual(optionalPermissionsForMethod('session.start'), ['tabs', 'tabGroups']);
  assert.deepEqual(optionalPermissionsForMethod('session.addTab'), ['tabs', 'tabGroups']);
  assert.deepEqual(optionalPermissionsForMethod('downloads.list'), ['downloads']);
  assert.deepEqual(optionalPermissionsForMethod('downloads.waitFor'), ['downloads']);
});

test('optionalPermissionsForMethod: tab-acting families need tabs', async () => {
  const { optionalPermissionsForMethod } = await importModule();
  for (const method of ['page.navigate', 'dom.click', 'locator.fill', 'computer.click',
    'console.read', 'network.read', 'network.getResponseBody', 'network.setInterceptors',
    'network.interceptors.status', 'recording.start']) {
    assert.deepEqual(optionalPermissionsForMethod(method), ['tabs'], method);
  }
});

test('optionalPermissionsForMethod: download permission is gated by params.download', async () => {
  const { optionalPermissionsForMethod } = await importModule();
  assert.deepEqual(optionalPermissionsForMethod('recording.export', {}), []);
  assert.deepEqual(optionalPermissionsForMethod('recording.export', { download: true }), ['downloads']);
  assert.deepEqual(optionalPermissionsForMethod('trace.export', {}), []);
  assert.deepEqual(optionalPermissionsForMethod('trace.exportHtml', { download: true }), ['downloads']);
});

test('optionalPermissionsForMethod: unknown/no-permission methods return empty', async () => {
  const { optionalPermissionsForMethod } = await importModule();
  for (const method of ['extension.info', 'native.status', 'permission.check',
    'trace.start', 'policy.get', 'policy.set']) {
    assert.deepEqual(optionalPermissionsForMethod(method), [], method);
  }
});
