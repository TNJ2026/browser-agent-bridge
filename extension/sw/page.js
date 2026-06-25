export function createPageHandlers({
  assertTabId,
  assertString,
  assertTabAllowed,
  assertUrlAllowed,
  maybeEnableTemporaryCspBypassForUrl,
  maybeEnableTemporaryCspBypass,
  recordAction,
  normalizeTab,
  waitForTabComplete,
  sleep,
  ensureContentScripts,
  captureTabScreenshot,
  attachDebugger,
  cdp,
  defaultTimeoutMs,
  chromeApi = chrome
}) {
  async function pageNavigate(params) {
    const tabId = assertTabId(params.tabId);
    assertString(params.url, 'url');
    await assertUrlAllowed(params.url, 'page.navigate');
    await maybeEnableTemporaryCspBypassForUrl(params.url, params);
    await recordAction(tabId, 'navigate.start', { url: params.url });
    const tab = await chromeApi.tabs.update(tabId, { url: params.url });
    if (params.wait !== false) await waitForTabComplete(tabId, params.timeoutMs);
    const result = { tab: normalizeTab(await chromeApi.tabs.get(tabId)) };
    await recordAction(tabId, 'navigate.complete', { url: params.url }, result);
    return result;
  }

  async function pageWaitForLoad(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForLoad');
    const tab = await chromeApi.tabs.get(tabId);
    if (tab.status !== 'complete') await waitForTabComplete(tabId, params.timeoutMs);
    return { tab: normalizeTab(await chromeApi.tabs.get(tabId)) };
  }

  async function pageWaitForSelector(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForSelector');
    assertString(params.selector, 'selector');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const visible = params.visible === true;
    const started = Date.now();
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: (selector, visible, frameSelector) => {
          const root = resolveDomRoot(frameSelector);
          const element = root.querySelector(selector);
          if (!element) return { found: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          return {
            found: visible ? isVisible : true,
            visible: isVisible,
            tagName: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').trim().slice(0, 500),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };

          function resolveDomRoot(frameSelector) {
            if (!frameSelector) return document;
            const frame = document.querySelector(frameSelector);
            if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
            try {
              if (!frame.contentDocument) throw new Error('Frame document is not accessible');
              return frame.contentDocument;
            } catch {
              throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
            }
          }
        },
        args: [params.selector, visible, params.frameSelector || null],
        world: 'MAIN'
      });
      last = result;
      if (result?.found) return { ok: true, element: result, elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for selector: ${params.selector}${last?.visible === false ? ' (found but not visible)' : ''}`);
  }

  async function pageWaitForText(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForText');
    assertString(params.text, 'text');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;
    const exact = params.exact === true;
    const caseSensitive = params.caseSensitive === true;
    const started = Date.now();

    while (Date.now() - started <= timeoutMs) {
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: (text, selector, exact, caseSensitive, frameSelector) => {
          const doc = resolveDomRoot(frameSelector);
          const root = selector ? doc.querySelector(selector) : doc.body;
          if (!root) return { found: false, selectorFound: false };
          const source = root.innerText || root.textContent || '';
          const haystack = caseSensitive ? source : source.toLowerCase();
          const needle = caseSensitive ? text : text.toLowerCase();
          const found = exact ? haystack.trim() === needle : haystack.includes(needle);
          return {
            found,
            selectorFound: true,
            textLength: source.length,
            preview: source.trim().slice(0, 500)
          };

          function resolveDomRoot(frameSelector) {
            if (!frameSelector) return document;
            const frame = document.querySelector(frameSelector);
            if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
            try {
              if (!frame.contentDocument) throw new Error('Frame document is not accessible');
              return frame.contentDocument;
            } catch {
              throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
            }
          }
        },
        args: [params.text, selector, exact, caseSensitive, params.frameSelector || null],
        world: 'MAIN'
      });
      if (result?.found) return { ok: true, match: result, elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for text: ${params.text}`);
  }

  async function pageReadText(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.readText');
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText || '',
        selection: String(getSelection?.() || '')
      })
    });
    return result;
  }

  async function pageAccessibilityTree(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.accessibilityTree');
  
    await ensureContentScripts(tabId, 0);
    const mainResponse = await chromeApi.tabs.sendMessage(tabId, {
      type: 'GET_ACCESSIBILITY_TREE',
      maxNodes: params.maxNodes || 1000
    }, { frameId: 0 });
  
    if (!mainResponse?.ok) throw new Error(mainResponse?.error || 'Failed to read accessibility tree');
  
    const tree = mainResponse.tree;
    const collectedIframes = tree.iframes || [];
  
    try {
      const frames = await chromeApi.webNavigation.getAllFrames({ tabId });
      frames.sort((a, b) => a.frameId - b.frameId);
    
      for (const frame of frames) {
        if (frame.frameId === 0) continue;
      
        const match = collectedIframes.find(sub => {
          if (!sub.src || !frame.url) return false;
          try {
            const subUrl = new URL(sub.src, frame.url).href;
            return subUrl === frame.url || frame.url.startsWith(subUrl) || subUrl.startsWith(frame.url);
          } catch {
            return sub.src.includes(frame.url) || frame.url.includes(sub.src);
          }
        });
      
        if (match) {
          await ensureContentScripts(tabId, frame.frameId);
          const subResponse = await chromeApi.tabs.sendMessage(tabId, {
            type: 'GET_ACCESSIBILITY_TREE',
            maxNodes: params.maxNodes || 1000,
            offsetX: match.x,
            offsetY: match.y
          }, { frameId: frame.frameId });
        
          if (subResponse?.ok && subResponse.tree?.nodes) {
            tree.nodes.push(...subResponse.tree.nodes);
            if (subResponse.tree.iframes) {
              collectedIframes.push(...subResponse.tree.iframes);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Subframe accessibility tree collection failed:', e);
    }
  
    delete tree.iframes;
    return tree;
  }

  async function pageScreenshot(params) {
    const tabId = assertTabId(params.tabId);
    const tab = await chromeApi.tabs.get(tabId);
    await assertUrlAllowed(tab.url || '', 'page.screenshot');
    const dataUrl = await captureTabScreenshot(tabId, params);
    return { dataUrl };
  }

  async function pageExecuteJavaScript(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.executeJavaScript');
    await maybeEnableTemporaryCspBypass(tabId, params);
    assertString(params.script, 'script');
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: script => {
        return Promise.resolve((0, eval)(script));
      },
      args: [params.script],
      world: params.world === 'isolated' ? 'ISOLATED' : 'MAIN'
    });
    return { value: result };
  }

  async function pageDomSnapshot(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.domSnapshot');
    await attachDebugger(tabId);
    const result = await cdp(tabId, 'DOMSnapshot.captureSnapshot', {
      computedStyles: Array.isArray(params.computedStyles) ? params.computedStyles : [],
      includeDOMRects: params.includeDOMRects !== false,
      includePaintOrder: params.includePaintOrder === true
    });
    return result;
  }

  return {
    pageNavigate,
    pageWaitForLoad,
    pageWaitForSelector,
    pageWaitForText,
    pageReadText,
    pageAccessibilityTree,
    pageScreenshot,
    pageExecuteJavaScript,
    pageDomSnapshot
  };
}
