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
    { tabId: 1, a11yDiff: true },
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
    { tabId: 1, a11yDiff: true },
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

test('action observer skips entirely when observe is false', async () => {
  let treeCalls = 0;
  const chromeApi = {
    tabs: { async get() { return { url: 'x', status: 'complete' }; }, async query() { return [{ id: 1 }]; } }
  };
  const pageHandlers = { async pageAccessibilityTree() { treeCalls += 1; return { tree: { nodes: [] } }; } };

  const result = await wrapWithActionObserver(
    'locator.click',
    { tabId: 1, observe: false },
    async () => ({ ok: true }),
    pageHandlers,
    chromeApi
  );

  assert.equal(result.ok, true);
  assert.equal('whatChanged' in result, false);
  assert.equal(treeCalls, 0);
});

test('action observer settles via onUpdated and resolves on complete', async () => {
  const listeners = new Set();
  let url = 'https://a.com';
  const chromeApi = {
    tabs: {
      async get() { return { id: 1, url, status: 'complete' }; },
      async query() { return [{ id: 1 }]; },
      onUpdated: {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn)
      }
    }
  };
  const pageHandlers = { async pageAccessibilityTree() { return { tree: { nodes: [] } }; } };
  const handler = async () => {
    url = 'https://b.com';
    // Simulate Chrome firing loading then complete shortly after the action.
    setTimeout(() => { for (const fn of [...listeners]) fn(1, { status: 'loading' }); }, 5);
    setTimeout(() => { for (const fn of [...listeners]) fn(1, { status: 'complete' }); }, 15);
    return { ok: true };
  };

  const result = await wrapWithActionObserver('page.navigate', { tabId: 1 }, handler, pageHandlers, chromeApi);

  assert.equal(result.whatChanged.urlChanged, true);
  assert.equal(result.whatChanged.toUrl, 'https://b.com');
  assert.equal(listeners.size, 0); // listener cleaned up after settle
});

test('action observer settle ignores onUpdated events for other tabs', async () => {
  const listeners = new Set();
  const chromeApi = {
    tabs: {
      async get() { return { id: 1, url: 'https://a.com', status: 'complete' }; },
      async query() { return [{ id: 1 }]; },
      onUpdated: {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn)
      }
    }
  };
  const pageHandlers = { async pageAccessibilityTree() { return { tree: { nodes: [] } }; } };
  const handler = async () => {
    // An unrelated tab finishing loading must not end our wait early; the grace
    // timer should still resolve the observer.
    setTimeout(() => { for (const fn of [...listeners]) fn(999, { status: 'complete' }); }, 2);
    return { ok: true };
  };

  const result = await wrapWithActionObserver('locator.click', { tabId: 1 }, handler, pageHandlers, chromeApi);

  assert.equal(result.ok, true);
  assert.equal(listeners.size, 0);
});

test('action observer default mode is lightweight (no a11y tree diff; focus via probe)', async () => {
  let treeCalls = 0;
  let focused = { tag: 'input', role: 'textbox', name: 'A' };
  const chromeApi = {
    tabs: { async get() { return { url: 'x', status: 'complete' }; }, async query() { return [{ id: 1 }]; } },
    scripting: { async executeScript() { return [{ result: focused }]; } }
  };
  const pageHandlers = { async pageAccessibilityTree() { treeCalls += 1; return { tree: { nodes: [] } }; } };
  const handler = async () => { focused = { tag: 'button', role: 'button', name: 'B' }; return { ok: true }; };

  const result = await wrapWithActionObserver('locator.click', { tabId: 1 }, handler, pageHandlers, chromeApi);

  assert.equal(result.ok, true);
  assert.equal(treeCalls, 0); // no full a11y tree by default
  assert.equal(result.whatChanged.a11yDiff, undefined); // a11y diff is opt-in
  assert.equal(result.whatChanged.focusChanged, true); // focus delta from the cheap probe
});
