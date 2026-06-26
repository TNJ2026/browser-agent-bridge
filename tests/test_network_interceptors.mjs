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
    {
      urlPattern: '*api*',
      action: 'block',
      times: 2,
      requestHeaders: { Authorization: 'Bearer secret', 'X-Test': 'visible' },
      headerContains: { Cookie: 'session=', 'X-Tenant': 'tenant-' },
      headerRegex: { 'X-Api-Key': '^sk-', 'X-Trace': '^trace-' }
    }
  ]);

  const result = context.controller.status(7);
  result.rules[0].times = 0;

  assert.equal(context.fetchInterceptorsByTab.get(7)[0].times, 2);
  assert.deepEqual(result.rules[0].requestHeaders, { Authorization: '[redacted]', 'X-Test': 'visible' });
  assert.deepEqual(result.rules[0].headerContains, { Cookie: '[redacted]', 'X-Tenant': 'tenant-' });
  assert.deepEqual(result.rules[0].headerRegex, { 'X-Api-Key': '[redacted]', 'X-Trace': '^trace-' });
  assert.equal(context.fetchInterceptorsByTab.get(7)[0].requestHeaders.Authorization, 'Bearer secret');
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

test('network interceptor events can be read and cleared independently', async () => {
  const context = await makeController([
    { id: 'event-route', urlPattern: '*api*', action: 'block' }
  ]);

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-event',
    resourceType: 'Fetch',
    request: { url: 'https://api.example.test/event', method: 'GET', headers: {} }
  });

  assert.equal(context.controller.events(7, 1).events[0].ruleId, 'event-route');
  const clearResult = context.controller.clearEvents(7);

  assert.deepEqual(clearResult, { ok: true, tabId: 7, eventsCount: 0 });
  assert.deepEqual(context.controller.events(7).events, []);
  assert.equal(context.fetchInterceptorsByTab.get(7).length, 1);
});

test('network interceptor events support filters', async () => {
  const context = await makeController([
    { id: 'block-route', urlPattern: '*api.example.test/block*', action: 'block' },
    { id: 'mock-route', urlPattern: '*api.example.test/mock*', action: 'mock', responseBody: '{}' }
  ]);
  const before = Date.now();

  await context.controller.handleRequestPaused(7, {
    requestId: 'request-block',
    resourceType: 'Fetch',
    request: { url: 'https://api.example.test/block/1', method: 'GET', headers: {} }
  });
  await context.controller.handleRequestPaused(7, {
    requestId: 'request-mock',
    resourceType: 'Fetch',
    request: { url: 'https://api.example.test/mock/1', method: 'POST', headers: {} }
  });

  const filtered = context.controller.events(7, {
    action: 'mock',
    method: 'POST',
    ruleId: 'mock-route',
    urlContains: '/mock/',
    since: before,
    limit: 10
  });

  assert.deepEqual(filtered.events.map(event => event.ruleId), ['mock-route']);
  assert.equal(filtered.events[0].method, 'POST');
  assert.equal(context.controller.events(7, { action: 'redirect' }).events.length, 0);
});

const SAMPLE_HAR = {
  log: {
    entries: [
      {
        request: { method: 'GET', url: 'https://api.example.test/items' },
        response: {
          status: 200,
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Content-Length', value: '12' },
            { name: ':status', value: '200' }
          ],
          content: { text: '{"items":[]}', mimeType: 'application/json' }
        }
      },
      {
        request: { method: 'POST', url: 'https://api.example.test/login' },
        response: {
          status: 201,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { text: 'eyJvayI6dHJ1ZX0=', encoding: 'base64', mimeType: 'application/json' }
        }
      },
      {
        request: { method: 'GET', url: 'https://img.example.test/x.png' },
        response: { status: 0, headers: [], content: {} }
      }
    ]
  }
};

test('harEntriesToRules converts entries into mock rules', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  const rules = harEntriesToRules(SAMPLE_HAR);

  assert.equal(rules.length, 2); // status-0 entry skipped
  assert.equal(rules[0].action, 'mock');
  assert.equal(rules[0].urlPattern, 'https://api.example.test/items');
  assert.deepEqual(rules[0].methods, ['GET']);
  assert.equal(rules[0].responseCode, 200);
  assert.equal(rules[0].responseBody, '{"items":[]}');
  // transfer + pseudo headers dropped, content-type kept
  assert.deepEqual(rules[0].responseHeaders, { 'Content-Type': 'application/json' });
  assert.equal(rules[1].responseBodyBase64, 'eyJvayI6dHJ1ZX0=');
  assert.equal(rules[1].responseBody, undefined);
});

test('harEntriesToRules supports urlFilter, methods, and sequential', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  assert.equal(harEntriesToRules(SAMPLE_HAR, { urlFilter: 'login' }).length, 1);
  assert.equal(harEntriesToRules(SAMPLE_HAR, { methods: ['post'] })[0].urlPattern, 'https://api.example.test/login');
  assert.equal(harEntriesToRules(SAMPLE_HAR, { sequential: true })[0].times, 1);
});

test('harEntriesToRules appends a catch-all block rule for notFound abort', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  const rules = harEntriesToRules(SAMPLE_HAR, { notFound: 'abort' });
  assert.equal(rules.length, 3);
  const last = rules[rules.length - 1];
  assert.equal(last.urlPattern, '*');
  assert.equal(last.action, 'block');
});

test('harEntriesToRules rejects a malformed archive', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  assert.throws(() => harEntriesToRules({}), /log\.entries/);
  assert.throws(() => harEntriesToRules({ log: {} }), /log\.entries/);
});

test('HAR-derived rules replay a recorded response', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  const rules = harEntriesToRules(SAMPLE_HAR);
  const context = await makeController(rules);

  await context.controller.handleRequestPaused(7, {
    requestId: 'r1',
    resourceType: 'XHR',
    request: { url: 'https://api.example.test/items', method: 'GET', headers: {} }
  });

  const fulfill = context.calls.find(call => call.method === 'Fetch.fulfillRequest');
  assert.ok(fulfill, 'expected a fulfillRequest');
  assert.equal(fulfill.params.responseCode, 200);
  assert.equal(Buffer.from(fulfill.params.body, 'base64').toString('utf8'), '{"items":[]}');
});

test('HAR notFound abort blocks an unmatched request', async () => {
  const { harEntriesToRules } = await importNetworkInterceptorsModule();
  const rules = harEntriesToRules(SAMPLE_HAR, { notFound: 'abort' });
  const context = await makeController(rules);

  await context.controller.handleRequestPaused(7, {
    requestId: 'r2',
    resourceType: 'XHR',
    request: { url: 'https://api.example.test/unknown', method: 'GET', headers: {} }
  });

  const fail = context.calls.find(call => call.method === 'Fetch.failRequest');
  assert.ok(fail, 'expected a failRequest for the unmatched url');
  assert.equal(fail.params.errorReason, 'BlockedByClient');
});
