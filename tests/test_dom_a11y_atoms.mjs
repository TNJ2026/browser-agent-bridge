// Direct unit tests for the deep-DOM query helpers exported by the shared
// dom-a11y atom. The locator resolver delegates to these, so pinning them here
// gives the extracted logic a focused, single home for coverage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

async function loadAtom({ window = {}, getComputedStyle = () => ({}) } = {}) {
  const source = await readFile(new URL('../extension/content/dom-a11y.js', import.meta.url), 'utf8');
  const context = { window, getComputedStyle, document: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.__browserAgentBridgeDomA11y;
}

// Fake element for the text/visibility predicates.
function pel({ tag = 'div', attrs = {}, rect = { width: 10, height: 10 }, style = {}, props = {}, closest = {} } = {}) {
  return {
    tagName: tag.toUpperCase(),
    hidden: false, disabled: false, readOnly: false, isContentEditable: false,
    checked: false, selected: false, open: false,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, ...rect }),
    closest: selector => closest[selector] || null,
    _style: style,
    ...props
  };
}

const computedStyle = el => ({ visibility: 'visible', display: 'block', opacity: '1', ...(el._style || {}) });

function el(tag, { id = '' } = {}, children = []) {
  return { tagName: String(tag).replace(/^#/, '').toUpperCase(), id, shadowRoot: null, children };
}

function lightDescendants(node) {
  const out = [];
  for (const child of node.children || []) {
    out.push(child);
    out.push(...lightDescendants(child));
  }
  return out;
}

function matchSel(node, selector) {
  if (selector === '*') return true;
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function wire(node) {
  node.querySelectorAll = selector => lightDescendants(node).filter(n => matchSel(n, selector));
  for (const child of node.children || []) wire(child);
  if (node.shadowRoot) wire(node.shadowRoot);
}

// body > [ divA, span(host) #shadow> [ button#save ], divB ]
function makeTree() {
  const btn = el('button', { id: 'save' });
  const shadow = el('#shadow-root', {}, [btn]);
  const host = el('span');
  host.shadowRoot = shadow;
  const divA = el('div');
  const divB = el('div');
  const root = el('body', {}, [divA, host, divB]);
  wire(root);
  return { root, btn, divA, divB, host };
}

test('querySelectorAllDeep matches in the light tree', async () => {
  const atom = await loadAtom();
  const { root, divA, divB } = makeTree();
  // querySelectorAllDeep returns a vm-realm array; compare by element identity.
  const result = atom.querySelectorAllDeep(root, 'div');
  assert.equal(result.length, 2);
  assert.equal(result[0], divA);
  assert.equal(result[1], divB);
});

test('querySelectorAllDeep pierces open shadow roots', async () => {
  const atom = await loadAtom();
  const { root, btn } = makeTree();
  // the button lives inside the host's shadow root, not the light tree
  const result = atom.querySelectorAllDeep(root, 'button');
  assert.equal(result.length, 1);
  assert.equal(result[0], btn);
});

test('querySelectorDeep returns the first match or null', async () => {
  const atom = await loadAtom();
  const { root, divA } = makeTree();
  assert.equal(atom.querySelectorDeep(root, 'div'), divA);
  assert.equal(atom.querySelectorDeep(root, 'p'), null);
});

test('getElementByIdDeep finds an id across shadow boundaries', async () => {
  const atom = await loadAtom({ window: { CSS: { escape: s => s } } });
  const { root, btn } = makeTree();
  assert.equal(atom.getElementByIdDeep(root, 'save'), btn);
  assert.equal(atom.getElementByIdDeep(root, 'missing'), null);
});

test('cssEscape uses CSS.escape when available', async () => {
  const atom = await loadAtom({ window: { CSS: { escape: s => `ESC(${s})` } } });
  assert.equal(atom.cssEscape('a b'), 'ESC(a b)');
});

test('cssEscape falls back to escaping quotes and backslashes', async () => {
  const atom = await loadAtom(); // no window.CSS
  assert.equal(atom.cssEscape('a"b\\c'), 'a\\"b\\\\c');
});

test('matchesText: substring / exact / caseSensitive / regex', async () => {
  const atom = await loadAtom();
  assert.equal(atom.matchesText('Save changes', 'save', {}), true);          // case-insensitive substring
  assert.equal(atom.matchesText('Save', 'save', { exact: true }), true);     // exact trims + lowercases
  assert.equal(atom.matchesText('Save', 'Sav', { exact: true }), false);
  assert.equal(atom.matchesText('Save', 'save', { caseSensitive: true }), false);
  assert.equal(atom.matchesText('Save', '^Sav', { regex: true }), true);
  assert.equal(atom.matchesText('Save', '^sav', { regex: true, caseSensitive: true }), false);
  assert.equal(atom.matchesText('Save', '(', { regex: true }), false);       // invalid regex -> false
});

test('isVisible respects rect, style, hidden and aria-hidden', async () => {
  const atom = await loadAtom({ getComputedStyle: computedStyle });
  assert.equal(atom.isVisible(pel({})), true);
  assert.equal(atom.isVisible(pel({ rect: { width: 0, height: 10 } })), false);
  assert.equal(atom.isVisible(pel({ style: { display: 'none' } })), false);
  assert.equal(atom.isVisible(pel({ style: { opacity: '0' } })), false);
  assert.equal(atom.isVisible(pel({ props: { hidden: true } })), false);
  assert.equal(atom.isVisible(pel({ closest: { '[hidden]': {} } })), false);
  assert.equal(atom.isVisible(pel({ closest: { '[aria-hidden="true"]': {} } })), false);
});

test('isEnabled / matchesDisabled', async () => {
  const atom = await loadAtom();
  assert.equal(atom.isEnabled(pel({})), true);
  assert.equal(atom.isEnabled(pel({ props: { disabled: true } })), false);
  assert.equal(atom.isEnabled(pel({ attrs: { 'aria-disabled': 'true' } })), false);
  assert.equal(atom.isEnabled(pel({ closest: { 'fieldset[disabled]': {} } })), false);
  assert.equal(atom.matchesDisabled(pel({ props: { disabled: true } }), true), true);
  assert.equal(atom.matchesDisabled(pel({}), false), true);
});

test('isTextInputElement / isEditable', async () => {
  const atom = await loadAtom();
  assert.equal(atom.isTextInputElement(pel({ tag: 'input', attrs: { type: 'text' } })), true);
  assert.equal(atom.isTextInputElement(pel({ tag: 'input', attrs: { type: 'checkbox' } })), false);
  assert.equal(atom.isTextInputElement(pel({ tag: 'textarea' })), true);
  assert.equal(atom.isTextInputElement(pel({ tag: 'div' })), false);
  assert.equal(atom.isEditable(pel({ tag: 'input', attrs: { type: 'text' } })), true);
  assert.equal(atom.isEditable(pel({ tag: 'input', attrs: { type: 'text' }, props: { readOnly: true } })), false);
  assert.equal(atom.isEditable(pel({ tag: 'div', props: { isContentEditable: true } })), true);
  assert.equal(atom.isEditable(pel({ tag: 'input', attrs: { type: 'text' }, props: { disabled: true } })), false);
});

test('headingLevel from tag or aria-level', async () => {
  const atom = await loadAtom();
  assert.equal(atom.headingLevel(pel({ tag: 'h2' })), 2);
  assert.equal(atom.headingLevel(pel({ tag: 'div', attrs: { 'aria-level': '3' } })), 3);
  assert.equal(atom.headingLevel(pel({ tag: 'div' })), null);
});

test('ariaBooleanState from native props and aria-* attributes', async () => {
  const atom = await loadAtom();
  assert.equal(atom.ariaBooleanState(pel({ tag: 'input', attrs: { type: 'checkbox' }, props: { checked: true } }), 'checked'), true);
  assert.equal(atom.ariaBooleanState(pel({ tag: 'option', props: { selected: true } }), 'selected'), true);
  assert.equal(atom.ariaBooleanState(pel({ tag: 'details', props: { open: true } }), 'expanded'), true);
  assert.equal(atom.ariaBooleanState(pel({ attrs: { 'aria-pressed': 'true' } }), 'pressed'), true);
  assert.equal(atom.ariaBooleanState(pel({ attrs: { 'aria-expanded': 'false' } }), 'expanded'), false);
  assert.equal(atom.ariaBooleanState(pel({}), 'checked'), null);
});
