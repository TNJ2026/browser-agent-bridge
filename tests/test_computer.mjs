import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importModule() {
  const source = await readFile(new URL('../extension/sw/computer.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeHandlers() {
  const cdpCalls = [];
  const indicatorCalls = [];
  const recordCalls = [];
  const keyCalls = [];
  const attached = [];
  const deps = {
    assertTabId: id => id,
    assertTabAllowed: async () => {},
    assertString: (v, name) => { if (typeof v !== 'string') throw new Error(`${name} must be string`); },
    assertNumber: (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be number`); return v; },
    attachDebugger: async tabId => { attached.push(tabId); },
    cdp: async (tabId, method, params = {}) => { cdpCalls.push({ tabId, method, params }); },
    indicatorSet: async opts => { indicatorCalls.push(opts); },
    recordAction: async (tabId, type, input) => { recordCalls.push({ tabId, type, input }); },
    keyboardDispatcher: {
      async typeText(tabId, text, params) { keyCalls.push({ op: 'typeText', tabId, text, params }); },
      async press(tabId, key, params) { keyCalls.push({ op: 'press', tabId, key, params }); }
    }
  };
  return { deps, cdpCalls, indicatorCalls, recordCalls, keyCalls, attached };
}

async function load() {
  const mod = await importModule();
  const ctx = makeHandlers();
  return { h: mod.createComputerHandlers(ctx.deps), ...ctx };
}

const mouse = c => c.filter(x => x.method === 'Input.dispatchMouseEvent');

test('click dispatches press+release with defaults and attaches debugger', async () => {
  const { h, cdpCalls, attached, recordCalls } = await load();
  await h.computerClick({ tabId: 1, x: 5, y: 6 });
  const m = mouse(cdpCalls);
  assert.equal(m.length, 2);
  assert.deepEqual([m[0].params.type, m[1].params.type], ['mousePressed', 'mouseReleased']);
  for (const ev of m) {
    assert.equal(ev.params.x, 5);
    assert.equal(ev.params.y, 6);
    assert.equal(ev.params.button, 'left');
    assert.equal(ev.params.clickCount, 1);
  }
  assert.deepEqual(attached, [1]);
  assert.deepEqual(recordCalls.at(-1), { tabId: 1, type: 'computer.click', input: { x: 5, y: 6, button: 'left', clickCount: 1 } });
});

test('click honors button and clickCount', async () => {
  const { h, cdpCalls } = await load();
  await h.computerClick({ tabId: 1, x: 0, y: 0, button: 'right', clickCount: 2 });
  for (const ev of mouse(cdpCalls)) {
    assert.equal(ev.params.button, 'right');
    assert.equal(ev.params.clickCount, 2);
  }
});

test('click rejects missing coordinates', async () => {
  const { h } = await load();
  await assert.rejects(() => h.computerClick({ tabId: 1, y: 6 }), /x must be number/);
  await assert.rejects(() => h.computerClick({ tabId: 1, x: 5 }), /y must be number/);
});

test('click indicator only fires when showIndicator === true', async () => {
  let r = await load();
  await r.h.computerClick({ tabId: 1, x: 1, y: 1 });
  assert.equal(r.indicatorCalls.length, 0);
  r = await load();
  await r.h.computerClick({ tabId: 1, x: 1, y: 1, showIndicator: true, indicatorLabel: 'tap' });
  assert.equal(r.indicatorCalls.length, 1);
  assert.equal(r.indicatorCalls[0].label, 'tap');
});

test('drag emits press, interpolated moves, release (default 12 steps)', async () => {
  const { h, cdpCalls } = await load();
  await h.computerDrag({ tabId: 1, fromX: 0, fromY: 0, toX: 12, toY: 24 });
  const m = mouse(cdpCalls);
  assert.equal(m[0].params.type, 'mousePressed');
  assert.equal(m.at(-1).params.type, 'mouseReleased');
  const moves = m.filter(e => e.params.type === 'mouseMoved');
  assert.equal(moves.length, 12);
  // first move at t=1/12 -> (1,2); last move at t=1 -> (12,24)
  assert.deepEqual([moves[0].params.x, moves[0].params.y], [1, 2]);
  assert.deepEqual([moves.at(-1).params.x, moves.at(-1).params.y], [12, 24]);
  assert.deepEqual([m.at(-1).params.x, m.at(-1).params.y], [12, 24]);
});

test('drag honors custom steps and interpolates correctly', async () => {
  const { h, cdpCalls } = await load();
  await h.computerDrag({ tabId: 1, fromX: 0, fromY: 0, toX: 10, toY: 20, steps: 2 });
  const moves = mouse(cdpCalls).filter(e => e.params.type === 'mouseMoved');
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map(e => [e.params.x, e.params.y]), [[5, 10], [10, 20]]);
});

test('drag reflects held button in the buttons bitmask', async () => {
  for (const [button, mask] of [['left', 1], ['right', 2], ['middle', 4], ['back', 8], ['forward', 16]]) {
    const { h, cdpCalls } = await load();
    await h.computerDrag({ tabId: 1, fromX: 0, fromY: 0, toX: 4, toY: 4, button, steps: 1 });
    const move = mouse(cdpCalls).find(e => e.params.type === 'mouseMoved');
    assert.equal(move.params.buttons, mask, `button=${button}`);
    assert.equal(move.params.button, button);
  }
});

test('scroll applies defaults and allows explicit zero coords', async () => {
  let { h, cdpCalls } = await load();
  await h.computerScroll({ tabId: 1 });
  let ev = mouse(cdpCalls)[0];
  assert.equal(ev.params.type, 'mouseWheel');
  assert.deepEqual([ev.params.x, ev.params.y, ev.params.deltaX, ev.params.deltaY], [400, 400, 0, 500]);

  ({ h, cdpCalls } = await load());
  await h.computerScroll({ tabId: 1, x: 0, y: 0, deltaX: -10, deltaY: -20 });
  ev = mouse(cdpCalls)[0];
  assert.deepEqual([ev.params.x, ev.params.y, ev.params.deltaX, ev.params.deltaY], [0, 0, -10, -20]);
});

test('hover dispatches a single mouseMoved', async () => {
  const { h, cdpCalls, indicatorCalls } = await load();
  await h.computerHover({ tabId: 1, x: 3, y: 4 });
  const m = mouse(cdpCalls);
  assert.equal(m.length, 1);
  assert.equal(m[0].params.type, 'mouseMoved');
  assert.deepEqual([m[0].params.x, m[0].params.y], [3, 4]);
  assert.equal(indicatorCalls.length, 0);
});

test('type validates string and delegates to keyboardDispatcher.typeText', async () => {
  const { h, keyCalls } = await load();
  await assert.rejects(() => h.computerType({ tabId: 1, text: 123 }), /text must be string/);
  await h.computerType({ tabId: 1, text: 'hello' });
  assert.deepEqual(keyCalls.at(-1).op, 'typeText');
  assert.equal(keyCalls.at(-1).text, 'hello');
});

test('key validates string and delegates to keyboardDispatcher.press', async () => {
  const { h, keyCalls } = await load();
  await assert.rejects(() => h.computerKey({ tabId: 1 }), /key must be string/);
  await h.computerKey({ tabId: 1, key: 'Enter' });
  assert.deepEqual(keyCalls.at(-1).op, 'press');
  assert.equal(keyCalls.at(-1).key, 'Enter');
});
