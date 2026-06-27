// C2: locator.locator() parent scoping (`within`). Runs the REAL shipped in-page
// resolver func against a fake DOM via an injected scripting.executeScript (the
// pattern from test_frames_resolver.mjs / test_locator_resolver.mjs), so the
// asserts exercise the actual findLocatorMatches/normalizeLocatorParams logic.
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

const RECT = { x: 0, y: 0, width: 10, height: 10 };

function makeEl({ tag, text = '', attrs = {}, children = [] }) {
  return {
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    shadowRoot: undefined,
    hidden: false, disabled: false, readOnly: false, isContentEditable: false, multiple: false,
    innerText: text, textContent: text, children,
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name) { return name in attrs; },
    closest() { return null; },
    getBoundingClientRect() { return RECT; },
    querySelector() { return null; },
    // shallow (direct children) — sufficient because every `within` hop in these
    // tests queries a direct parent->child relationship.
    querySelectorAll(sel) {
      if (sel === '*') return children;
      const tokens = sel.split(',').map(s => s.trim().toLowerCase());
      return children.filter(c => tokens.includes(c.tagName.toLowerCase()));
    }
  };
}

function buildDom() {
  const saveA = makeEl({ tag: 'button', text: 'Save' });
  const delA = makeEl({ tag: 'button', text: 'Delete' });
  const saveB = makeEl({ tag: 'button', text: 'Save' });
  const sectionA = makeEl({ tag: 'section', attrs: { 'data-test': 'a' }, children: [saveA, delA] });
  const sectionB = makeEl({ tag: 'section', attrs: { 'data-test': 'b' }, children: [saveB] });
  const region = makeEl({ tag: 'div', attrs: { 'data-region': 'x' }, children: [sectionA] });
  const topSave = makeEl({ tag: 'button', text: 'Save' });
  const all = [region, sectionA, sectionB, topSave, saveA, delA, saveB];
  const doc = {
    querySelector() { return null; },
    getElementById() { return null; },
    querySelectorAll(sel) {
      if (sel === '*') return all;
      const tokens = sel.split(',').map(s => s.trim().toLowerCase());
      return all.filter(el => tokens.includes(el.tagName.toLowerCase()));
    }
  };
  return { doc, els: { saveA, delA, saveB, sectionA, sectionB, region, topSave } };
}

let createLocatorHandlers;
let domA11ySource;
async function count(doc, params) {
  createLocatorHandlers ||= (await importLocatorModule()).createLocatorHandlers;
  domA11ySource ||= await loadDomA11ySource();
  const chromeApi = {
    scripting: {
      async executeScript({ func, args }) {
        const prev = { d: globalThis.document, g: globalThis.getComputedStyle, w: globalThis.window };
        globalThis.document = doc;
        globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
        globalThis.window = { innerWidth: 1024, innerHeight: 768 };
        try { return [{ result: func(...args) }]; }
        finally { globalThis.document = prev.d; globalThis.getComputedStyle = prev.g; globalThis.window = prev.w; }
      }
    }
  };
  const h = createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    resolveFrameTarget: async tabId => ({ target: { tabId }, frame: { url: 'about:test' } }),
    chromeApi,
    domA11ySource
  });
  return (await h.locatorCount({ tabId: 1, ...params })).count;
}

test('baseline (no within) matches every Save button page-wide', async () => {
  const { doc } = buildDom();
  assert.equal(await count(doc, { selector: 'button', hasText: 'Save' }), 3);
});

test('within narrows to Saves inside any matching parent', async () => {
  const { doc } = buildDom();
  // sections A and B each have a Save; the top-level Save is excluded.
  assert.equal(await count(doc, { selector: 'button', hasText: 'Save', within: { selector: 'section' } }), 2);
});

test('within with a discriminating parent filter scopes to one subtree', async () => {
  const { doc } = buildDom();
  assert.equal(await count(doc, {
    selector: 'button', hasText: 'Save',
    within: { selector: 'section', hasAttribute: { name: 'data-test', value: 'a' } }
  }), 1);
});

test('within yields nothing when no parent matches', async () => {
  const { doc } = buildDom();
  assert.equal(await count(doc, {
    selector: 'button', hasText: 'Save',
    within: { selector: 'section', hasAttribute: { name: 'data-test', value: 'z' } }
  }), 0);
});

test('child filters still apply within the scope', async () => {
  const { doc } = buildDom();
  // Delete exists only in section A; scoping to section B finds none.
  assert.equal(await count(doc, { selector: 'button', hasText: 'Delete', within: { selector: 'section' } }), 1);
  assert.equal(await count(doc, {
    selector: 'button', hasText: 'Delete',
    within: { selector: 'section', hasAttribute: { name: 'data-test', value: 'b' } }
  }), 0);
});

test('nested within (region > section > button) chains scopes', async () => {
  const { doc } = buildDom();
  // region x contains only section A (which has the Save). Two-level parent chain.
  assert.equal(await count(doc, {
    selector: 'button', hasText: 'Save',
    within: { selector: 'section', within: { selector: 'div' } }
  }), 1);
});

test('within accepts the nested locator form too', async () => {
  const { doc } = buildDom();
  assert.equal(await count(doc, {
    locator: { selector: 'button', hasText: 'Save', within: { selector: 'section' } }
  }), 2);
});

test('within parent must carry its own matcher (else rejected)', async () => {
  const { doc } = buildDom();
  await assert.rejects(
    () => count(doc, { selector: 'button', within: { hasText: '' } }),
    /locator requires one of/
  );
});
