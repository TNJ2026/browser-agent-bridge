const OBSERVED_METHODS = new Set([
  'dom.click',
  'dom.select',
  'dom.setInputFiles',
  'dom.type',
  'locator.click',
  'locator.clickRef',
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

async function captureTabState(tabId, pageHandlers, chromeApi) {
  try {
    const tab = await chromeApi.tabs.get(tabId);
    const treeResult = await pageHandlers.pageAccessibilityTree({ tabId }).catch(() => null);
    
    let focusedNode = null;
    if (treeResult?.tree?.nodes) {
      focusedNode = treeResult.tree.nodes.find(n => n.focused);
    }
    
    return {
      url: tab.url,
      title: tab.title,
      tree: treeResult?.tree || null,
      focusedNode
    };
  } catch (e) {
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
  if (!OBSERVED_METHODS.has(method)) {
    return handler(params);
  }

  const tabId = Number.isInteger(params.tabId) ? params.tabId : null;
  if (!tabId) {
    return handler(params);
  }

  // 1. Capture before-state
  const allTabsBefore = (await chromeApi.tabs.query({}).catch(() => [])).map(t => t.id);
  const beforeState = await captureTabState(tabId, pageHandlers, chromeApi);

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
  const afterState = await captureTabState(tabId, pageHandlers, chromeApi);

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
