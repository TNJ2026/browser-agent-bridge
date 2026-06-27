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
