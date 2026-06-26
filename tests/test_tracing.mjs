import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importTracingModule() {
  const source = await readFile(new URL('../extension/sw/tracing.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeChromeApi() {
  const store = {};
  return {
    store,
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => { Object.assign(store, obj); }
      }
    },
    downloads: { download: async () => 1 }
  };
}

async function makeHandlers({ captureFailureContext } = {}) {
  const { createTraceHandlers } = await importTracingModule();
  let uuid = 0;
  let clock = 1_000;
  return createTraceHandlers({
    assertString: (v, name) => {
      if (typeof v !== 'string' || !v) throw new Error(`${name} required`);
      return v;
    },
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    chromeApi: makeChromeApi(),
    now: () => (clock += 5),
    cryptoApi: { randomUUID: () => `trace-${uuid++}` },
    captureFailureContext
  });
}

function pageContext() {
  return {
    tabId: 1,
    url: 'https://example.com/checkout',
    title: 'Checkout',
    a11y: { headings: 2, links: 9, buttons: 3, inputs: 4 },
    text: 'Secret order details for the customer'
  };
}

function strictError() {
  const error = new Error('Strict mode violation: locator resolved to 3 elements');
  error.name = 'LocatorStrictModeViolation';
  error.code = 'LOCATOR_STRICT_MODE_VIOLATION';
  error.diagnostic = {
    type: 'LocatorStrictModeViolation',
    count: 3,
    candidates: [{ index: 0, id: 'a' }, { index: 1, id: 'b' }, { index: 2, id: 'c' }]
  };
  return error;
}

test('trace records the structured error code and diagnostic', async () => {
  const handlers = await makeHandlers();
  await handlers.traceStart({ name: 'checkout' });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: { selector: 'button' } }, strictError());

  const exported = await handlers.traceExport();
  const event = exported.trace.events[0];
  assert.equal(event.status, 'error');
  assert.equal(event.errorData.code, 'LOCATOR_STRICT_MODE_VIOLATION');
  assert.equal(event.errorData.diagnostic.count, 3);
});

test('traceStatus reports an errorCount', async () => {
  const handlers = await makeHandlers();
  await handlers.traceStart({ name: 'checkout' });
  const okToken = await handlers.traceRpcStart({ method: 'page.readText', id: 'r0' });
  await handlers.traceRpcEnd(okToken, { method: 'page.readText', params: {} }, { text: 'hi' });
  const failToken = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(failToken, { method: 'locator.click', params: {} }, strictError());

  const status = await handlers.traceStatus();
  assert.equal(status.traces.length, 1);
  assert.equal(status.traces[0].eventCount, 2);
  assert.equal(status.traces[0].errorCount, 1);
});

test('HTML export surfaces a Failures section with the error code', async () => {
  const handlers = await makeHandlers();
  await handlers.traceStart({ name: 'checkout' });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: {} }, strictError());

  const { html } = await handlers.traceExportHtml();
  assert.ok(html.includes('Failures (1)'), 'expected a failures section');
  assert.ok(html.includes('LOCATOR_STRICT_MODE_VIOLATION'), 'expected the error code in the html');
  assert.ok(html.includes('locator.click'), 'expected the failing method in the html');
});

test('HTML export omits the Failures section when there are no errors', async () => {
  const handlers = await makeHandlers();
  await handlers.traceStart({ name: 'happy' });
  const token = await handlers.traceRpcStart({ method: 'page.readText', id: 'r0' });
  await handlers.traceRpcEnd(token, { method: 'page.readText', params: {} }, { text: 'hi' });

  const { html } = await handlers.traceExportHtml();
  assert.ok(!html.includes('Failures ('), 'expected no failures section');
});

test('failure context is captured and kept (includeText:true)', async () => {
  const handlers = await makeHandlers({ captureFailureContext: async () => pageContext() });
  await handlers.traceStart({ name: 'checkout', includeText: true });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: { tabId: 1 } }, strictError());

  const event = (await handlers.traceExport()).trace.events[0];
  assert.equal(event.context.url, 'https://example.com/checkout');
  assert.equal(event.context.a11y.headings, 2);
  assert.equal(event.context.text, 'Secret order details for the customer');
});

test('failure context text is redacted when includeText is false', async () => {
  const handlers = await makeHandlers({ captureFailureContext: async () => pageContext() });
  await handlers.traceStart({ name: 'checkout' });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: { tabId: 1 } }, strictError());

  const event = (await handlers.traceExport()).trace.events[0];
  // url/a11y survive; only the free-text preview is redacted.
  assert.equal(event.context.url, 'https://example.com/checkout');
  assert.equal(event.context.a11y.links, 9);
  assert.equal(event.context.text.redacted, true);
  assert.equal(typeof event.context.text.length, 'number');
});

test('a capture failure never masks the original error', async () => {
  const handlers = await makeHandlers({ captureFailureContext: async () => { throw new Error('capture boom'); } });
  await handlers.traceStart({ name: 'checkout', includeText: true });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: { tabId: 1 } }, strictError());

  const event = (await handlers.traceExport()).trace.events[0];
  assert.equal(event.errorData.code, 'LOCATOR_STRICT_MODE_VIOLATION');
  assert.equal(event.context, undefined);
});

test('HTML failures section shows the captured url', async () => {
  const handlers = await makeHandlers({ captureFailureContext: async () => pageContext() });
  await handlers.traceStart({ name: 'checkout', includeText: true });
  const token = await handlers.traceRpcStart({ method: 'locator.click', id: 'r1' });
  await handlers.traceRpcError(token, { method: 'locator.click', params: { tabId: 1 } }, strictError());

  const { html } = await handlers.traceExportHtml();
  assert.ok(html.includes('at https://example.com/checkout'), 'expected the captured url in failures');
});
