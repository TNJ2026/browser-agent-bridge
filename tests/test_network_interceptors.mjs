import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importNetworkInterceptorsModule() {
  const source = await readFile(new URL('../extension/sw/network-interceptors.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function makeController(rules) {
  const { createNetworkInterceptorController } = await importNetworkInterceptorsModule();
  const calls = [];
  const fetchInterceptorsByTab = new Map([[7, rules]]);
  const controller = createNetworkInterceptorController({
    async cdp(tabId, method, params) {
      calls.push({ tabId, method, params });
      return {};
    },
    fetchInterceptorsByTab
  });
  return { calls, controller, fetchInterceptorsByTab };
}

test('network interceptor consumes one-shot mock rules and disables Fetch', async () => {
  const context = await makeController([
    {
      urlPattern: '*api.example.test/user*',
      id: 'mock-user-once',
      action: 'mock',
      responseCode: 201,
      responseHeaders: { 'Content-Type': 'application/json' },
      responseBody: '{"ok":true}',
      times: 1
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-1',
    resourceType: 'XHR',
    request: { url: 'https://api.example.test/user/1', method: 'GET', headers: {} }
  });

  assert.equal(context.fetchInterceptorsByTab.has(7), false);
  assert.equal(context.calls[0].method, 'Fetch.fulfillRequest');
  assert.deepEqual(context.calls[0].params.responseHeaders, [{ name: 'Content-Type', value: 'application/json' }]);
  assert.equal(context.calls[1].method, 'Fetch.disable');
  const status = context.controller.status(7);
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].ruleId, 'mock-user-once');
  assert.equal(status.events[0].action, 'mock');
  assert.equal(status.events[0].url, 'https://api.example.test/user/1');
  assert.equal(status.events[0].remainingTimes, 0);
});

test('network interceptor continues unmatched requests', async () => {
  const context = await makeController([
    { urlPattern: '*api.example.test/user*', action: 'block', methods: ['POST'] }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-2',
    resourceType: 'XHR',
    request: { url: 'https://api.example.test/user/1', method: 'GET', headers: {} }
  });

  assert.deepEqual(context.calls, [
    { tabId: 7, method: 'Fetch.continueRequest', params: { requestId: 'request-2' } }
  ]);
  assert.equal(context.fetchInterceptorsByTab.get(7).length, 1);
});

test('network interceptor supports URL regex matching', async () => {
  const context = await makeController([
    {
      id: 'regex-route',
      urlPattern: '*',
      urlRegex: '^https://api\\.example\\.test/v\\d+/items/\\d+$',
      action: 'block'
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-regex-miss',
    resourceType: 'Fetch',
    request: { url: 'https://api.example.test/v1/items/latest', method: 'GET', headers: {} }
  });
  await context.controller.handleRequestPaused(7, {
    requestId: 'request-regex-hit',
    resourceType: 'Fetch',
    request: { url: 'https://api.example.test/v1/items/42', method: 'GET', headers: {} }
  });

  assert.equal(context.calls[0].method, 'Fetch.continueRequest');
  assert.equal(context.calls[1].method, 'Fetch.failRequest');
  assert.equal(context.controller.status(7).events[0].ruleId, 'regex-route');
});

test('network interceptor can fulfill base64 mock bodies', async () => {
  const context = await makeController([
    {
      id: 'binary-mock',
      urlPattern: '*asset.bin',
      action: 'mock',
      responseHeaders: { 'Content-Type': 'application/octet-stream' },
      responseBodyBase64: 'AAECAw=='
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-binary',
    resourceType: 'Fetch',
    request: { url: 'https://static.example.test/asset.bin', method: 'GET', headers: {} }
  });

  assert.equal(context.calls[0].method, 'Fetch.fulfillRequest');
  assert.equal(context.calls[0].params.body, 'AAECAw==');
  assert.deepEqual(context.calls[0].params.responseHeaders, [
    { name: 'Content-Type', value: 'application/octet-stream' }
  ]);
});

test('network interceptor supports post data filters', async () => {
  const context = await makeController([
    {
      id: 'graphql-route',
      urlPattern: '*api.example.test/graphql',
      postDataContains: '"operationName":"GetUser"',
      postDataRegex: '"variables"\\s*:',
      action: 'block'
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-post-miss',
    resourceType: 'Fetch',
    request: {
      url: 'https://api.example.test/graphql',
      method: 'POST',
      postData: '{"operationName":"Other","variables":{}}',
      headers: {}
    }
  });
  await context.controller.handleRequestPaused(7, {
    requestId: 'request-post-hit',
    resourceType: 'Fetch',
    request: {
      url: 'https://api.example.test/graphql',
      method: 'POST',
      postData: '{"operationName":"GetUser","variables":{"id":1}}',
      headers: {}
    }
  });

  assert.equal(context.calls[0].method, 'Fetch.continueRequest');
  assert.equal(context.calls[1].method, 'Fetch.failRequest');
  assert.equal(context.controller.status(7).events[0].ruleId, 'graphql-route');
});

test('network interceptor supports request header filters', async () => {
  const context = await makeController([
    {
      id: 'tenant-route',
      urlPattern: '*api.example.test/tenant*',
      headerContains: { authorization: 'Bearer ' },
      headerRegex: { 'X-Tenant': '^tenant-\\d+$' },
      action: 'block'
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-header-miss',
    resourceType: 'Fetch',
    request: {
      url: 'https://api.example.test/tenant',
      method: 'GET',
      headers: { Authorization: 'Basic token', 'x-tenant': 'tenant-123' }
    }
  });
  await context.controller.handleRequestPaused(7, {
    requestId: 'request-header-hit',
    resourceType: 'Fetch',
    request: {
      url: 'https://api.example.test/tenant',
      method: 'GET',
      headers: { Authorization: 'Bearer token', 'x-tenant': 'tenant-123' }
    }
  });

  assert.equal(context.calls[0].method, 'Fetch.continueRequest');
  assert.equal(context.calls[1].method, 'Fetch.failRequest');
  assert.equal(context.controller.status(7).events[0].ruleId, 'tenant-route');
});

test('network interceptor modifyHeaders can remove headers case-insensitively', async () => {
  const context = await makeController([
    {
      urlPattern: '*api.example.test/user*',
      action: 'modifyHeaders',
      requestHeaders: { Authorization: null, 'X-Test': 'new' }
    }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-headers',
    resourceType: 'XHR',
    request: {
      url: 'https://api.example.test/user/1',
      method: 'GET',
      headers: { authorization: 'Bearer old', 'X-Test': 'old', Accept: 'application/json' }
    }
  });

  assert.equal(context.calls[0].method, 'Fetch.continueRequest');
  assert.equal(context.calls[0].params.requestId, 'request-headers');
  assert.deepEqual(
    context.calls[0].params.headers.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Test', value: 'new' }
    ]
  );
});

test('network interceptor status returns cloned rule snapshots', async () => {
  const context = await makeController([
    { urlPattern: '*api*', action: 'block', times: 2 }
  ]);

  const result = context.controller.status(7);
  result.rules[0].times = 0;

  assert.equal(context.fetchInterceptorsByTab.get(7)[0].times, 2);
});

test('network interceptor clear disables Fetch and removes tab rules', async () => {
  const context = await makeController([
    { urlPattern: '*api*', action: 'block' }
  ]);

  const result = await context.controller.clear(7);

  assert.deepEqual(result, { ok: true, tabId: 7, rulesCount: 0 });
  assert.equal(context.fetchInterceptorsByTab.has(7), false);
  assert.deepEqual(context.calls, [{ tabId: 7, method: 'Fetch.disable', params: undefined }]);
});
