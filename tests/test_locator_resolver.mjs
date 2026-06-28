// Runs the REAL shipped in-page locator resolver func (extension/sw/locator.js)
// inside Node against a fake DOM, via the same fake-executeScript injection
// pattern proven in tests/test_frames_resolver.mjs. createLocatorHandlers takes
// chromeApi as an injectable dep, and runLocatorScript calls
// chromeApi.scripting.executeScript({ func, args }). We stub executeScript to run
// func(...args) against a stubbed globalThis.document, so the assertions exercise
// the actual shipped matchesLocator/findLocatorMatches logic — not a copy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function loadDomA11ySource() {
  return readFile(new URL('../extension/content/dom-a11y.js', import.meta.url), 'utf8');
}

const VISIBLE_RECT = { x: 0, y: 0, width: 10, height: 10 };
const HIDDEN_RECT = { x: 0, y: 0, width: 0, height: 0 };

function makeEl({ tag, text = '', attrs = {}, rect = VISIBLE_RECT, props = {}, children = [] }) {
  const el = {
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    shadowRoot: undefined,
    hidden: false,
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    multiple: false,
    innerText: text,
    textContent: text,
    children,
    _attrs: attrs,
    _rect: rect,
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name) { return name in attrs; },
    closest() { return null; },
    getBoundingClientRect() { return rect; },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel === '*') return children;
      const tokens = sel.split(',').map(s => s.trim().toLowerCase());
      return children.filter(c => tokens.includes(c.tagName.toLowerCase()));
    }
  };
  return Object.assign(el, props);
}

function buildDom() {
  const els = {
    btnSave: makeEl({ tag: 'button', text: 'Save' }),
    btnCancel: makeEl({ tag: 'button', text: 'Cancel' }),
    btnOff: makeEl({ tag: 'button', text: 'Off', props: { disabled: true } }),
    hiddenBtn: makeEl({ tag: 'button', text: 'Hidden', rect: HIDDEN_RECT }),
    link: makeEl({ tag: 'a', text: 'Home', attrs: { href: '/' } }),
    cbOn: makeEl({ tag: 'input', attrs: { type: 'checkbox' }, props: { checked: true } }),
    cbOff: makeEl({ tag: 'input', attrs: { type: 'checkbox' }, props: { checked: false } }),
    h2: makeEl({ tag: 'h2', text: 'Title' }),
    email: makeEl({ tag: 'input', attrs: { type: 'text', 'aria-label': 'Email' } }),
    search: makeEl({ tag: 'input', attrs: { type: 'search', placeholder: 'Search' } }),
    tagged: makeEl({ tag: 'div', text: 'Note', attrs: { 'data-test': 'x', role: 'note' } })
  };
  const all = Object.values(els);
  const doc = {
    querySelector() { return null; },
    getElementById() { return null; },
    querySelectorAll(sel) {
      if (sel === '*') return all;
      const tokens = sel.split(',').map(s => s.trim().toLowerCase());
      return all.filter(el => tokens.includes(el.tagName.toLowerCase()));
    }
  };
  return { els, all, doc };
}

async function makeHandlers(doc) {
  const chromeApi = {
    scripting: {
      async executeScript({ func, args }) {
        const prev = { d: globalThis.document, g: globalThis.getComputedStyle, w: globalThis.window };
        globalThis.document = doc;
        globalThis.getComputedStyle = el => el._style || { visibility: 'visible', display: 'block', opacity: '1' };
        globalThis.window = { innerWidth: 1024, innerHeight: 768 };
        try {
          return [{ result: func(...args) }];
        } finally {
          globalThis.document = prev.d;
          globalThis.getComputedStyle = prev.g;
          globalThis.window = prev.w;
        }
      }
    }
  };
  return createLocatorHandlersFor(chromeApi);
}

let createLocatorHandlersPromise;
async function getCreateLocatorHandlers() {
  createLocatorHandlersPromise ||= importLocatorModule().then(module => module.createLocatorHandlers);
  return createLocatorHandlersPromise;
}
let domA11ySource;
async function createLocatorHandlersFor(chromeApi) {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  domA11ySource ||= await loadDomA11ySource();
  return createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    resolveFrameTarget: async tabId => ({ target: { tabId }, frame: { url: 'about:test' } }),
    chromeApi,
    domA11ySource
  });
}

async function count(doc, params) {
  const h = await makeHandlers(doc);
  const res = await h.locatorCount({ tabId: 1, ...params });
  return res;
}

test('module loads', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  assert.equal(typeof createLocatorHandlers, 'function');
});

test('role: button counts visible buttons only (hidden excluded by role gate)', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', role: 'button' })).count, 3);
});

test('role: link / heading inference', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', role: 'link' })).count, 1);
  assert.equal((await count(doc, { selector: '*', role: 'heading' })).count, 1);
  assert.equal((await count(doc, { selector: '*', role: 'checkbox' })).count, 2);
});

test('heading level filter', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', role: 'heading', level: 2 })).count, 1);
  assert.equal((await count(doc, { selector: '*', role: 'heading', level: 3 })).count, 0);
});

test('checked state distinguishes checkboxes', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', checked: true })).count, 1);
  assert.equal((await count(doc, { selector: '*', checked: false })).count, 1);
});

test('disabled state', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', role: 'button', disabled: true })).count, 1);
});

test('hasText substring vs exact', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', hasText: 'Save' })).count, 1);
  assert.equal((await count(doc, { selector: 'button', hasText: 'Of', exact: true })).count, 0);
  assert.equal((await count(doc, { selector: 'button', hasText: 'Off', exact: true })).count, 1);
});

test('hasText regex', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: 'button', hasText: '^Off$', regex: true })).count, 1);
  assert.equal((await count(doc, { selector: 'button', hasText: 'sav.', regex: true })).count, 1); // case-insensitive
  assert.equal((await count(doc, { selector: 'button', hasText: 'sav.', regex: true, caseSensitive: true })).count, 0);
});

test('hasNotText excludes matches', async () => {
  const { doc } = buildDom();
  // selector-based (no visibility gate): Save, Off, Hidden survive; Cancel excluded
  assert.equal((await count(doc, { selector: 'button', hasNotText: 'Cancel' })).count, 3);
});

test('visible filter', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', visible: false })).count, 1); // hiddenBtn (rect 0)
  assert.equal((await count(doc, { selector: 'button', visible: true })).count, 3);
});

test('accessible name match', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', name: 'Email' })).count, 1);
  assert.equal((await count(doc, { selector: '*', name: 'Nonexistent' })).count, 0);
});

test('label resolves form control via aria-label', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { label: 'Email' })).count, 1);
});

test('placeholder filter', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', placeholder: 'Search' })).count, 1);
});

test('hasAttribute / hasNotAttribute', async () => {
  const { doc } = buildDom();
  assert.equal((await count(doc, { selector: '*', hasAttribute: { name: 'data-test' } })).count, 1);
  assert.equal((await count(doc, { selector: '*', hasAttribute: { name: 'data-test', value: 'x' } })).count, 1);
  assert.equal((await count(doc, { selector: '*', hasAttribute: { name: 'data-test', value: 'y' } })).count, 0);
  assert.equal((await count(doc, { selector: 'button', hasNotAttribute: { name: 'data-test' } })).count, 4);
});

test('visibleCount reported alongside count', async () => {
  const { doc } = buildDom();
  const res = await count(doc, { selector: 'button' });
  assert.equal(res.count, 4);       // 4 button tags
  assert.equal(res.visibleCount, 3); // hiddenBtn invisible
});

test('locator.clickRef dispatches CDP click at a snapshot ref target', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const cdpCalls = [];
  const messages = [];
  const handlers = createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: value => {
      if (typeof value !== 'string' || !value) throw new Error('expected string');
    },
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async (tabId, method, params) => { cdpCalls.push({ tabId, method, params }); },
    resolveFrameTarget: async (tabId, params) => ({
      target: { tabId, frameIds: [params.frameId] },
      frameId: params.frameId,
      frame: { frameId: params.frameId, url: 'about:test' },
      frameOffset: { x: 10, y: 20 }
    }),
    ensureContentScripts: async () => {},
    chromeApi: {
      tabs: {
        async sendMessage(tabId, message, options) {
          messages.push({ tabId, message, options });
          return {
            ok: true,
            target: {
              ref: 'ref_1',
              snapshotId: 'snap_1',
              frameId: 7,
              element: {
                ref: 'ref_1',
                tagName: 'button',
                accessibleName: 'Save',
                clickPoint: { x: 5, y: 6 },
                rect: { x: 0, y: 0, width: 10, height: 12 }
              },
              actionability: { actionable: true, visible: true, enabled: true, receivesEvents: true, reasons: [] }
            }
          };
        }
      }
    }
  });

  const result = await handlers.locatorClickRef({ tabId: 1, frameId: 7, ref: 'ref_1', snapshotId: 'snap_1' });

  assert.equal(result.ok, true);
  assert.equal(result.element.accessibleName, 'Save');
  assert.deepEqual(messages[0], {
    tabId: 1,
    message: { type: 'GET_ACCESSIBILITY_REF_TARGET', ref: 'ref_1', snapshotId: 'snap_1' },
    options: { frameId: 7 }
  });
  assert.deepEqual(cdpCalls.map(call => call.params), [
    { type: 'mouseMoved', x: 15, y: 26, button: 'none' },
    { type: 'mousePressed', x: 15, y: 26, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 15, y: 26, button: 'left', clickCount: 1 }
  ]);
});

test('locator.clickRef rejects non-actionable refs with structured diagnostics', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const handlers = createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => {},
    resolveFrameTarget: async () => ({ frameId: 0, frame: { frameId: 0, url: 'about:test' }, frameOffset: null }),
    ensureContentScripts: async () => {},
    chromeApi: {
      tabs: {
        async sendMessage() {
          return {
            ok: true,
            target: {
              ref: 'ref_2',
              snapshotId: 'snap_1',
              element: { ref: 'ref_2', tagName: 'button', clickPoint: { x: 1, y: 2 } },
              actionability: { actionable: false, visible: true, enabled: false, receivesEvents: true, reasons: ['disabled'] }
            }
          };
        }
      }
    }
  });

  await assert.rejects(
    () => handlers.locatorClickRef({ tabId: 1, ref: 'ref_2', snapshotId: 'snap_1' }),
    error => {
      assert.equal(error.code, 'LOCATOR_REF_NOT_ACTIONABLE');
      assert.equal(error.diagnostic.ref, 'ref_2');
      assert.deepEqual(error.diagnostic.reasons, ['disabled']);
      return true;
    }
  );
});

function makeRefHandlers(createLocatorHandlers, { cdpCalls = [], keyPresses = [], messages = [], actionable = true }) {
  return createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: value => { if (typeof value !== 'string' || !value) throw new Error('expected string'); },
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async (tabId, method, params) => { cdpCalls.push({ method, params }); },
    resolveFrameTarget: async (tabId, params) => ({
      target: { tabId, frameIds: [params.frameId] },
      frameId: params.frameId,
      frame: { frameId: params.frameId, url: 'about:test' },
      frameOffset: null
    }),
    ensureContentScripts: async () => {},
    keyboardDispatcher: { async press(tabId, key) { keyPresses.push(key); } },
    chromeApi: {
      tabs: {
        async sendMessage(tabId, message) {
          messages.push(message);
          return {
            ok: true,
            target: {
              ref: 'ref_1', snapshotId: 'snap_1', frameId: 0,
              element: { ref: 'ref_1', tagName: 'input', accessibleName: 'Email', clickPoint: { x: 5, y: 6 } },
              actionability: { actionable, visible: actionable, enabled: actionable, receivesEvents: actionable, reasons: actionable ? [] : ['disabled'] }
            }
          };
        }
      }
    }
  });
}

test('locator.fillRef focuses+selects in-page then inserts the text (no synthetic click)', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const cdpCalls = [];
  const messages = [];
  const handlers = makeRefHandlers(createLocatorHandlers, { cdpCalls, messages });
  const result = await handlers.locatorFillRef({ tabId: 1, frameId: 0, ref: 'ref_1', snapshotId: 'snap_1', text: 'hello' });
  assert.equal(result.ok, true);
  const focusMsg = messages.find(m => m.type === 'FOCUS_ACCESSIBILITY_REF');
  assert.equal(focusMsg.select, true); // select existing content so input replaces it
  assert.deepEqual(cdpCalls.find(c => c.method === 'Input.insertText').params, { text: 'hello' });
  assert.equal(cdpCalls.some(c => c.params.type === 'mousePressed'), false);
});

test('locator.fillRef replace:false focuses without selecting', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const messages = [];
  const handlers = makeRefHandlers(createLocatorHandlers, { messages });
  await handlers.locatorFillRef({ tabId: 1, frameId: 0, ref: 'ref_1', snapshotId: 'snap_1', text: 'x', replace: false });
  assert.equal(messages.find(m => m.type === 'FOCUS_ACCESSIBILITY_REF').select, false);
});

test('locator.pressRef focuses (no click) then presses the key', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const cdpCalls = [];
  const keyPresses = [];
  const messages = [];
  const handlers = makeRefHandlers(createLocatorHandlers, { cdpCalls, keyPresses, messages });
  const result = await handlers.locatorPressRef({ tabId: 1, frameId: 0, ref: 'ref_1', snapshotId: 'snap_1', key: 'Enter' });
  assert.equal(result.ok, true);
  assert.equal(messages.find(m => m.type === 'FOCUS_ACCESSIBILITY_REF').select, false);
  assert.deepEqual(keyPresses, ['Enter']);
  assert.equal(cdpCalls.some(c => c.params.type === 'mousePressed'), false); // no activating click
});

test('locator.hoverRef moves the mouse to the ref without pressing', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const cdpCalls = [];
  const handlers = makeRefHandlers(createLocatorHandlers, { cdpCalls });
  const result = await handlers.locatorHoverRef({ tabId: 1, frameId: 0, ref: 'ref_1', snapshotId: 'snap_1' });
  assert.equal(result.ok, true);
  assert.deepEqual(cdpCalls, [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 5, y: 6 } }]);
});

test('locator.fillRef rejects a non-actionable ref', async () => {
  const createLocatorHandlers = await getCreateLocatorHandlers();
  const handlers = makeRefHandlers(createLocatorHandlers, { actionable: false });
  await assert.rejects(
    handlers.locatorFillRef({ tabId: 1, frameId: 0, ref: 'ref_1', text: 'x' }),
    /not actionable for locator\.fillRef/
  );
});
