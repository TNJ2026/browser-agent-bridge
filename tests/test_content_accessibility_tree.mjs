import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

class FakeElement {
  constructor(tag, { attrs = {}, text = '', value = '', children = [] } = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = attrs.id || '';
    this._attrs = attrs;
    this.innerText = text;
    this.textContent = text;
    this.value = value;
    this.children = children;
    this.parentElement = null;
    this.ownerDocument = null;
    for (const child of children) child.parentElement = this;
  }

  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() { return nextSibling(this); }
  get nextElementSibling() { return nextSibling(this); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 }; }
  getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; }
  hasAttribute(name) { return name in this._attrs; }
  querySelector(selector) { return findDescendant(this, el => matchesSelectorList(el, selector)); }
  querySelectorAll(selector) { return allDescendants(this).filter(el => matchesSelectorList(el, selector)); }
  matches(selector) { return matchesSelectorList(this, selector); }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSelectorList(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}

class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {}
class FakeAnchor extends FakeElement {}

function nextSibling(el) {
  const siblings = el.parentElement?.children || [];
  const index = siblings.indexOf(el);
  return index >= 0 ? siblings[index + 1] || null : null;
}

function allDescendants(root) {
  const out = [];
  for (const child of root.children || []) {
    out.push(child);
    out.push(...allDescendants(child));
  }
  return out;
}

function findDescendant(root, predicate) {
  return allDescendants(root).find(predicate) || null;
}

function matchesSelectorList(el, selector) {
  return selector.split(',').some(part => matchesSelector(el, part.trim()));
}

function matchesSelector(el, selector) {
  const tag = el.tagName.toLowerCase();
  if (selector === '*') return true;
  if (selector === 'label') return tag === 'label';
  if (selector === ':scope > caption') return tag === 'caption' && el.parentElement?.tagName?.toLowerCase() === 'table';
  const attrMatch = selector.match(/^([a-z]*)?\[([^=\]]+)(?:="([^"]*)")?\]$/i);
  if (attrMatch) {
    const [, wantedTag, attr, value] = attrMatch;
    if (wantedTag && tag !== wantedTag.toLowerCase()) return false;
    if (!el.hasAttribute(attr)) return false;
    return value === undefined || el.getAttribute(attr) === value;
  }
  return tag === selector.toLowerCase();
}

function assignDocument(el, doc) {
  el.ownerDocument = doc;
  for (const child of el.children || []) assignDocument(child, doc);
}

function makeDocument(bodyChildren) {
  const body = new FakeElement('body', { children: bodyChildren });
  const all = [body, ...allDescendants(body)];
  const doc = {
    body,
    documentElement: body,
    getElementById(id) { return all.find(el => el.id === id) || null; },
    querySelector(selector) { return all.find(el => matchesSelectorList(el, selector)) || null; }
  };
  assignDocument(body, doc);
  return doc;
}

async function runAccessibilityTree(document) {
  const source = await readFile(new URL('../extension/content/accessibility-tree.js', import.meta.url), 'utf8');
  let listener = null;
  const context = {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document,
    location: { href: 'https://example.test/' },
    window: {
      CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    HTMLAnchorElement: FakeAnchor,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  let response = null;
  listener({ type: 'GET_ACCESSIBILITY_TREE', maxNodes: 100 }, {}, value => { response = value; });
  assert.equal(response.ok, true, response.error);
  return response.tree;
}

test('content accessibility tree uses locator-aligned accessible names and implicit roles', async () => {
  const title = new FakeElement('h2', { attrs: { id: 'title' }, text: 'Billing' });
  const suffix = new FakeElement('span', { attrs: { id: 'suffix' }, text: 'Save' });
  const labelledButton = new FakeElement('button', { attrs: { 'aria-labelledby': 'title suffix' }, text: 'Ignored text' });
  const emailLabel = new FakeElement('label', { attrs: { for: 'email' }, text: 'Email address' });
  const email = new FakeInput('input', { attrs: { id: 'email', type: 'text', placeholder: 'Fallback' } });
  const wrapped = new FakeInput('input', { attrs: { type: 'search' } });
  const wrappingLabel = new FakeElement('label', { text: 'Search query', children: [wrapped] });
  const submit = new FakeInput('input', { attrs: { type: 'submit' } });
  const checkbox = new FakeInput('input', { attrs: { type: 'checkbox', 'aria-label': 'Accept terms' } });
  const logo = new FakeElement('img', { attrs: { alt: 'Company logo' } });
  const document = makeDocument([title, suffix, labelledButton, emailLabel, email, wrappingLabel, submit, checkbox, logo]);

  const tree = await runAccessibilityTree(document);
  const byName = new Map(tree.nodes.map(node => [node.name, node]));
  const nodeDump = JSON.stringify(tree.nodes);

  for (const name of ['Billing Save', 'Email address', 'Search query', 'Submit', 'Accept terms', 'Company logo']) {
    assert.ok(byName.has(name), `${name} missing from ${nodeDump}`);
  }
  assert.equal(byName.get('Billing Save').role, 'button');
  assert.equal(byName.get('Email address').role, 'textbox');
  assert.equal(byName.get('Search query').role, 'searchbox');
  assert.equal(byName.get('Submit').role, 'button');
  assert.equal(byName.get('Accept terms').role, 'checkbox');
  assert.equal(byName.get('Company logo').role, 'img');
});
