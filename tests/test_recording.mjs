import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importModule() {
  const source = await readFile(new URL('../extension/sw/recording.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeDeps(overrides = {}) {
  const store = {};
  const screenshotCalls = [];
  const downloadCalls = [];
  const deps = {
    assertTabId: id => id,
    assertString: (v, name) => { if (typeof v !== 'string') throw new Error(`${name} required`); },
    normalizeTab: tab => ({ id: tab.id, url: tab.url, groupId: tab.groupId }),
    captureTabScreenshot: async (tabId) => { screenshotCalls.push(tabId); return 'data:image/jpeg;base64,FAKE'; },
    loadPolicy: async () => ({}),
    isUrlAllowedByPolicy: () => true,
    errorMessage: e => e.message,
    chromeApi: {
      storage: { local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(obj) { Object.assign(store, obj); }
      } },
      tabs: { async get(id) { return { id, url: overrides.tabUrl || 'https://app.example/p', groupId: overrides.groupId ?? 10 }; } },
      downloads: { async download(opts) { downloadCalls.push(opts); return 7; } }
    },
    setTimer: () => null,
    clearTimer: () => {},
    ...overrides.deps
  };
  if (overrides.isUrlAllowedByPolicy) deps.isUrlAllowedByPolicy = overrides.isUrlAllowedByPolicy;
  return { deps, store, screenshotCalls, downloadCalls };
}

test('input text/value/key are redacted unless includeText', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.recordAction(1, 'fill', { text: 'secret', value: 'pw', key: 'Enter', selector: '#u' });
  const exported = await h.recordingExport({ recordingId: recording.id });
  const input = exported.recording.actions[0].input;
  assert.deepEqual(input.text, { redacted: true, length: 6, empty: false });
  assert.deepEqual(input.value, { redacted: true, length: 2, empty: false });
  assert.deepEqual(input.key, { redacted: true, length: 5, empty: false });
  assert.equal(input.selector, '#u'); // non-sensitive field preserved
});

test('includeText keeps raw text', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, includeText: true });
  await h.recordAction(1, 'fill', { text: 'secret' });
  const exported = await h.recordingExport({ recordingId: recording.id });
  assert.equal(exported.recording.actions[0].input.text, 'secret');
});

test('screenshots captured only for policy-allowed URLs', async () => {
  const { createRecordingHandlers } = await importModule();
  // allowed
  let m = makeDeps({ isUrlAllowedByPolicy: () => true });
  let h = createRecordingHandlers(m.deps);
  let rec = (await h.recordingStart({ tabId: 1, captureScreenshots: true })).recording;
  // recordingStart already fired an initial_state action with a screenshot
  let exported = await h.recordingExport({ recordingId: rec.id });
  assert.equal(exported.recording.actions[0].screenshot, 'data:image/jpeg;base64,FAKE');

  // blocked
  m = makeDeps({ isUrlAllowedByPolicy: () => false });
  h = createRecordingHandlers(m.deps);
  rec = (await h.recordingStart({ tabId: 1, captureScreenshots: true })).recording;
  exported = await h.recordingExport({ recordingId: rec.id });
  assert.equal('screenshot' in exported.recording.actions[0], false);
  assert.equal(m.screenshotCalls.length, 0);
});

test('summarizeRecording exposes actionCount but never the actions/screenshots', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.recordAction(1, 'click', { selector: '#x' });
  const status = await h.recordingStatus({ recordingId: recording.id });
  assert.equal(status.recording.actionCount, 1);
  assert.equal('actions' in status.recording, false);
  assert.equal('screenshot' in status.recording, false);
});

test('retention and maxActions are clamped', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const big = await h.recordingStart({ tabId: 1, retentionMs: 999 * 24 * 60 * 60 * 1000, maxActions: 999999 });
  assert.equal(big.recording.retentionMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(big.recording.maxActions, 5000);
  const small = await h.recordingStart({ tabId: 1, retentionMs: 1, maxActions: 0 });
  assert.equal(small.recording.retentionMs, 60 * 1000);
  assert.equal(small.recording.maxActions, 1);
});

test('actions ring buffer caps at maxActions and reindexes', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false, maxActions: 2 });
  for (const n of [1, 2, 3]) await h.recordAction(1, 'click', { n });
  const exported = await h.recordingExport({ recordingId: recording.id });
  const actions = exported.recording.actions;
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(a => a.index), [0, 1]);
  assert.deepEqual(actions.map(a => a.input.n), [2, 3]); // oldest dropped
});

test('expired recordings are pruned on load', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps, store } = makeDeps();
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.browserAgentBridgeRecordings = [
    { id: 'dead', name: 'old', expiresAt: past, startedAt: past, isRecording: false, actions: [] },
    { id: 'live', name: 'new', expiresAt: future, startedAt: future, isRecording: false, actions: [] }
  ];
  const h = createRecordingHandlers(deps);
  const status = await h.recordingStatus({});
  assert.deepEqual(status.recordings.map(r => r.id), ['live']);
});

test('recordingExport download sanitizes filename', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps, downloadCalls } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.recordingExport({ recordingId: recording.id, download: true, filename: '../../etc/pa:ss*?.json' });
  const fn = downloadCalls.at(-1).filename;
  assert.ok(!/[\\/:*?"<>|]/.test(fn), `filename still has unsafe chars: ${fn}`);
});

test('recordingStop marks not recording; recordAction ignores stopped', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.recordingStop({ recordingId: recording.id });
  await h.recordAction(1, 'click', { selector: '#x' });
  const exported = await h.recordingExport({ recordingId: recording.id });
  assert.equal(exported.recording.isRecording, false);
  assert.equal(exported.recording.actions.length, 0);
});

test('recordAction matches tab scope only for the right tab', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.recordAction(2, 'click', { selector: '#other' }); // different tab -> ignored
  await h.recordAction(1, 'click', { selector: '#mine' });
  const exported = await h.recordingExport({ recordingId: recording.id });
  assert.equal(exported.recording.actions.length, 1);
  assert.equal(exported.recording.actions[0].input.selector, '#mine');
});

test('onTabRemoved stops tab-scoped recording', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const { recording } = await h.recordingStart({ tabId: 1, captureScreenshots: false });
  await h.onTabRemoved(1);
  const status = await h.recordingStatus({ recordingId: recording.id });
  assert.equal(status.recording.isRecording, false);
  assert.ok(status.recording.stoppedAt);
});

test('recordingClear removes one or all recordings', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  const a = (await h.recordingStart({ tabId: 1, captureScreenshots: false })).recording;
  const b = (await h.recordingStart({ tabId: 1, captureScreenshots: false })).recording;
  const single = await h.recordingClear({ recordingId: a.id });
  assert.deepEqual(single.cleared, [a.id]);
  const remaining = await h.recordingStatus({});
  assert.deepEqual(remaining.recordings.map(r => r.id), [b.id]);
  const all = await h.recordingClear({});
  assert.deepEqual(all.cleared, [b.id]);
});

test('requireRecording throws for unknown id', async () => {
  const { createRecordingHandlers } = await importModule();
  const { deps } = makeDeps();
  const h = createRecordingHandlers(deps);
  await assert.rejects(() => h.recordingStop({ recordingId: 'nope' }), /Recording not found/);
});
