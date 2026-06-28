const OBSERVED_METHODS = new Set([
  'dom.click',
  'dom.select',
  'dom.setInputFiles',
  'dom.type',
  'locator.click',
  'locator.clickRef',
  'locator.fillRef',
  'locator.pressRef',
  'locator.check',
  'locator.uncheck',
  'locator.selectOption',
  'locator.setInputFiles',
  'locator.fill',
  'locator.press',
  'locator.pressSequentially',
  'locator.dragTo',
  'locator.dispatchDragDrop',
  'locator.focus',
  'computer.click',
  'computer.drag',
  'computer.type',
  'computer.key',
  'page.navigate',
  'page.reload',
  'page.goBack',
  'page.goForward'
]);

async function captureTabState(tabId, pageHandlers, chromeApi, includeTree = false) {
  try {
    const tab = await chromeApi.tabs.get(tabId);

    // Full accessibility-tree capture is expensive (a whole-DOM traversal), so it
    // is only done when an a11y diff was explicitly requested. By default we take
    // a cheap focused-element probe and skip the tree.
    if (includeTree) {
      const treeResult = await pageHandlers.pageAccessibilityTree({ tabId }).catch(() => null);
      const tree = treeResult?.tree || null;
      return {
        url: tab.url,
        title: tab.title,
        tree,
        focusedNode: tree?.nodes?.find(n => n.focused) || null
      };
    }

    return {
      url: tab.url,
      title: tab.title,
      tree: null,
      focusedNode: await captureFocusedElement(tabId, chromeApi)
    };
  } catch (e) {
    return null;
  }
}

async function captureFocusedElement(tabId, chromeApi) {
  try {
    if (typeof chromeApi.scripting?.executeScript !== 'function') return null;
    const [{ result } = {}] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        return {
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          role: (el.getAttribute && el.getAttribute('role')) || '',
          name: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name'))) || '',
          value: 'value' in el ? String(el.value).slice(0, 200) : ''
        };
      }
    });
    return result || null;
  } catch {
    return null;
  }
}

function getNodeKey(node) {
  return `${node.tag || ''}|${node.role || ''}|${node.name || ''}|${node.type || ''}|${node.href || ''}`;
}

function keyNodes(nodes) {
  const counts = new Map();
  return nodes.map(node => {
    const baseKey = getNodeKey(node);
    const count = counts.get(baseKey) || 0;
    counts.set(baseKey, count + 1);
    return {
      key: `${baseKey}||idx_${count}`,
      node
    };
  });
}

function computeStateDiff(before, after, allTabsBefore, allTabsAfter) {
  const diff = {};
  
  // 1. URL change
  if (before && after && before.url !== after.url) {
    diff.urlChanged = true;
    diff.fromUrl = before.url;
    diff.toUrl = after.url;
  }
  
  // 2. New popups/tabs
  const newTabIds = allTabsAfter.filter(id => !allTabsBefore.includes(id));
  if (newTabIds.length > 0) {
    diff.newPopups = [];
  }
  
  // 3. Focus change
  if (before && after) {
    const beforeFocus = before.focusedNode;
    const afterFocus = after.focusedNode;
    if (JSON.stringify(beforeFocus) !== JSON.stringify(afterFocus)) {
      diff.focusChanged = true;
      diff.focusedElement = afterFocus ? {
        ref: afterFocus.ref,
        tag: afterFocus.tag,
        role: afterFocus.role,
        name: afterFocus.name
      } : null;
    }
  }
  
  // 4. Accessibility tree changes (added/removed/changed interactive elements)
  if (before?.tree?.nodes && after?.tree?.nodes) {
    const beforeNodes = before.tree.nodes;
    const afterNodes = after.tree.nodes;
    
    const beforeKeyed = keyNodes(beforeNodes);
    const afterKeyed = keyNodes(afterNodes);
    
    const beforeMap = new Map(beforeKeyed.map(item => [item.key, item.node]));
    const afterMap = new Map(afterKeyed.map(item => [item.key, item.node]));
    
    const added = [];
    const removed = [];
    const changed = [];
    
    for (const [key, afterNode] of afterMap) {
      const beforeNode = beforeMap.get(key);
      if (!beforeNode) {
        added.push({
          tag: afterNode.tag,
          role: afterNode.role,
          name: afterNode.name,
          text: afterNode.text,
          value: afterNode.value
        });
      } else {
        const valBefore = beforeNode.value;
        const valAfter = afterNode.value;
        if (valBefore !== valAfter) {
          changed.push({
            tag: afterNode.tag,
            role: afterNode.role,
            name: afterNode.name,
            fromValue: valBefore,
            toValue: valAfter
          });
        }
      }
    }
    
    for (const [key, beforeNode] of beforeMap) {
      if (!afterMap.has(key)) {
        removed.push({
          tag: beforeNode.tag,
          role: beforeNode.role,
          name: beforeNode.name,
          text: beforeNode.text
        });
      }
    }
    
    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      diff.a11yDiff = {};
      if (added.length > 0) diff.a11yDiff.added = added;
      if (removed.length > 0) diff.a11yDiff.removed = removed;
      if (changed.length > 0) diff.a11yDiff.changed = changed;
    }
  }
  
  return diff;
}

export async function wrapWithActionObserver(method, params, handler, pageHandlers, chromeApi = chrome) {
  // `observe: false` opts out entirely. The expensive full-tree a11y diff is
  // opt-in via `a11yDiff: true` (or `observe: 'full'`); by default the observer
  // only reports URL/title, popups, and a cheap focused-element delta.
  if (!OBSERVED_METHODS.has(method) || params.observe === false) {
    return handler(params);
  }

  const tabId = Number.isInteger(params.tabId) ? params.tabId : null;
  if (!tabId) {
    return handler(params);
  }

  const includeTree = params.a11yDiff === true || params.observe === 'full';

  // 1. Capture before-state
  const allTabsBefore = (await chromeApi.tabs.query({}).catch(() => [])).map(t => t.id);
  const beforeState = await captureTabState(tabId, pageHandlers, chromeApi, includeTree);

  // 2. Execute original handler
  const result = await handler(params);

  // 3. Wait for URL / state update to propagate
  await new Promise(resolve => setTimeout(resolve, 100));
  let tab = await chromeApi.tabs.get(tabId).catch(() => null);
  if (tab && tab.status === 'loading') {
    let retries = 20; // up to 2 seconds
    while (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
      tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status !== 'loading') break;
      retries--;
    }
  }

  // 4. Capture after-state
  const allTabsAfter = (await chromeApi.tabs.query({}).catch(() => [])).map(t => t.id);
  const afterState = await captureTabState(tabId, pageHandlers, chromeApi, includeTree);

  // 5. Compute differences
  const diff = computeStateDiff(beforeState, afterState, allTabsBefore, allTabsAfter);
  
  // For new popups, resolve metadata
  if (diff.newPopups) {
    const newTabIds = allTabsAfter.filter(id => !allTabsBefore.includes(id));
    for (const id of newTabIds) {
      try {
        const t = await chromeApi.tabs.get(id);
        diff.newPopups.push({
          tabId: t.id,
          url: t.url,
          title: t.title
        });
      } catch {
        // Ignore
      }
    }
  }

  // 6. Enrich response
  if (result && typeof result === 'object') {
    result.whatChanged = diff;
  }

  return result;
}
