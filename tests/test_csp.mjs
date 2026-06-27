import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importCspModule() {
  const source = await readFile(new URL('../extension/sw/csp.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function fakeChrome(store = {}) {
  const calls = { dynamic: [], rulesets: [], alarmsCreate: [], alarmsClear: [] };
  return {
    calls,
    storage: {
      local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; }
      }
    },
    declarativeNetRequest: {
      async updateDynamicRules(arg) { calls.dynamic.push(arg); },
      async updateEnabledRulesets(arg) { calls.rulesets.push(arg); }
    },
    alarms: {
      async create(name, opts) { calls.alarmsCreate.push({ name, opts }); },
      async clear(name) { calls.alarmsClear.push(name); }
    },
    tabs: { async get(id) { return { id, url: store.__tabUrl || 'https://tab.example/x' }; } },
    _store: store
  };
}

function timers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer: (fn, ms) => { const t = { fn, ms }; scheduled.push(t); return t; },
    clearTimer: () => {}
  };
}

test('maybeEnableTemporaryCspBypassForUrl returns null when bypass disabled', async () => {
  const { createCspHandlers } = await importCspModule();
  const t = timers();
  const h = createCspHandlers({ chromeApi: fakeChrome({ bypassCSP: false }), ...t });
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl('https://a.com/'), null);
});

test('maybeEnableTemporaryCspBypassForUrl returns null when params.bypassCSP === false', async () => {
  const { createCspHandlers } = await importCspModule();
  const t = timers();
  const h = createCspHandlers({ chromeApi: fakeChrome({ bypassCSP: true }), ...t });
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl('https://a.com/', { bypassCSP: false }), null);
});

test('maybeEnableTemporaryCspBypassForUrl ignores non-http(s) and invalid urls', async () => {
  const { createCspHandlers } = await importCspModule();
  const t = timers();
  const h = createCspHandlers({ chromeApi: fakeChrome({ bypassCSP: true }), ...t });
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl('chrome://settings'), null);
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl('file:///tmp/x'), null);
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl('not a url'), null);
  assert.equal(await h.maybeEnableTemporaryCspBypassForUrl(''), null);
});

test('maybeEnableTemporaryCspBypassForUrl installs origin-scoped rule, alarm and timer', async () => {
  const { createCspHandlers, CSP_BYPASS_ALARM } = await importCspModule();
  const chromeApi = fakeChrome({ bypassCSP: true });
  const t = timers();
  const h = createCspHandlers({ chromeApi, ...t });
  const active = await h.maybeEnableTemporaryCspBypassForUrl('https://shop.example/path?q=1');
  assert.equal(active.origin, 'https://shop.example');
  assert.equal(active.ruleId, 10001);
  assert.equal(active.ttlMs, 3 * 60 * 1000);

  const rule = chromeApi.calls.dynamic.at(-1).addRules[0];
  assert.equal(rule.id, 10001);
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.equal(rule.condition.urlFilter, '|https://shop.example/*');
  assert.ok(rule.action.responseHeaders.some(r => r.header === 'content-security-policy' && r.operation === 'remove'));

  assert.deepEqual(chromeApi._store.cspBypassActive.origin, 'https://shop.example');
  assert.equal(chromeApi.calls.alarmsCreate.at(-1).name, CSP_BYPASS_ALARM);
  assert.equal(t.scheduled.length, 1);
  assert.equal(t.scheduled[0].ms, 3 * 60 * 1000);
});

test('cspBypassTtlMs is clamped to [10s, 10min]', async () => {
  const { createCspHandlers } = await importCspModule();
  const t = timers();
  const h = createCspHandlers({ chromeApi: fakeChrome({ bypassCSP: true }), ...t });
  const tooSmall = await h.maybeEnableTemporaryCspBypassForUrl('https://a.com/', { cspBypassTtlMs: 1 });
  assert.equal(tooSmall.ttlMs, 10 * 1000);
  const tooBig = await h.maybeEnableTemporaryCspBypassForUrl('https://a.com/', { cspBypassTtlMs: 999 * 60 * 1000 });
  assert.equal(tooBig.ttlMs, 10 * 60 * 1000);
  const exact = await h.maybeEnableTemporaryCspBypassForUrl('https://a.com/', { cspBypassTtlMs: 30 * 1000 });
  assert.equal(exact.ttlMs, 30 * 1000);
});

test('maybeEnableTemporaryCspBypass reads tab url then delegates', async () => {
  const { createCspHandlers } = await importCspModule();
  const chromeApi = fakeChrome({ bypassCSP: true, __tabUrl: 'https://fromtab.example/a' });
  const t = timers();
  const h = createCspHandlers({ chromeApi, ...t });
  const active = await h.maybeEnableTemporaryCspBypass(7);
  assert.equal(active.origin, 'https://fromtab.example');
});

test('clearTemporaryCspBypass removes rule, alarm and stored state', async () => {
  const { createCspHandlers } = await importCspModule();
  const chromeApi = fakeChrome({ bypassCSP: true, cspBypassActive: { origin: 'https://x.example' } });
  const t = timers();
  const h = createCspHandlers({ chromeApi, ...t });
  await h.clearTemporaryCspBypass();
  assert.equal(chromeApi.calls.dynamic.at(-1).removeRuleIds[0], 10001);
  assert.equal(chromeApi.calls.alarmsClear.at(-1), (await importCspModule()).CSP_BYPASS_ALARM);
  assert.equal('cspBypassActive' in chromeApi._store, false);
});

test('extensionGetCspBypass reports enabled flag and active bypass', async () => {
  const { createCspHandlers } = await importCspModule();
  const chromeApi = fakeChrome({ bypassCSP: true });
  const t = timers();
  const h = createCspHandlers({ chromeApi, ...t });
  let info = await h.extensionGetCspBypass();
  assert.equal(info.enabled, true);
  assert.equal(info.mode, 'temporary-origin');
  assert.equal(info.active, null);
  await h.maybeEnableTemporaryCspBypassForUrl('https://y.example/');
  info = await h.extensionGetCspBypass();
  assert.equal(info.active.origin, 'https://y.example');
});

test('initCspBypass defaults bypassCSP to true when unset and disables static ruleset', async () => {
  const { createCspHandlers } = await importCspModule();
  const chromeApi = fakeChrome({});
  const t = timers();
  const h = createCspHandlers({ chromeApi, ...t });
  await h.initCspBypass();
  assert.equal(chromeApi._store.bypassCSP, true);
  assert.deepEqual(chromeApi.calls.rulesets.at(-1), { disableRulesetIds: ['ruleset_1'] });
});
