// The DOM a11y atom is injected into the page MAIN world before each locator
// action. ensureDomA11yAtom caches per tab:frame so it does not re-inject on
// every call, and invalidates the cache on navigation / load / tab close (a
// navigation wipes the MAIN-world atom, so a stale cache would make the resolver
// throw "DOM a11y atom is not loaded"). These tests pin that behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function emitter() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}

async function makeHandlers() {
  const { createLocatorHandlers } = await importLocatorModule();
  const events = { onCommitted: emitter(), onUpdated: emitter(), onRemoved: emitter() };
  const counts = { atomInjects: 0 };
  const handlers = createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => {},
    resolveFrameTarget: async tabId => ({ target: { tabId }, frameId: 0, frame: { frameId: 0 }, frameOffset: null }),
    ensureContentScripts: async () => {},
    domA11ySource: '/* atom source */',
    chromeApi: {
      scripting: {
        async executeScript({ files, args }) {
          // Atom injection: files-based, or the eval-source func (args[0] is a string).
          if (files || (Array.isArray(args) && typeof args[0] === 'string')) {
            counts.atomInjects += 1;
            return [{ result: undefined }];
          }
          // Resolver run: return a canned query result (cache test does not need a DOM).
          return [{ result: { count: 0, visibleCount: 0, elements: [] } }];
        }
      },
      webNavigation: { onCommitted: events.onCommitted },
      tabs: { onUpdated: events.onUpdated, onRemoved: events.onRemoved }
    }
  });
  return { handlers, events, counts };
}

const query = (handlers, tabId = 1) => handlers.locatorCount({ tabId, selector: 'button' });

test('atom injected once per tab/frame, then served from cache', async () => {
  const { handlers, counts } = await makeHandlers();
  await query(handlers);
  await query(handlers);
  await query(handlers);
  assert.equal(counts.atomInjects, 1);
});

test('navigation (onCommitted) invalidates the atom cache', async () => {
  const { handlers, events, counts } = await makeHandlers();
  await query(handlers);
  assert.equal(counts.atomInjects, 1);
  events.onCommitted.emit({ tabId: 1, frameId: 0 }); // main-frame navigation wipes MAIN-world atom
  await query(handlers);
  assert.equal(counts.atomInjects, 2);
});

test('a loading update (onUpdated) invalidates the cache', async () => {
  const { handlers, events, counts } = await makeHandlers();
  await query(handlers);
  events.onUpdated.emit(1, { status: 'loading' });
  await query(handlers);
  assert.equal(counts.atomInjects, 2);
});

test('tab close (onRemoved) drops the cache entry (no leak)', async () => {
  const { handlers, events, counts } = await makeHandlers();
  await query(handlers);
  events.onRemoved.emit(1);
  await query(handlers); // tab id reused -> must re-inject since cache was cleared
  assert.equal(counts.atomInjects, 2);
});

test('cache is keyed per tab (other tabs do not share the entry)', async () => {
  const { handlers, counts } = await makeHandlers();
  await query(handlers, 1);
  await query(handlers, 2);
  assert.equal(counts.atomInjects, 2); // each tab injected once
});
