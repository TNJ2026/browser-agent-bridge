import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

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
  contains(node) { return this === node || allDescendants(this).includes(node); }
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
  if (selector.startsWith('#')) return el.id === selector.slice(1);
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
    querySelector(selector) { return all.find(el => matchesSelectorList(el, selector)) || null; },
    querySelectorAll(selector) { return all.filter(el => matchesSelectorList(el, selector)); }
  };
  assignDocument(body, doc);
  return doc;
}

async function runAccessibilitySession(document, message = {}) {
  const a11ySource = await readFile(new URL('../extension/content/dom-a11y.js', import.meta.url), 'utf8');
  const treeSource = await readFile(new URL('../extension/content/accessibility-tree.js', import.meta.url), 'utf8');
  let listener = null;
  const context = {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document,
    location: { href: 'https://example.test/' },
    window: {
      CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Event: class { constructor(type) { this.type = type; } },
    HTMLAnchorElement: FakeAnchor,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(a11ySource, context);
  vm.runInContext(treeSource, context);
  let response = null;
  listener({ type: 'GET_ACCESSIBILITY_TREE', maxNodes: 100, snapshotId: 'snap_test', frameId: 0, ...message }, {}, value => { response = value; });
  assert.equal(response.ok, true, response.error);
  return {
    tree: response.tree,
    send(message) {
      let sent = null;
      listener(message, {}, value => { sent = value; });
      return sent;
    }
  };
}

async function runAccessibilityTree(document) {
  return (await runAccessibilitySession(document)).tree;
}

async function locatorCount(document, params) {
  const { createLocatorHandlers } = await importLocatorModule();
  const domA11ySource = await readFile(new URL('../extension/content/dom-a11y.js', import.meta.url), 'utf8');
  const chromeApi = {
    scripting: {
      async executeScript({ func, args }) {
        const prev = { d: globalThis.document, g: globalThis.getComputedStyle, w: globalThis.window };
        globalThis.document = document;
        globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto' });
        globalThis.window = { innerWidth: 1024, innerHeight: 768, CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') } };
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
  const handlers = createLocatorHandlers({
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    resolveFrameTarget: async tabId => ({ target: { tabId }, frame: { url: 'about:test' } }),
    chromeApi,
    domA11ySource
  });
  return (await handlers.locatorCount({ tabId: 1, ...params })).count;
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
  assert.equal(await locatorCount(document, { selector: 'img' }), 1);
  assert.equal(await locatorCount(document, { selector: 'img', name: 'Company logo' }), 1);

  for (const [name, role] of [
    ['Billing Save', 'button'],
    ['Email address', 'textbox'],
    ['Search query', 'searchbox'],
    ['Submit', 'button'],
    ['Accept terms', 'checkbox']
  ]) {
    assert.equal(await locatorCount(document, { role, name }), 1, `${role} ${name}`);
  }
});

test('content accessibility refs can be resolved after a snapshot', async () => {
  const button = new FakeElement('button', { text: 'Save' });
  const document = makeDocument([button]);

  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(item => item.name === 'Save');
  assert.ok(node?.ref, JSON.stringify(session.tree.nodes));
  assert.equal(node.snapshotId, 'snap_test');
  assert.equal(node.frameId, 0);

  const response = session.send({ type: 'GET_ACCESSIBILITY_REF_TARGET', ref: node.ref, snapshotId: node.snapshotId });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.target.ref, node.ref);
  assert.equal(response.target.snapshotId, 'snap_test');
  assert.equal(response.target.element.accessibleName, 'Save');
  assert.equal(response.target.actionability.actionable, true);
});

test('content accessibility refs reject stale snapshot ids', async () => {
  const button = new FakeElement('button', { text: 'Save' });
  const document = makeDocument([button]);

  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(item => item.name === 'Save');
  const response = session.send({ type: 'GET_ACCESSIBILITY_REF_TARGET', ref: node.ref, snapshotId: 'old_snapshot' });
  assert.equal(response.ok, false);
  assert.match(response.error, /Stale accessibility ref snapshot/);
});

test('ref actionability uses the shared atom (fieldset[disabled] ancestor => not enabled)', async () => {
  // The button itself has no `disabled`, but a disabled fieldset ancestor makes
  // it inactive — only the shared dom-a11y isEnabled (closest('fieldset[disabled]'))
  // catches this; the previous inline check did not.
  const button = new FakeElement('button', { text: 'Save' });
  const fieldset = new FakeElement('fieldset', { attrs: { disabled: '' }, children: [button] });
  const document = makeDocument([fieldset]);

  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(item => item.name === 'Save');
  assert.ok(node?.ref);
  const response = session.send({ type: 'GET_ACCESSIBILITY_REF_TARGET', ref: node.ref, snapshotId: node.snapshotId });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.target.actionability.enabled, false);
  assert.equal(response.target.actionability.actionable, false);
  assert.ok(response.target.actionability.reasons.includes('disabled'));
});

test('FOCUS_ACCESSIBILITY_REF focuses the element and selects its content', async () => {
  const input = new FakeInput('input', { attrs: { type: 'text' }, value: 'old text' });
  let focused = false;
  let selectedRange = null;
  input.focus = () => { focused = true; };
  input.setSelectionRange = (start, end) => { selectedRange = [start, end]; };

  const document = makeDocument([input]);
  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(n => n.ref);
  assert.ok(node?.ref);

  const res = session.send({ type: 'FOCUS_ACCESSIBILITY_REF', ref: node.ref, snapshotId: node.snapshotId, select: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(focused, true);
  assert.deepEqual(selectedRange, [0, 'old text'.length]); // whole value selected
});

test('SELECT_ACCESSIBILITY_REF_OPTIONS selects a <select> option and fires change', async () => {
  const select = new FakeSelect('select', {});
  select.multiple = false;
  select.options = [
    { value: 'us', label: 'United States', textContent: 'United States', index: 0, selected: true },
    { value: 'ca', label: 'Canada', textContent: 'Canada', index: 1, selected: false }
  ];
  const dispatched = [];
  select.dispatchEvent = (event) => { dispatched.push(event.type); };
  select.focus = () => {};

  const document = makeDocument([select]);
  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(n => n.ref);
  assert.ok(node?.ref);

  const res = session.send({ type: 'SELECT_ACCESSIBILITY_REF_OPTIONS', ref: node.ref, snapshotId: node.snapshotId, values: [{ value: 'ca' }] });
  assert.equal(res.ok, true, res.error);
  // res.selected is a vm-realm array; compare fields rather than deepEqual.
  assert.equal(res.selected.length, 1);
  assert.equal(res.selected[0].value, 'ca');
  assert.equal(res.selected[0].label, 'Canada');
  assert.equal(res.selected[0].index, 1);
  assert.equal(select.options[0].selected, false);
  assert.equal(select.options[1].selected, true);
  assert.ok(dispatched.includes('input') && dispatched.includes('change'));
});

test('SELECT_ACCESSIBILITY_REF_OPTIONS matches options by label', async () => {
  const select = new FakeSelect('select', {});
  select.multiple = false;
  select.options = [
    { value: 'us', label: 'United States', textContent: 'United States', index: 0, selected: false },
    { value: 'ca', label: 'Canada', textContent: 'Canada', index: 1, selected: false }
  ];
  select.dispatchEvent = () => {};
  select.focus = () => {};
  const document = makeDocument([select]);
  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(n => n.ref);
  const res = session.send({ type: 'SELECT_ACCESSIBILITY_REF_OPTIONS', ref: node.ref, snapshotId: node.snapshotId, values: [{ label: 'Canada' }] });
  assert.equal(res.ok, true, res.error);
  assert.equal(select.options[1].selected, true);
});

test('SELECT_ACCESSIBILITY_REF_OPTIONS rejects a non-select ref', async () => {
  const button = new FakeElement('button', { text: 'Go' });
  const document = makeDocument([button]);
  const session = await runAccessibilitySession(document);
  const node = session.tree.nodes.find(n => n.ref);
  const res = session.send({ type: 'SELECT_ACCESSIBILITY_REF_OPTIONS', ref: node.ref, snapshotId: node.snapshotId, values: [{ value: 'x' }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not a <select>/);
});
