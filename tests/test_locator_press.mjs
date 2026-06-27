import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readyResult() {
  return {
    found: true,
    count: 1,
    visibleCount: 1,
    element: { index: 0, tagName: 'input', clickPoint: { x: 5, y: 5 }, rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true },
    actionability: { visible: true, enabled: true, editable: true, receivesEvents: true, selectable: true, stable: true }
  };
}

async function setup() {
  const { createLocatorHandlers } = await importLocatorModule();
  const calls = { press: [], typeText: [], record: [], scripts: [] };
  const handlers = createLocatorHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v, name) => { if (typeof v !== 'string' || !v) throw new Error(`${name} required`); return v; },
    recordAction: async (tabId, action, meta) => { calls.record.push({ action, meta }); },
    attachDebugger: async () => {},
    cdp: async () => ({}),
    captureElementScreenshot: async () => '',
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 }, frameSelector: null }),
    keyboardDispatcher: {
      press: async (tabId, key, opts) => { calls.press.push({ tabId, key, opts }); },
      typeText: async (tabId, text, opts) => { calls.typeText.push({ tabId, text, opts }); }
    },
    sleep,
    defaultTimeoutMs: 50,
    chromeApi: {
      scripting: {
        executeScript: async (opts) => { calls.scripts.push(opts.args?.[0]); return [{ result: readyResult() }]; }
      }
    }
  });
  return { handlers, calls };
}

test('locator.press focuses then dispatches the key', async () => {
  const { handlers, calls } = await setup();
  const res = await handlers.locatorPress({ tabId: 1, selector: 'input', key: 'Enter', stable: false });

  assert.equal(res.ok, true);
  assert.equal(calls.press.length, 1);
  assert.equal(calls.press[0].key, 'Enter');
  assert.equal(calls.press[0].tabId, 1);
  assert.ok(calls.scripts.some(script => script.action === 'focus'), 'expected a focus action before the keypress');
  const waitScript = calls.scripts.find(script => script.action === 'actionability');
  assert.equal(waitScript.wait.kind, 'actionability');
  assert.equal(waitScript.wait.actionKind, 'press');
  assert.equal(calls.record[0].action, 'locator.press');
  assert.equal(calls.record[0].meta.key, 'Enter');
});

test('locator.press requires a key', async () => {
  const { handlers } = await setup();
  await assert.rejects(handlers.locatorPress({ tabId: 1, selector: 'input' }), /key required/);
});

test('locator.pressSequentially focuses then types the text', async () => {
  const { handlers, calls } = await setup();
  const res = await handlers.locatorPressSequentially({ tabId: 1, selector: 'input', text: 'hello', delayMs: 0, stable: false });

  assert.equal(res.ok, true);
  assert.equal(calls.typeText.length, 1);
  assert.equal(calls.typeText[0].text, 'hello');
  assert.ok(calls.scripts.some(script => script.action === 'focus'), 'expected a focus action before typing');
  assert.equal(calls.record[0].action, 'locator.pressSequentially');
  assert.equal(calls.record[0].meta.text, 'hello');
});

test('locator.pressSequentially accepts value as a text alias', async () => {
  const { handlers, calls } = await setup();
  await handlers.locatorPressSequentially({ tabId: 1, selector: 'input', value: 'world', stable: false });
  assert.equal(calls.typeText[0].text, 'world');
});
