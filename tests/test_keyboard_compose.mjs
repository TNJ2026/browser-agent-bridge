import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importKeyboardModule() {
  const source = await readFile(new URL('../extension/sw/keyboard.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeDispatcher() {
  const calls = [];
  return importKeyboardModule().then(({ createKeyboardDispatcher }) => ({
    calls,
    dispatcher: createKeyboardDispatcher({
      cdp: async (tabId, method, params) => { calls.push({ tabId, method, params }); return {}; },
      sleep: async () => {}
    })
  }));
}

test('compose drives incremental IME composition then commits', async () => {
  const { calls, dispatcher } = await makeDispatcher();
  await dispatcher.compose(1, '你好');

  const composition = calls.filter(c => c.method === 'Input.imeSetComposition');
  assert.deepEqual(composition.map(c => c.params.text), ['你', '你好']);
  assert.equal(composition[1].params.selectionStart, 2);
  assert.equal(composition[1].params.selectionEnd, 2);

  const commit = calls.find(c => c.method === 'Input.insertText');
  assert.ok(commit, 'expected a commit via insertText');
  assert.equal(commit.params.text, '你好');
  // commit happens after composition
  assert.ok(calls.indexOf(commit) > calls.indexOf(composition[1]));
});

test('compose uses UTF-16 code unit length for selection start/end of surrogate pairs', async () => {
  const { calls, dispatcher } = await makeDispatcher();
  await dispatcher.compose(1, '𠮷');

  const composition = calls.filter(c => c.method === 'Input.imeSetComposition');
  assert.deepEqual(composition.map(c => c.params.text), ['𠮷']);
  assert.equal(composition[0].params.selectionStart, 2);
  assert.equal(composition[0].params.selectionEnd, 2);
});

test('compose with commit:false leaves the composition pending', async () => {
  const { calls, dispatcher } = await makeDispatcher();
  await dispatcher.compose(1, 'abc', { commit: false });

  assert.equal(calls.filter(c => c.method === 'Input.imeSetComposition').length, 3);
  assert.equal(calls.some(c => c.method === 'Input.insertText'), false);
});

test('compose honors explicit composition segments', async () => {
  const { calls, dispatcher } = await makeDispatcher();
  await dispatcher.compose(1, '日本語', { segments: ['に', 'にほん', '日本語'] });

  const composition = calls.filter(c => c.method === 'Input.imeSetComposition');
  assert.deepEqual(composition.map(c => c.params.text), ['に', 'にほん', '日本語']);
  assert.equal(calls.find(c => c.method === 'Input.insertText').params.text, '日本語');
});

test('compose with empty text is a no-op', async () => {
  const { calls, dispatcher } = await makeDispatcher();
  await dispatcher.compose(1, '');
  assert.equal(calls.length, 0);
});

async function makeHandlers() {
  const { createKeyboardHandlers } = await importKeyboardModule();
  const record = [];
  const composeCalls = [];
  let attached = 0;
  const handlers = createKeyboardHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v, name) => { if (typeof v !== 'string' || !v) throw new Error(`${name} required`); return v; },
    attachDebugger: async () => { attached += 1; },
    recordAction: async (tabId, action, meta) => { record.push({ action, meta }); },
    dispatcher: {
      compose: async (tabId, text, options) => { composeCalls.push({ tabId, text, options }); }
    }
  });
  return { handlers, record, composeCalls, get attached() { return attached; } };
}

test('keyboard.compose handler focuses the dispatcher and records the action', async () => {
  const ctx = await makeHandlers();
  const res = await ctx.handlers.keyboardCompose({ tabId: 5, text: '你好', delayMs: 10 });

  assert.equal(res.ok, true);
  assert.equal(ctx.attached, 1);
  assert.equal(ctx.composeCalls[0].text, '你好');
  assert.equal(ctx.composeCalls[0].tabId, 5);
  assert.equal(ctx.record[0].action, 'keyboard.compose');
  assert.equal(ctx.record[0].meta.committed, true);
});

test('keyboard.compose handler requires text', async () => {
  const ctx = await makeHandlers();
  await assert.rejects(ctx.handlers.keyboardCompose({ tabId: 5 }), /text required/);
});
