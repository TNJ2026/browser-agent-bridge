import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importModule() {
  const source = await readFile(new URL('../extension/sw/downloads.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeChrome(items = []) {
  const searchCalls = [];
  return {
    searchCalls,
    chromeApi: {
      downloads: {
        async search(query) { searchCalls.push(query); return typeof items === 'function' ? items(query) : items; },
        onCreated: { addListener() {} },
        onChanged: { addListener() {} }
      }
    }
  };
}

const FULL_ITEM = {
  id: 3, url: 'https://a/f.pdf', finalUrl: 'https://cdn/f.pdf', filename: '/home/u/f.pdf',
  mime: 'application/pdf', state: 'complete', danger: 'safe', exists: true, paused: false,
  startTime: '2030-01-01T00:00:00.000Z', endTime: '2030-01-01T00:00:05.000Z',
  bytesReceived: 10, totalBytes: 10,
  // fields that must NOT be surfaced:
  referrer: 'https://secret.example/page', byExtensionId: 'abc', cookieStoreId: 'x'
};

test('downloadsList builds search query with defaults and passthrough filters', async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi, searchCalls } = makeChrome([]);
  const h = createDownloadsHandlers({ chromeApi });
  await h.downloadsList({});
  assert.deepEqual(searchCalls.at(-1), { limit: 50, orderBy: ['-startTime'] });
  await h.downloadsList({ limit: 10, query: 'foo', filenameRegex: '\\.pdf$', urlRegex: 'https' });
  assert.deepEqual(searchCalls.at(-1), { limit: 10, orderBy: ['-startTime'], query: ['foo'], filenameRegex: '\\.pdf$', urlRegex: 'https' });
});

test('downloadsList non-positive limit falls back to 50', async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi, searchCalls } = makeChrome([]);
  const h = createDownloadsHandlers({ chromeApi });
  await h.downloadsList({ limit: 0 });
  assert.equal(searchCalls.at(-1).limit, 50);
  await h.downloadsList({ limit: -5 });
  assert.equal(searchCalls.at(-1).limit, 50);
});

test('downloadsList projects a fixed field whitelist (no referrer leak)', async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi } = makeChrome([FULL_ITEM]);
  const h = createDownloadsHandlers({ chromeApi });
  const { items } = await h.downloadsList({});
  const item = items[0];
  assert.equal(item.id, 3);
  assert.equal(item.filename, '/home/u/f.pdf');
  assert.equal('referrer' in item, false);
  assert.equal('byExtensionId' in item, false);
  assert.equal('cookieStoreId' in item, false);
  assert.deepEqual(Object.keys(item).sort(), [
    'bytesReceived', 'danger', 'endTime', 'exists', 'filename', 'finalUrl',
    'id', 'mime', 'paused', 'startTime', 'state', 'totalBytes', 'url'
  ]);
});

test('downloadsWaitFor returns first matching completed item (includeExisting)', async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi } = makeChrome([{ ...FULL_ITEM, state: 'complete' }]);
  const h = createDownloadsHandlers({ chromeApi });
  const res = await h.downloadsWaitFor({ includeExisting: true, filenameContains: 'f.pdf' });
  assert.equal(res.ok, true);
  assert.equal(res.item.id, 3);
  assert.equal('referrer' in res.item, false); // normalized projection too
});

test('downloadsWaitFor state filter ignores non-matching state', async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi } = makeChrome([{ ...FULL_ITEM, state: 'in_progress' }]);
  const h = createDownloadsHandlers({ chromeApi });
  await assert.rejects(
    () => h.downloadsWaitFor({ includeExisting: true, filenameContains: 'f.pdf', state: 'complete', timeoutMs: 5, intervalMs: 1 }),
    /Timed out waiting for download.*to be complete/
  );
});

test("downloadsWaitFor state 'any' matches regardless of state", async () => {
  const { createDownloadsHandlers } = await importModule();
  const { chromeApi } = makeChrome([{ ...FULL_ITEM, state: 'interrupted' }]);
  const h = createDownloadsHandlers({ chromeApi });
  const res = await h.downloadsWaitFor({ includeExisting: true, state: 'any', id: 3 });
  assert.equal(res.item.state, 'interrupted');
});

test('downloadsWaitFor matchers: id / url(finalUrl) / urlContains / filename / filenameContains', async () => {
  const { createDownloadsHandlers } = await importModule();
  const make = h => h;
  // url matches against finalUrl too
  let { chromeApi } = makeChrome([{ ...FULL_ITEM }]);
  let h = createDownloadsHandlers({ chromeApi });
  let res = await h.downloadsWaitFor({ includeExisting: true, url: 'https://cdn/f.pdf', state: 'any' });
  assert.equal(res.item.id, 3);

  ({ chromeApi } = makeChrome([{ ...FULL_ITEM }]));
  h = createDownloadsHandlers({ chromeApi });
  await assert.rejects(() => h.downloadsWaitFor({ includeExisting: true, filename: '/no/match', state: 'any', timeoutMs: 5, intervalMs: 1 }));

  ({ chromeApi } = makeChrome([{ ...FULL_ITEM }]));
  h = createDownloadsHandlers({ chromeApi });
  res = await h.downloadsWaitFor({ includeExisting: true, urlContains: 'cdn', state: 'any' });
  assert.equal(res.item.id, 3);
});

test('downloadsWaitFor without includeExisting skips items started before the wait began', async () => {
  const { createDownloadsHandlers } = await importModule();
  const oldItem = { ...FULL_ITEM, startTime: '2000-01-01T00:00:00.000Z', state: 'complete' };
  const { chromeApi } = makeChrome([oldItem]);
  const h = createDownloadsHandlers({ chromeApi });
  await assert.rejects(
    () => h.downloadsWaitFor({ filenameContains: 'f.pdf', timeoutMs: 5, intervalMs: 1 }),
    /Timed out waiting/
  );
});

test('initDownloadEvents is a no-op when downloads API is unavailable', async () => {
  const { createDownloadsHandlers } = await importModule();
  const h = createDownloadsHandlers({ chromeApi: {} });
  assert.doesNotThrow(() => h.initDownloadEvents());
});
