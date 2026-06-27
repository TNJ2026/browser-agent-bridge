// Direct unit tests for the deep-DOM query helpers exported by the shared
// dom-a11y atom. The locator resolver delegates to these, so pinning them here
// gives the extracted logic a focused, single home for coverage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

async function loadAtom(window = {}) {
  const source = await readFile(new URL('../extension/content/dom-a11y.js', import.meta.url), 'utf8');
  const context = { window };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.__browserAgentBridgeDomA11y;
}

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
  const atom = await loadAtom({ CSS: { escape: s => s } });
  const { root, btn } = makeTree();
  assert.equal(atom.getElementByIdDeep(root, 'save'), btn);
  assert.equal(atom.getElementByIdDeep(root, 'missing'), null);
});

test('cssEscape uses CSS.escape when available', async () => {
  const atom = await loadAtom({ CSS: { escape: s => `ESC(${s})` } });
  assert.equal(atom.cssEscape('a b'), 'ESC(a b)');
});

test('cssEscape falls back to escaping quotes and backslashes', async () => {
  const atom = await loadAtom({}); // no window.CSS
  assert.equal(atom.cssEscape('a"b\\c'), 'a\\"b\\\\c');
});
