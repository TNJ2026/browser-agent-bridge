import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapWithActionObserver } from '../extension/sw/action-observer.js';

test('action observer detects url changes', async () => {
  let url = 'https://first.com';
  const chromeApi = {
    tabs: {
      async get() { return { url, status: 'complete' }; },
      async query() { return [{ id: 1 }]; }
    }
  };
  const pageHandlers = {
    async pageAccessibilityTree() { return { tree: { nodes: [] } }; }
  };
  const handler = async () => {
    url = 'https://second.com';
    return { ok: true };
  };

  const result = await wrapWithActionObserver(
    'locator.click',
    { tabId: 1 },
    handler,
    pageHandlers,
    chromeApi
  );

  assert.equal(result.ok, true);
  assert.equal(result.whatChanged.urlChanged, true);
  assert.equal(result.whatChanged.fromUrl, 'https://first.com');
  assert.equal(result.whatChanged.toUrl, 'https://second.com');
});

test('action observer detects focus changes', async () => {
  let activeElementFocused = false;
  const chromeApi = {
    tabs: {
      async get() { return { url: 'https://test.com', status: 'complete' }; },
      async query() { return [{ id: 1 }]; }
    }
  };
  const pageHandlers = {
    async pageAccessibilityTree() {
      return {
        tree: {
          nodes: [
            { ref: 'ref_1', tag: 'input', role: 'textbox', name: 'Username', focused: activeElementFocused }
          ]
        }
      };
    }
  };
  const handler = async () => {
    activeElementFocused = true;
    return { ok: true };
  };

  const result = await wrapWithActionObserver(
    'locator.fill',
    { tabId: 1 },
    handler,
    pageHandlers,
    chromeApi
  );

  assert.equal(result.ok, true);
  assert.equal(result.whatChanged.focusChanged, true);
  assert.deepEqual(result.whatChanged.focusedElement, {
    ref: 'ref_1',
    tag: 'input',
    role: 'textbox',
    name: 'Username'
  });
});

test('action observer detects new popups', async () => {
  const tabsList = [{ id: 1 }];
  const chromeApi = {
    tabs: {
      async get(id) {
        if (id === 1) return { id: 1, url: 'https://test.com', status: 'complete' };
        if (id === 2) return { id: 2, url: 'https://popup.com', title: 'Popup Title', status: 'complete' };
        throw new Error('Not found');
      },
      async query() { return tabsList; }
    }
  };
  const pageHandlers = {
    async pageAccessibilityTree() { return { tree: { nodes: [] } }; }
  };
  const handler = async () => {
    tabsList.push({ id: 2 });
    return { ok: true };
  };

  const result = await wrapWithActionObserver(
    'locator.click',
    { tabId: 1 },
    handler,
    pageHandlers,
    chromeApi
  );

  assert.equal(result.ok, true);
  assert.equal(result.whatChanged.newPopups.length, 1);
  assert.deepEqual(result.whatChanged.newPopups[0], {
    tabId: 2,
    url: 'https://popup.com',
    title: 'Popup Title'
  });
});

test('action observer computes accessibility tree diffs (added/removed/changed)', async () => {
  let isSubscribed = false;
  let showExtraButton = false;
  
  const chromeApi = {
    tabs: {
      async get() { return { url: 'https://test.com', status: 'complete' }; },
      async query() { return [{ id: 1 }]; }
    }
  };
  const pageHandlers = {
    async pageAccessibilityTree() {
      const nodes = [
        { ref: 'ref_1', tag: 'input', role: 'checkbox', name: 'Subscribe', value: isSubscribed ? 'true' : 'false' }
      ];
      if (showExtraButton) {
        nodes.push({ ref: 'ref_2', tag: 'button', role: 'button', name: 'Submit' });
      }
      return { tree: { nodes } };
    }
  };
  const handler = async () => {
    isSubscribed = true;
    showExtraButton = true;
    return { ok: true };
  };

  const result = await wrapWithActionObserver(
    'locator.click',
    { tabId: 1 },
    handler,
    pageHandlers,
    chromeApi
  );

  assert.equal(result.ok, true);
  assert.ok(result.whatChanged.a11yDiff);
  
  // Verify changed input value
  assert.equal(result.whatChanged.a11yDiff.changed.length, 1);
  assert.deepEqual(result.whatChanged.a11yDiff.changed[0], {
    tag: 'input',
    role: 'checkbox',
    name: 'Subscribe',
    fromValue: 'false',
    toValue: 'true'
  });
  
  // Verify added button
  assert.equal(result.whatChanged.a11yDiff.added.length, 1);
  assert.deepEqual(result.whatChanged.a11yDiff.added[0], {
    tag: 'button',
    role: 'button',
    name: 'Submit',
    text: undefined,
    value: undefined
  });
});
