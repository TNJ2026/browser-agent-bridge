import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importModule() {
  const source = await readFile(new URL('../extension/sw/tab-scope.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const TAB_TARGETED = [
  // page family + its expect.* counterpart (note: 'expect.page.*' does NOT start
  // with 'page.', so it must be matched explicitly)
  'page.navigate', 'page.executeJavaScript', 'page.pdf', 'page.acceptDialog',
  'expect.page.toHaveTitle', 'expect.page.toMatchAriaSnapshot',
  'dom.click', 'dom.setInputFiles', 'dom.type',
  'locator.click', 'locator.fill', 'locator.screenshot',
  'expect.locator.toBeVisible', 'expect.locator.toHaveText',
  'computer.click', 'computer.type', 'computer.drag',
  'keyboard.type', 'keyboard.press', 'keyboard.down', 'keyboard.up', 'keyboard.compose',
  'network.read', 'network.getResponseBody', 'network.setInterceptors',
  'network.routeFromHAR', 'network.interceptors.events',
  'console.read',
  'indicator.set'
];

const NOT_TAB_TARGETED = [
  // tab/group/session-scoped methods that have their OWN isolation handling and
  // do NOT take params.tabId — must never be classified tab-targeted or the
  // isolation gate would wrongly call assertTabId(params.tabId).
  'tabs.list', 'tabs.close', 'tabs.activate', 'tabs.group',
  'session.start', 'session.get', 'session.list', 'session.addTab',
  'session.closeTab', 'session.stop', 'session.createTab',
  'downloads.list', 'downloads.waitFor',
  'trace.start', 'trace.stop', 'trace.export', 'trace.exportHtml', 'trace.clear',
  'recording.start', 'recording.status', 'recording.export', 'recording.clear',
  'policy.get', 'policy.set', 'policy.checkUrl',
  'native.status', 'native.sitePatterns', 'native.saveDataUrl',
  'extension.info', 'extension.reload', 'extension.getCspBypass',
  'permission.check'
];

test('classifies tab-targeted methods', async () => {
  const { isTabTargetedMethod } = await importModule();
  for (const m of TAB_TARGETED) {
    assert.equal(isTabTargetedMethod(m), true, `${m} should be tab-targeted`);
  }
});

test('does not classify non-tab-targeted methods', async () => {
  const { isTabTargetedMethod } = await importModule();
  for (const m of NOT_TAB_TARGETED) {
    assert.equal(isTabTargetedMethod(m), false, `${m} should NOT be tab-targeted`);
  }
});

test('SECURITY: cookies.get stays tab-targeted (isolation must restrict it)', async () => {
  const { isTabTargetedMethod } = await importModule();
  // cookies.get is tab-targeted so assertRpcTabIsolation confines it to
  // Agent-managed tabs; isAgentTabGroupOperation separately keeps it prompting.
  assert.equal(isTabTargetedMethod('cookies.get'), true);
});

test('SECURITY: tabs.list is NOT tab-targeted (it keys on query.groupId, not tabId)', async () => {
  const { isTabTargetedMethod } = await importModule();
  assert.equal(isTabTargetedMethod('tabs.list'), false);
});

test('network.interceptors.status is tab-targeted only when scoped to a tab', async () => {
  const { isTabTargetedMethod } = await importModule();
  assert.equal(isTabTargetedMethod('network.interceptors.status'), false);
  assert.equal(isTabTargetedMethod('network.interceptors.status', {}), false);
  assert.equal(isTabTargetedMethod('network.interceptors.status', { tabId: 7 }), true);
});

test('prefix anchoring requires the dot (no loose prefix matches)', async () => {
  const { isTabTargetedMethod } = await importModule();
  assert.equal(isTabTargetedMethod('network'), false);
  assert.equal(isTabTargetedMethod('pages.list'), false);
  assert.equal(isTabTargetedMethod('consolelog'), false);
  assert.equal(isTabTargetedMethod('expect.foo.bar'), false); // only expect.page./expect.locator.
});
