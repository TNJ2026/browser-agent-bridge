import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPolicyModule() {
  const source = await readFile(new URL('../extension/sw/policy.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function fakeChrome(store = {}) {
  return {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
          const out = {};
          for (const k of key) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); }
      }
    },
    _store: store
  };
}

test('loadPolicy returns defaults when nothing stored', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  const policy = await h.loadPolicy();
  assert.ok(policy.blockedUrlPatterns.includes('chrome://*'));
  assert.ok(policy.blockedUrlPatterns.includes('chrome-extension://*'));
  assert.deepEqual(policy.allowedUrlPatterns, []);
  assert.deepEqual(policy.blockedMethods, []);
});

test('assertUrlAllowed allows about:blank and empty url without consulting policy', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  await h.assertUrlAllowed('', 'navigate');
  await h.assertUrlAllowed('about:blank', 'navigate');
});

test('assertUrlAllowed blocks chrome:// by default and reports matched pattern', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  await assert.rejects(() => h.assertUrlAllowed('chrome://settings', 'navigate'),
    /blocked by policy.*chrome:\/\/settings.*matched chrome:\/\/\*/);
  await h.assertUrlAllowed('https://example.com/', 'navigate'); // not blocked
});

test('KNOWN GAP: default chromewebstore pattern does NOT block real https URLs', async () => {
  // urlPatternMatches anchors ^...$, and the default pattern lacks a scheme
  // wildcard, so `chromewebstore.google.com/*` never matches a full URL like
  // `https://chromewebstore.google.com/...`. The default web-store block is
  // therefore ineffective. Pinned here as current behavior; flip if fixed to
  // e.g. `*://chromewebstore.google.com/*`.
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  await h.assertUrlAllowed('https://chromewebstore.google.com/detail/foo', 'navigate');
});

test('allowedUrlPatterns override blockedUrlPatterns', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  const policy = {
    allowedUrlPatterns: ['chrome://settings'],
    blockedUrlPatterns: ['chrome://*']
  };
  assert.equal(h.isUrlAllowedByPolicy('chrome://settings', policy), true);
  assert.equal(h.isUrlAllowedByPolicy('chrome://flags', policy), false);
});

test('assertMethodAllowed never blocks always-allowed methods', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const store = { browserAgentBridgePolicy: { blockedMethods: ['*'] } };
  const h = createPolicyHandlers({ chromeApi: fakeChrome(store) });
  for (const m of ['extension.info', 'native.status', 'policy.get', 'policy.checkUrl', 'permission.check']) {
    await h.assertMethodAllowed(m);
  }
  await assert.rejects(() => h.assertMethodAllowed('page.evaluate'), /Method blocked by policy/);
});

test('allowedMethods override blockedMethods', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  const policy = { allowedMethods: ['page.*'], blockedMethods: ['page.evaluate'] };
  assert.equal(h.isMethodAllowedByPolicy('page.evaluate', policy), true);
  assert.equal(h.isMethodAllowedByPolicy('dom.click', policy), true); // nothing blocks it
  const blockOnly = { allowedMethods: [], blockedMethods: ['page.*'] };
  assert.equal(h.isMethodAllowedByPolicy('page.evaluate', blockOnly), false);
});

test('firstMatchingPattern wildcard is anchored and case-insensitive', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const h = createPolicyHandlers({ chromeApi: fakeChrome() });
  assert.equal(h.firstMatchingPattern('https://EXAMPLE.com/a', ['https://example.com/*']), 'https://example.com/*');
  // anchored: a bare host pattern does not match a path-suffixed url unless wildcard present
  assert.equal(h.firstMatchingPattern('https://example.com/a', ['https://example.com']), null);
  assert.equal(h.firstMatchingPattern('https://example.com', ['https://example.com']), 'https://example.com');
  // regex metacharacters in pattern are escaped (the dot is literal)
  assert.equal(h.firstMatchingPattern('https://exampleXcom/', ['https://example.com/*']), null);
});

test('policySet normalizes/trims lists and roundtrips through policyGet', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const chromeApi = fakeChrome();
  const h = createPolicyHandlers({ chromeApi });
  await h.policySet({
    blockedUrlPatterns: ['  https://a.com/*  ', 42, '', 'https://b.com/*'],
    allowedMethods: ['page.*']
  });
  const policy = await h.policyGet();
  assert.deepEqual(policy.blockedUrlPatterns, ['https://a.com/*', 'https://b.com/*']);
  assert.deepEqual(policy.allowedMethods, ['page.*']);
  assert.deepEqual(policy.allowedUrlPatterns, []);
});

test('policyCheckUrl requires url or method and reports matches', async () => {
  const { createPolicyHandlers } = await importPolicyModule();
  const store = { browserAgentBridgePolicy: { blockedUrlPatterns: ['chrome://*'], allowedUrlPatterns: [], blockedMethods: ['page.*'], allowedMethods: [] } };
  const h = createPolicyHandlers({ chromeApi: fakeChrome(store) });
  await assert.rejects(() => h.policyCheckUrl({}), /requires url or method/);
  const res = await h.policyCheckUrl({ url: 'chrome://settings', method: 'page.evaluate' });
  assert.equal(res.allowed, false);
  assert.equal(res.matchedBlockedPattern, 'chrome://*');
  assert.equal(res.matchedBlockedMethod, 'page.*');
  const ok = await h.policyCheckUrl({ url: 'https://example.com/' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.matchedBlockedPattern, null);
});
