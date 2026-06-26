import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importDevtoolsModule() {
  const networkSource = await readFile(new URL('../extension/sw/network-interceptors.js', import.meta.url), 'utf8');
  const devtoolsSource = await readFile(new URL('../extension/sw/devtools.js', import.meta.url), 'utf8');
  const source = [
    networkSource.replaceAll('export ', ''),
    devtoolsSource.replace("import { fetchPatternsForRules } from './network-interceptors.js';\n\n", '')
  ].join('\n');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function makeHandlers() {
  const { createDevtoolsHandlers } = await importDevtoolsModule();
  const calls = [];
  let attachCount = 0;
  const fetchInterceptorsByTab = new Map();
  const interceptorStatusCalls = [];
  const clearInterceptorCalls = [];
  const interceptorEventsCalls = [];
  const clearInterceptorEventsCalls = [];
  const handlers = createDevtoolsHandlers({
    assertTabId(value) {
      if (!Number.isInteger(value)) throw new Error('bad tabId');
      return value;
    },
    async assertTabAllowed() {},
    async attachDebugger() {
      attachCount += 1;
    },
    async cdp(tabId, method, params) {
      calls.push({ tabId, method, params });
      return {};
    },
    consoleEventsByTab: new Map(),
    networkEventsByTab: new Map(),
    fetchInterceptorsByTab,
    interceptorStatus(tabId) {
      interceptorStatusCalls.push(tabId);
      return { tabId, rules: fetchInterceptorsByTab.get(tabId) || [] };
    },
    async clearInterceptors(tabId) {
      clearInterceptorCalls.push(tabId);
      fetchInterceptorsByTab.delete(tabId);
      return { ok: true, tabId, rulesCount: 0 };
    },
    interceptorEvents(tabId, options) {
      interceptorEventsCalls.push({ tabId, options });
      return { tabId, events: [{ ruleId: 'rule-1' }] };
    },
    clearInterceptorEvents(tabId) {
      clearInterceptorEventsCalls.push(tabId);
      return { ok: true, tabId, eventsCount: 0 };
    }
  });
  return {
    handlers,
    calls,
    clearInterceptorCalls,
    clearInterceptorEventsCalls,
    interceptorEventsCalls,
    interceptorStatusCalls,
    fetchInterceptorsByTab,
    get attachCount() {
      return attachCount;
    }
  };
}

test('network.setInterceptors enables Fetch only for configured URL patterns', async () => {
  const context = await makeHandlers();

  const result = await context.handlers.networkSetInterceptors({
    tabId: 7,
    rules: [
      {
        urlPattern: '*api.example.test/user*',
        action: 'mock',
        method: 'get',
        resourceType: 'XHR',
        times: 1,
        responseHeaders: { 'Content-Type': 'application/json' },
        responseBody: '{"ok":true}'
      },
      {
        urlPattern: '*cdn.example.test/*',
        action: 'modifyHeaders',
        methods: ['post', 'PUT'],
        resourceTypes: ['Script', 'Fetch'],
        requestHeaders: { 'X-Test': 123, Authorization: null }
      },
      {
        urlPattern: '*api.example.test/user*',
        action: 'block'
      },
      {
        id: 'regex-api',
        urlRegex: '^https://api\\.example\\.test/v\\d+/items/\\d+$',
        action: 'block',
        postDataRegex: '"operationName"\\s*:\\s*"GetItem"',
        headerContains: { Authorization: 'Bearer ' },
        headerRegex: { 'X-Tenant': '^tenant-\\d+$' },
        resourceType: 'Fetch'
      }
    ]
  });

  assert.deepEqual(result, { ok: true, rulesCount: 4 });
  assert.equal(context.attachCount, 1);
  assert.equal(context.fetchInterceptorsByTab.get(7).length, 4);
  assert.deepEqual(context.calls, [
    {
      tabId: 7,
      method: 'Fetch.enable',
      params: {
        patterns: [
          { urlPattern: '*api.example.test/user*', requestStage: 'Request', resourceType: 'XHR' },
          { urlPattern: '*cdn.example.test/*', requestStage: 'Request', resourceType: 'Script' },
          { urlPattern: '*cdn.example.test/*', requestStage: 'Request', resourceType: 'Fetch' },
          { urlPattern: '*api.example.test/user*', requestStage: 'Request' },
          { urlPattern: '*', requestStage: 'Request', resourceType: 'Fetch' }
        ]
      }
    }
  ]);
  assert.deepEqual(context.fetchInterceptorsByTab.get(7)[0].methods, ['GET']);
  assert.equal(context.fetchInterceptorsByTab.get(7)[0].times, 1);
  assert.deepEqual(context.fetchInterceptorsByTab.get(7)[1].requestHeaders, { 'X-Test': '123', Authorization: null });
  assert.deepEqual(context.fetchInterceptorsByTab.get(7)[1].methods, ['POST', 'PUT']);
  assert.equal(context.fetchInterceptorsByTab.get(7)[3].urlRegex, '^https://api\\.example\\.test/v\\d+/items/\\d+$');
  assert.equal(context.fetchInterceptorsByTab.get(7)[3].postDataRegex, '"operationName"\\s*:\\s*"GetItem"');
  assert.deepEqual(context.fetchInterceptorsByTab.get(7)[3].headerContains, { Authorization: 'Bearer ' });
  assert.deepEqual(context.fetchInterceptorsByTab.get(7)[3].headerRegex, { 'X-Tenant': '^tenant-\\d+$' });
});

test('network.setInterceptors rejects invalid rules before attaching debugger', async () => {
  const context = await makeHandlers();

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ action: 'mock', responseCode: 700 }]
    }),
    /urlPattern or urlRegex/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlRegex: '[', action: 'block' }]
    }),
    /urlRegex/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*api*', postDataRegex: '[', action: 'block' }]
    }),
    /postDataRegex/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*api*', headerRegex: { 'X-Test': '[' }, action: 'block' }]
    }),
    /headerRegex/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*asset*', action: 'mock', responseBodyBase64: 'not base64!' }]
    }),
    /responseBodyBase64/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*asset*', action: 'mock', responseBody: 'text', responseBodyBase64: 'dGV4dA==' }]
    }),
    /responseBody or responseBodyBase64/
  );

  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
  assert.equal(context.fetchInterceptorsByTab.has(7), false);
});

test('network.setInterceptors validates method and resourceType filters', async () => {
  const context = await makeHandlers();

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*api*', action: 'block', methods: ['GET', ''] }]
    }),
    /method\[1\]/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*api*', action: 'block', resourceTypes: [] }]
    }),
    /resourceType/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [{ urlPattern: '*api*', action: 'block', times: 0 }]
    }),
    /times/
  );

  await assert.rejects(
    context.handlers.networkSetInterceptors({
      tabId: 7,
      rules: [
        { id: 'dup', urlPattern: '*one*', action: 'block' },
        { id: 'dup', urlPattern: '*two*', action: 'block' }
      ]
    }),
    /unique/
  );

  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});

test('network.setInterceptors clears Fetch interception when rules are empty', async () => {
  const context = await makeHandlers();
  context.fetchInterceptorsByTab.set(7, [{ urlPattern: '*', action: 'block' }]);

  const result = await context.handlers.networkSetInterceptors({ tabId: 7, rules: [] });

  assert.deepEqual(result, { ok: true, rulesCount: 0 });
  assert.equal(context.fetchInterceptorsByTab.has(7), false);
  assert.deepEqual(context.calls, [{ tabId: 7, method: 'Fetch.disable', params: undefined }]);
});

test('network.setBlockedUrls validates URL pattern inputs', async () => {
  const context = await makeHandlers();

  await assert.rejects(
    context.handlers.networkSetBlockedUrls({ tabId: 7, urls: ['*ok*', ''] }),
    /urls\[1\]/
  );

  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});

test('network.interceptors.status returns current interceptor state', async () => {
  const context = await makeHandlers();
  context.fetchInterceptorsByTab.set(7, [{ urlPattern: '*api*', action: 'mock', times: 2 }]);

  const result = await context.handlers.networkInterceptorsStatus({ tabId: 7 });

  assert.deepEqual(context.interceptorStatusCalls, [7]);
  assert.deepEqual(result, { tabId: 7, rules: [{ urlPattern: '*api*', action: 'mock', times: 2 }] });
  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});

test('network.interceptors.clear removes current interceptor state', async () => {
  const context = await makeHandlers();
  context.fetchInterceptorsByTab.set(7, [{ urlPattern: '*api*', action: 'mock', times: 2 }]);

  const result = await context.handlers.networkInterceptorsClear({ tabId: 7 });

  assert.deepEqual(context.clearInterceptorCalls, [7]);
  assert.deepEqual(result, { ok: true, tabId: 7, rulesCount: 0 });
  assert.equal(context.fetchInterceptorsByTab.has(7), false);
  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});

test('network.interceptors.events returns recent match events', async () => {
  const context = await makeHandlers();

  const result = await context.handlers.networkInterceptorsEvents({ tabId: 7, limit: 5 });

  assert.deepEqual(context.interceptorEventsCalls, [{ tabId: 7, options: { limit: 5 } }]);
  assert.deepEqual(result, { tabId: 7, events: [{ ruleId: 'rule-1' }] });
  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});

test('network.interceptors.events normalizes filters', async () => {
  const context = await makeHandlers();

  await context.handlers.networkInterceptorsEvents({
    tabId: 7,
    limit: 999,
    ruleId: 'route-1',
    action: 'mock',
    method: 'post',
    urlContains: '/api/',
    since: 123
  });

  assert.deepEqual(context.interceptorEventsCalls, [{
    tabId: 7,
    options: {
      limit: 500,
      ruleId: 'route-1',
      action: 'mock',
      method: 'POST',
      urlContains: '/api/',
      since: 123
    }
  }]);
});

test('network.interceptors.clearEvents clears recent match events', async () => {
  const context = await makeHandlers();

  const result = await context.handlers.networkInterceptorsClearEvents({ tabId: 7 });

  assert.deepEqual(context.clearInterceptorEventsCalls, [7]);
  assert.deepEqual(result, { ok: true, tabId: 7, eventsCount: 0 });
  assert.equal(context.attachCount, 0);
  assert.equal(context.calls.length, 0);
});
