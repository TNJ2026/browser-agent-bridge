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
  resolveFrameTarget,
  networkEventsByTab,
  dialogsByTab,
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

  async function pageWaitForNavigation(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForNavigation');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const waitUntil = params.waitUntil === 'commit' ? 'commit' : 'load';
    const initialTab = await chromeApi.tabs.get(tabId);
    const initialUrl = initialTab.url || '';
    const started = Date.now();

    while (Date.now() - started <= timeoutMs) {
      const tab = await chromeApi.tabs.get(tabId);
      const url = tab.url || '';
      const changed = url !== initialUrl;
      const urlMatched = matchesUrlPattern(url, params);
      const reachedState = waitUntil === 'commit' ? changed : tab.status === 'complete';
      if ((changed || hasUrlPattern(params)) && urlMatched && reachedState) {
        return { ok: true, tab: normalizeTab(tab), url, waitUntil, elapsedMs: Date.now() - started };
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for navigation${describeUrlPattern(params)}`);
  }

  async function pageWaitForResponse(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForResponse');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const status = Number.isInteger(params.status) ? params.status : null;
    const method = typeof params.method === 'string' && params.method ? params.method.toUpperCase() : null;
    const resourceType = typeof params.resourceType === 'string' && params.resourceType ? params.resourceType.toLowerCase() : null;
    const responseHeaderContains = normalizeHeaderMatcher(params.responseHeaderContains ?? params.headerContains, 'page.waitForResponse headerContains');
    const responseHeaderRegex = normalizeHeaderMatcher(params.responseHeaderRegex ?? params.headerRegex, 'page.waitForResponse headerRegex', { regex: true });
    const started = Date.now();
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const events = networkEventsByTab?.get(tabId) || [];
      const match = findMatchingResponse(events, { ...params, status, method, resourceType, responseHeaderContains, responseHeaderRegex, started });
      if (match) return { ok: true, response: match, elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for response${describeUrlPattern(params)}`);
  }

  async function pageWaitForRequest(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForRequest');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const method = typeof params.method === 'string' && params.method ? params.method.toUpperCase() : null;
    const resourceType = typeof params.resourceType === 'string' && params.resourceType ? params.resourceType.toLowerCase() : null;
    const requestHeaderContains = normalizeHeaderMatcher(params.requestHeaderContains ?? params.headerContains, 'page.waitForRequest headerContains');
    const requestHeaderRegex = normalizeHeaderMatcher(params.requestHeaderRegex ?? params.headerRegex, 'page.waitForRequest headerRegex', { regex: true });
    const postDataContains = normalizeOptionalNonEmptyString(params.postDataContains, 'page.waitForRequest postDataContains');
    const postDataRegex = normalizeOptionalRegexString(params.postDataRegex, 'page.waitForRequest postDataRegex');
    const started = Date.now();
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const events = networkEventsByTab?.get(tabId) || [];
      const match = findMatchingRequest(events, { ...params, method, resourceType, requestHeaderContains, requestHeaderRegex, postDataContains, postDataRegex, started });
      if (match) return { ok: true, request: match, elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for request${describeUrlPattern(params)}`);
  }

  async function pageWaitForURL(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForURL');
    if (!hasUrlPattern(params)) throw new Error('page.waitForURL requires url, urlContains, or urlRegex');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();

    while (Date.now() - started <= timeoutMs) {
      const tab = await chromeApi.tabs.get(tabId);
      const url = tab.url || '';
      if (matchesUrlPattern(url, params)) {
        return { ok: true, tab: normalizeTab(tab), url, elapsedMs: Date.now() - started };
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for URL${describeUrlPattern(params)}`);
  }

  async function pageWaitForNetworkIdle(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForNetworkIdle');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const idleMs = Number.isInteger(params.idleMs) && params.idleMs > 0 ? params.idleMs : 500;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const maxInflight = Number.isInteger(params.maxInflight) && params.maxInflight >= 0 ? params.maxInflight : 0;
    const started = Date.now();
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const events = networkEventsByTab?.get(tabId) || [];
      const state = computeNetworkIdleState(events, { started, now: Date.now() });
      if (state.inflight <= maxInflight && Date.now() - state.lastActivityAt >= idleMs) {
        return { ok: true, inflight: state.inflight, idleMs, maxInflight, elapsedMs: Date.now() - started };
      }
      await sleep(intervalMs);
    }
    const state = computeNetworkIdleState(networkEventsByTab?.get(tabId) || [], { started, now: Date.now() });
    throw new Error(`Timed out waiting for network idle (inflight: ${state.inflight})`);
  }

  async function pageWaitForDialog(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForDialog');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    await attachDebugger(tabId);
    await cdp(tabId, 'Page.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const dialog = dialogsByTab?.get(tabId);
      if (dialog && matchesDialog(dialog, params)) {
        return { ok: true, dialog: normalizeDialog(dialog), elapsedMs: Date.now() - started };
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for dialog${describeDialogPattern(params)}`);
  }

  async function pageAcceptDialog(params) {
    return pageHandleDialog(params, true, 'page.acceptDialog');
  }

  async function pageDismissDialog(params) {
    return pageHandleDialog(params, false, 'page.dismissDialog');
  }

  async function pageHandleDialog(params, accept, methodName) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, methodName);
    await attachDebugger(tabId);
    await cdp(tabId, 'Page.enable').catch(() => {});
    const dialog = dialogsByTab?.get(tabId) || null;
    const commandParams = { accept };
    if (accept && typeof params.promptText === 'string') commandParams.promptText = params.promptText;
    await cdp(tabId, 'Page.handleJavaScriptDialog', commandParams);
    dialogsByTab?.delete(tabId);
    await recordAction(tabId, methodName, { accept, promptText: params.promptText || null }, dialog ? normalizeDialog(dialog) : null);
    return { ok: true, dialog: dialog ? normalizeDialog(dialog) : null };
  }

  async function pageFrames(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.frames');
    const frames = await chromeApi.webNavigation.getAllFrames({ tabId });
    return {
      frames: frames
        .sort((a, b) => a.frameId - b.frameId)
        .map(frame => ({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          processId: frame.processId,
          url: frame.url || '',
          errorOccurred: frame.errorOccurred === true
        }))
    };
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
    const frameTarget = await resolveFrameTarget(tabId, params);

    while (Date.now() - started <= timeoutMs) {
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: frameTarget.target,
        func: (selector, visible, frameSelector) => {
          const root = resolveDomRoot(frameSelector);
          const element = querySelectorDeep(root, selector);
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
            const frame = querySelectorDeep(document, frameSelector);
            if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
            try {
              if (!frame.contentDocument) throw new Error('Frame document is not accessible');
              return frame.contentDocument;
            } catch {
              throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
            }
          }

          function querySelectorDeep(root, selector) {
            return querySelectorAllDeep(root, selector)[0] || null;
          }

          function querySelectorAllDeep(root, selector) {
            const results = [];
            const visited = new Set();
            visitRoot(root);
            return results;

            function visitRoot(currentRoot) {
              if (!currentRoot || visited.has(currentRoot)) return;
              visited.add(currentRoot);
              if (typeof currentRoot.querySelectorAll === 'function') {
                results.push(...currentRoot.querySelectorAll(selector));
                for (const element of currentRoot.querySelectorAll('*')) {
                  if (element.shadowRoot) visitRoot(element.shadowRoot);
                }
              }
            }
          }
        },
        args: [params.selector, visible, frameTarget.frameSelector],
        world: 'MAIN'
      });
      last = result;
      if (result?.found) return { ok: true, element: result, frame: frameTarget.frame, elapsedMs: Date.now() - started };
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
    const frameTarget = await resolveFrameTarget(tabId, params);

    while (Date.now() - started <= timeoutMs) {
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: frameTarget.target,
        func: (text, selector, exact, caseSensitive, frameSelector) => {
          const doc = resolveDomRoot(frameSelector);
          const root = selector ? querySelectorDeep(doc, selector) : doc.body;
          if (!root) return { found: false, selectorFound: false };
          const source = composedText(root);
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
            const frame = querySelectorDeep(document, frameSelector);
            if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
            try {
              if (!frame.contentDocument) throw new Error('Frame document is not accessible');
              return frame.contentDocument;
            } catch {
              throw new Error(`Frame is not accessible, likely cross-origin: ${frameSelector}`);
            }
          }

          function composedText(root) {
            const parts = [];
            visit(root);
            return parts.join(' ');

            function visit(node) {
              if (!node) return;
              if (node.nodeType === Node.TEXT_NODE) {
                const value = node.textContent.trim();
                if (value) parts.push(value);
                return;
              }
              if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
              if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) visit(node.shadowRoot);
              for (const child of node.childNodes || []) visit(child);
            }
          }

          function querySelectorDeep(root, selector) {
            return querySelectorAllDeep(root, selector)[0] || null;
          }

          function querySelectorAllDeep(root, selector) {
            const results = [];
            const visited = new Set();
            visitRoot(root);
            return results;

            function visitRoot(currentRoot) {
              if (!currentRoot || visited.has(currentRoot)) return;
              visited.add(currentRoot);
              if (typeof currentRoot.querySelectorAll === 'function') {
                results.push(...currentRoot.querySelectorAll(selector));
                for (const element of currentRoot.querySelectorAll('*')) {
                  if (element.shadowRoot) visitRoot(element.shadowRoot);
                }
              }
            }
          }
        },
        args: [params.text, selector, exact, caseSensitive, frameTarget.frameSelector],
        world: 'MAIN'
      });
      if (result?.found) return { ok: true, match: result, frame: frameTarget.frame, elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for text: ${params.text}`);
  }

  async function pageReadText(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.readText');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: () => {
        return {
          url: location.href,
          title: document.title,
          text: composedText(document.body || document.documentElement),
          selection: String(getSelection?.() || '')
        };

        function composedText(root) {
          const parts = [];
          visit(root);
          return parts.join(' ');

          function visit(node) {
            if (!node) return;
            if (node.nodeType === Node.TEXT_NODE) {
              const value = node.textContent.trim();
              if (value) parts.push(value);
              return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
            if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) visit(node.shadowRoot);
            for (const child of node.childNodes || []) visit(child);
          }
        }
      },
      world: 'MAIN'
    });
    return { ...result, frame: frameTarget.frame };
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
    const frameTarget = await resolveFrameTarget(tabId, params);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: script => {
        return Promise.resolve((0, eval)(script));
      },
      args: [params.script],
      world: params.world === 'isolated' ? 'ISOLATED' : 'MAIN'
    });
    return { value: result, frame: frameTarget.frame };
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
    pageWaitForNavigation,
    pageWaitForResponse,
    pageWaitForRequest,
    pageWaitForURL,
    pageWaitForNetworkIdle,
    pageWaitForDialog,
    pageAcceptDialog,
    pageDismissDialog,
    pageFrames,
    pageWaitForSelector,
    pageWaitForText,
    pageReadText,
    pageAccessibilityTree,
    pageScreenshot,
    pageExecuteJavaScript,
    pageDomSnapshot
  };
}

function findMatchingResponse(events, options) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.timestamp < options.started) break;
    if (event.method !== 'Network.responseReceived') continue;
    const params = event.params || {};
    const response = params.response || {};
    const url = response.url || '';
    if (!matchesUrlPattern(url, options)) continue;
    if (options.status !== null && response.status !== options.status) continue;
    if (options.resourceType && String(params.type || '').toLowerCase() !== options.resourceType) continue;
    if (!headersMatch(response.headers || {}, options.responseHeaderContains, 'contains')) continue;
    if (!headersMatch(response.headers || {}, options.responseHeaderRegex, 'regex')) continue;
    if (options.method) {
      const requestMethod = findRequestMethod(events, params.requestId, i);
      if (requestMethod !== options.method) continue;
    }
    return {
      requestId: params.requestId || '',
      url,
      status: response.status,
      statusText: response.statusText || '',
      mimeType: response.mimeType || '',
      resourceType: params.type || '',
      method: findRequestMethod(events, params.requestId, i) || null,
      fromDiskCache: response.fromDiskCache === true,
      fromServiceWorker: response.fromServiceWorker === true,
      ...(options.includeHeaders === true ? { headers: redactHeaderMap(response.headers || {}) } : {}),
      timestamp: event.timestamp
    };
  }
  return null;
}

function findMatchingRequest(events, options) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.timestamp < options.started) break;
    if (event.method !== 'Network.requestWillBeSent') continue;
    const params = event.params || {};
    const request = params.request || {};
    const url = request.url || '';
    if (!matchesUrlPattern(url, options)) continue;
    if (options.method && String(request.method || '').toUpperCase() !== options.method) continue;
    if (options.resourceType && String(params.type || '').toLowerCase() !== options.resourceType) continue;
    if (!headersMatch(request.headers || {}, options.requestHeaderContains, 'contains')) continue;
    if (!headersMatch(request.headers || {}, options.requestHeaderRegex, 'regex')) continue;
    if (!postDataMatches(request.postData || '', options)) continue;
    return {
      requestId: params.requestId || '',
      url,
      method: request.method || '',
      resourceType: params.type || '',
      documentURL: params.documentURL || '',
      hasPostData: request.hasPostData === true,
      ...(options.includeHeaders === true ? { headers: redactHeaderMap(request.headers || {}) } : {}),
      timestamp: event.timestamp
    };
  }
  return null;
}

function postDataMatches(postData, options) {
  if (options.postDataContains != null && !postData.includes(options.postDataContains)) return false;
  if (options.postDataRegex != null && !(new RegExp(options.postDataRegex)).test(postData)) return false;
  return true;
}

function normalizeHeaderMatcher(headers, label, { regex = false } = {}) {
  if (headers == null) return null;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(headers);
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  return Object.fromEntries(entries.map(([name, value]) => {
    if (!name) throw new Error(`${label} contains an empty header name`);
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${name} must be a non-empty string`);
    if (regex) {
      try {
        new RegExp(value);
      } catch {
        throw new Error(`${label}.${name} must be a valid regular expression`);
      }
    }
    return [name, value];
  }));
}

function normalizeOptionalNonEmptyString(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function normalizeOptionalRegexString(value, label) {
  const normalized = normalizeOptionalNonEmptyString(value, label);
  if (normalized == null) return null;
  try {
    new RegExp(normalized);
  } catch {
    throw new Error(`${label} must be a valid regular expression`);
  }
  return normalized;
}

function headersMatch(headers, matchers, mode) {
  if (!matchers) return true;
  for (const [name, expected] of Object.entries(matchers)) {
    const actual = headerValue(headers, name);
    if (actual == null) return false;
    if (mode === 'regex') {
      if (!(new RegExp(expected)).test(actual)) return false;
    } else if (!actual.includes(expected)) {
      return false;
    }
  }
  return true;
}

function headerValue(headers, name) {
  const actualName = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return actualName ? String(headers[actualName]) : null;
}

function redactHeaderMap(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    isSensitiveHeaderName(name) && value !== null ? '[redacted]' : value
  ]));
}

function isSensitiveHeaderName(name) {
  return ['authorization', 'cookie', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-auth-token'].includes(String(name).toLowerCase());
}

function computeNetworkIdleState(events, options) {
  const inflight = new Map();
  let lastActivityAt = options.started;
  for (const event of events) {
    if (event.timestamp < options.started) continue;
    if (!event.method?.startsWith('Network.')) continue;
    lastActivityAt = Math.max(lastActivityAt, event.timestamp);
    const requestId = event.params?.requestId;
    if (!requestId) continue;
    if (event.method === 'Network.requestWillBeSent') {
      inflight.set(requestId, event);
    } else if (
      event.method === 'Network.loadingFinished' ||
      event.method === 'Network.loadingFailed' ||
      event.method === 'Network.responseReceived'
    ) {
      if (event.method !== 'Network.responseReceived') inflight.delete(requestId);
    }
  }
  return { inflight: inflight.size, lastActivityAt: Math.min(lastActivityAt, options.now) };
}

function matchesDialog(dialog, params) {
  if (typeof params.type === 'string' && params.type && dialog.type !== params.type) return false;
  if (typeof params.message === 'string' && params.message && dialog.message !== params.message) return false;
  if (typeof params.messageContains === 'string' && params.messageContains && !String(dialog.message || '').includes(params.messageContains)) return false;
  if (typeof params.messageRegex === 'string' && params.messageRegex) {
    try {
      if (!new RegExp(params.messageRegex).test(dialog.message || '')) return false;
    } catch {
      throw new Error(`Invalid messageRegex: ${params.messageRegex}`);
    }
  }
  return true;
}

function normalizeDialog(dialog) {
  return {
    type: dialog.type || '',
    message: dialog.message || '',
    defaultPrompt: dialog.defaultPrompt || '',
    url: dialog.url || '',
    timestamp: dialog.timestamp
  };
}

function describeDialogPattern(params) {
  if (typeof params.type === 'string' && params.type) return ` of type: ${params.type}`;
  if (typeof params.message === 'string' && params.message) return ` with message: ${params.message}`;
  if (typeof params.messageContains === 'string' && params.messageContains) return ` with message containing: ${params.messageContains}`;
  if (typeof params.messageRegex === 'string' && params.messageRegex) return ` with message regex: ${params.messageRegex}`;
  return '';
}

function findRequestMethod(events, requestId, beforeIndex) {
  if (!requestId) return null;
  for (let i = beforeIndex; i >= 0; i -= 1) {
    const event = events[i];
    if (event.method !== 'Network.requestWillBeSent') continue;
    if (event.params?.requestId !== requestId) continue;
    return String(event.params?.request?.method || '').toUpperCase() || null;
  }
  return null;
}

function hasUrlPattern(params) {
  return Boolean(params.url || params.urlContains || params.urlRegex);
}

function matchesUrlPattern(url, params) {
  if (typeof params.url === 'string' && params.url && url !== params.url) return false;
  if (typeof params.urlContains === 'string' && params.urlContains && !url.includes(params.urlContains)) return false;
  if (typeof params.urlRegex === 'string' && params.urlRegex) {
    try {
      if (!new RegExp(params.urlRegex).test(url)) return false;
    } catch {
      throw new Error(`Invalid urlRegex: ${params.urlRegex}`);
    }
  }
  return true;
}

function describeUrlPattern(params) {
  if (typeof params.url === 'string' && params.url) return ` for URL: ${params.url}`;
  if (typeof params.urlContains === 'string' && params.urlContains) return ` for URL containing: ${params.urlContains}`;
  if (typeof params.urlRegex === 'string' && params.urlRegex) return ` for URL regex: ${params.urlRegex}`;
  return '';
}
