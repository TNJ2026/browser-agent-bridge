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
    cdp: async (tabId, method, params) => { calls.push({ method, params }); return method === 'Page.printToPDF' ? { data: 'JVBERi0xLjQK' } : {}; },
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: { tabs: { get: async () => ({ id: 1 }) } }
  });
  return { handlers, calls };
}

test('page.pdf returns a base64 PDF data URL', async () => {
  const { handlers, calls } = await makeHandlers();
  const res = await handlers.pagePdf({ tabId: 1 });
  assert.equal(res.mimeType, 'application/pdf');
  assert.equal(res.dataUrl, 'data:application/pdf;base64,JVBERi0xLjQK');
  const c = calls.find(call => call.method === 'Page.printToPDF');
  assert.equal(c.params.transferMode, 'ReturnAsBase64');
  assert.equal(c.params.printBackground, true); // default on
  assert.equal(c.params.landscape, false);
});

test('page.pdf forwards layout options and disables background on request', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pagePdf({ tabId: 1, landscape: true, printBackground: false, scale: 0.8, paperWidth: 8.5, paperHeight: 11, pageRanges: '1-2' });
  const c = calls.find(call => call.method === 'Page.printToPDF');
  assert.equal(c.params.landscape, true);
  assert.equal(c.params.printBackground, false);
  assert.equal(c.params.scale, 0.8);
  assert.equal(c.params.paperWidth, 8.5);
  assert.equal(c.params.paperHeight, 11);
  assert.equal(c.params.pageRanges, '1-2');
});
