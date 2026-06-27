import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function makeHandlers() {
  const { createPageHandlers } = await importPageModule();
  const calls = [];
  const handlers = createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v) => v,
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async () => {},
    normalizeTab: (t) => t,
    waitForTabComplete: async () => {},
    sleep: async () => {},
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async (tabId, method, params) => { calls.push({ method, params }); return {}; },
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: { tabs: { get: async () => ({ id: 1 }) } }
  });
  return { handlers, calls };
}

const find = (calls, method) => calls.find(c => c.method === method);

test('setViewport sends device metrics override', async () => {
  const { handlers, calls } = await makeHandlers();
  const res = await handlers.pageSetViewport({ tabId: 1, width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  assert.equal(res.ok, true);
  const c = find(calls, 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(c.params, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
});

test('setViewport rejects invalid dimensions', async () => {
  const { handlers } = await makeHandlers();
  await assert.rejects(handlers.pageSetViewport({ tabId: 1, width: 0, height: 100 }), /positive integer/);
});

test('emulateMedia maps colorScheme and reducedMotion to media features', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pageEmulateMedia({ tabId: 1, media: 'screen', colorScheme: 'dark', reducedMotion: 'reduce' });
  const c = find(calls, 'Emulation.setEmulatedMedia');
  assert.equal(c.params.media, 'screen');
  assert.deepEqual(c.params.features, [
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'reduce' }
  ]);
});

test('setGeolocation sends an override and validates coordinates', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pageSetGeolocation({ tabId: 1, latitude: 37.77, longitude: -122.41, accuracy: 50 });
  const c = find(calls, 'Emulation.setGeolocationOverride');
  assert.deepEqual(c.params, { latitude: 37.77, longitude: -122.41, accuracy: 50 });

  const { handlers: h2 } = await makeHandlers();
  await assert.rejects(h2.pageSetGeolocation({ tabId: 1, latitude: 'x', longitude: 1 }), /latitude and longitude/);
});

test('setLocale overrides locale and timezone', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pageSetLocale({ tabId: 1, locale: 'ja-JP', timezone: 'Asia/Tokyo' });
  assert.equal(find(calls, 'Emulation.setLocaleOverride').params.locale, 'ja-JP');
  assert.equal(find(calls, 'Emulation.setTimezoneOverride').params.timezoneId, 'Asia/Tokyo');
});

test('setOffline toggles network conditions', async () => {
  const { handlers, calls } = await makeHandlers();
  const res = await handlers.pageSetOffline({ tabId: 1, offline: true });
  assert.equal(res.offline, true);
  assert.equal(find(calls, 'Network.emulateNetworkConditions').params.offline, true);
});

test('clearEmulation clears device/geo/media/network overrides', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pageClearEmulation({ tabId: 1 });
  assert.ok(find(calls, 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(find(calls, 'Emulation.clearGeolocationOverride'));
  assert.ok(find(calls, 'Emulation.setEmulatedMedia'));
  assert.equal(find(calls, 'Network.emulateNetworkConditions').params.offline, false);
});
