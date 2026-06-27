import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

// Helper to extract the 12 in-page functions from dom.js
async function extractInpageFunctions() {
  const content = await fs.readFile(new URL('../extension/sw/dom.js', import.meta.url), 'utf8');
  const regex = /func:\s*\(([^)]*)\)\s*=>\s*\{/g;
  const functions = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const startIndex = match.index + match[0].length - 1; // start brace '{'
    let braceCount = 1;
    let endIndex = startIndex + 1;
    while (braceCount > 0 && endIndex < content.length) {
      if (content[endIndex] === '{') braceCount++;
      if (content[endIndex] === '}') braceCount--;
      endIndex++;
    }
    const funcBody = content.substring(startIndex, endIndex);
    const argsStr = match[1];
    const trimmedBody = funcBody.trim().slice(1, -1);
    const func = new Function(argsStr, trimmedBody);
    functions.push({ args: argsStr, body: trimmedBody, func });
  }
  return functions;
}

class FakeEvent {
  constructor(type, options) {
    this.type = type;
    this.options = options;
  }
}
class FakeMouseEvent extends FakeEvent {}

class FakeDataTransfer {
  constructor() {
    this.data = {};
    this.types = [];
  }
  setData(type, value) {
    this.data[type] = value;
    this.types.push(type);
  }
  getData(type) {
    return this.data[type];
  }
}

class FakeDOMElement {
  constructor(tagName, options = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = options.id || '';
    this.name = options.name || '';
    this.placeholder = options.placeholder || '';
    this.role = options.role || '';
    this.type = options.type || '';
    this.innerText = options.text || '';
    this.textContent = options.text || '';
    this.value = options.value || '';
    this.multiple = options.multiple || false;
    this.disabled = options.disabled || false;
    this.accept = options.accept || '';
    this.files = options.files || [];
    this.shadowRoot = options.shadowRoot || null;
    this.children = options.children || [];
    this.parentElement = null;
    this.attrs = options.attrs || {};
    this.events = [];
    this._rect = options.rect || { x: 0, y: 0, width: 100, height: 50 };

    for (const child of this.children) {
      child.parentElement = this;
    }
  }

  getAttribute(name) {
    if (name === 'name') return this.name;
    if (name === 'placeholder') return this.placeholder;
    if (name === 'role') return this.role;
    if (name === 'type') return this.type;
    if (name === 'accept') return this.accept;
    return this.attrs[name] || '';
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  removeAttribute(name) {
    delete this.attrs[name];
  }

  getBoundingClientRect() {
    return this._rect;
  }

  scrollIntoView() {
    this.scrolled = true;
  }

  focus() {
    this.focused = true;
  }

  dispatchEvent(event) {
    this.events.push(event);
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      if (node !== this) {
        if (selector === '*' || node.tagName.toLowerCase() === selector.toLowerCase() || (selector.startsWith('.') && node.id === selector.slice(1)) || (selector.startsWith('#') && node.id === selector.slice(1))) {
          results.push(node);
        } else if (selector.includes('[') && selector.includes('=')) {
          const matchAttr = selector.match(/\[([^=]+)="([^"]+)"\]/);
          if (matchAttr) {
            const name = matchAttr[1];
            const val = matchAttr[2];
            if (node.getAttribute(name) === val) {
              results.push(node);
            }
          }
        }
      }
      for (const child of node.children) {
        walk(child);
      }
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
    };
    walk(this);
    return results;
  }
}

class FakeSelectElement extends FakeDOMElement {
  constructor(options = {}) {
    super('select', options);
    this.selectedOptions = options.selectedOptions || [];
  }
}

class FakeDOMElementWithScroll extends FakeDOMElement {
  constructor(tagName, options) {
    super(tagName, options);
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }
  scrollBy({ left, top }) {
    this.scrollLeft += left;
    this.scrollTop += top;
  }
  scrollTo({ left, top }) {
    this.scrollLeft = left;
    this.scrollTop = top;
  }
}

class FakeInputElementWithSelection extends FakeDOMElement {
  constructor(options) {
    super('input', options);
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

function setupBrowserGlobals(docRoot) {
  globalThis.document = docRoot;
  globalThis.window = {
    scrollX: 0,
    scrollY: 0,
    scrollBy({ left, top }) { this.scrollX += left; this.scrollY += top; },
    scrollTo({ left, top }) { this.scrollX = left; this.scrollY = top; }
  };
  globalThis.getComputedStyle = (element) => ({
    visibility: 'visible',
    display: 'block',
    pointerEvents: 'auto'
  });
  globalThis.DragEvent = FakeMouseEvent;
  globalThis.MouseEvent = FakeMouseEvent;
  globalThis.Event = FakeEvent;
  globalThis.DataTransfer = FakeDataTransfer;
  globalThis.Node = {
    TEXT_NODE: 3,
    ELEMENT_NODE: 1
  };
}

function cleanupBrowserGlobals() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.getComputedStyle;
  delete globalThis.DragEvent;
  delete globalThis.MouseEvent;
  delete globalThis.Event;
  delete globalThis.DataTransfer;
  delete globalThis.Node;
}

const funcs = await extractInpageFunctions();

test('1. domQuery', async () => {
  const btn = new FakeDOMElement('button', { id: 'btn1', text: 'Click me' });
  const root = new FakeDOMElement('body', { children: [btn] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[0].func('button', 10, null);
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'btn1');
    assert.equal(res[0].text, 'Click me');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('2. domDispatchDragDrop', async () => {
  const source = new FakeDOMElement('div', { id: 'drag-source' });
  const target = new FakeDOMElement('div', { id: 'drag-target' });
  const root = new FakeDOMElement('body', { children: [source, target] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[1].func('div', 0, 'div', 1, [{ type: 'text/plain', value: 'hello' }], null);
    assert.equal(source.events.some(e => e.type === 'dragstart'), true);
    assert.equal(target.events.some(e => e.type === 'drop'), true);
    assert.equal(res.types.includes('text/plain'), true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('3. domSelect', async () => {
  const opt = new FakeDOMElement('option', { text: 'Option 2' });
  const select = new FakeSelectElement({ id: 'sel', value: 'opt1', selectedOptions: [opt] });
  const root = new FakeDOMElement('body', { children: [select] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[2].func('select', 0, 'opt2', true, null);
    assert.equal(select.value, 'opt2');
    assert.equal(select.events.some(e => e.type === 'change'), true);
    assert.equal(res.text, 'Option 2');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('4. domPrepareFileInput', async () => {
  const input = new FakeDOMElement('input', { type: 'file', id: 'file-inp' });
  const root = new FakeDOMElement('body', { children: [input] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[3].func('input', 0, 'mark', 'val', true, null);
    assert.equal(input.getAttribute('mark'), 'val');
    assert.equal(res.tagName, 'input');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('5. domHover', async () => {
  const btn = new FakeDOMElement('button', { id: 'btn' });
  const root = new FakeDOMElement('body', { children: [btn] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[4].func('button', 0, true, null);
    assert.equal(btn.events.some(e => e.type === 'mouseover'), true);
    assert.equal(btn.events.some(e => e.type === 'mouseenter'), true);
    assert.equal(res.tagName, 'button');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('6. domScroll', async () => {
  const div = new FakeDOMElementWithScroll('div', { id: 'scrollable' });
  const root = new FakeDOMElement('body', { children: [div] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[5].func('div', 0, 10, 20, 'scrollBy', 'auto', null);
    assert.equal(div.scrollLeft, 10);
    assert.equal(div.scrollTop, 20);
    assert.equal(res.scrollLeft, 10);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('7. waitForDomActionable', async () => {
  const btn = new FakeDOMElement('button', { id: 'btn' });
  const root = new FakeDOMElement('body', { children: [btn] });
  setupBrowserGlobals(root);
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  root.elementFromPoint = () => btn;
  try {
    const res = await funcs[6].func('button', 0, false, null, 'click', 50, 10, false, false);
    assert.equal(res.actionability.visible, true);
    assert.equal(res.actionability.enabled, true);
  } finally {
    cleanupBrowserGlobals();
    delete globalThis.MutationObserver;
  }
});

test('8. getDomClickTarget', async () => {
  const btn = new FakeDOMElement('button', { id: 'btn' });
  const root = new FakeDOMElement('body', { children: [btn] });
  setupBrowserGlobals(root);
  root.elementFromPoint = () => btn;
  try {
    const res = funcs[7].func('button', 0, false, null);
    assert.equal(res.found, true);
    assert.equal(res.element.tagName, 'button');
    assert.equal(res.actionability.visible, true);
  } finally {
    cleanupBrowserGlobals();
  }
});

test('9. prepareDomTextInput', async () => {
  const input = new FakeInputElementWithSelection({ type: 'text', value: 'hello' });
  const root = new FakeDOMElement('body', { children: [input] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[8].func('input', 0, false, null, true);
    assert.equal(input.focused, true);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, 5);
    assert.equal(res.tagName, 'input');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('10. getDomElementSummary', async () => {
  const btn = new FakeDOMElement('button', { id: 'btn1', text: 'Click', value: 'Click' });
  const root = new FakeDOMElement('body', { children: [btn] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[9].func('button', 0, null);
    assert.equal(res.tagName, 'button');
    assert.equal(res.value, 'Click');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('11. summarizeFileInputAfterSet', async () => {
  const input = new FakeDOMElement('input', { type: 'file', files: [{ name: 'test.txt', size: 123, type: 'text/plain' }] });
  input.setAttribute('mark', 'val');
  const root = new FakeDOMElement('body', { children: [input] });
  setupBrowserGlobals(root);
  try {
    const res = funcs[10].func('mark', 'val', null);
    assert.equal(input.events.some(e => e.type === 'change'), true);
    assert.equal(input.getAttribute('mark'), '');
    assert.equal(res.fileCount, 1);
    assert.equal(res.files[0].name, 'test.txt');
  } finally {
    cleanupBrowserGlobals();
  }
});

test('12. clearFileInputMarker', async () => {
  const input = new FakeDOMElement('input', { type: 'file' });
  input.setAttribute('mark', 'val');
  const root = new FakeDOMElement('body', { children: [input] });
  setupBrowserGlobals(root);
  try {
    funcs[11].func('mark', 'val', null);
    assert.equal(input.getAttribute('mark'), '');
  } finally {
    cleanupBrowserGlobals();
  }
});
