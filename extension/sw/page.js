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
  waitForNetworkActivity = null,
  waitForDialogActivity = null,
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
    const result = await waitForTabUpdateMatch(tabId, timeoutMs, intervalMs, tab => {
      const url = tab.url || '';
      const changed = url !== initialUrl;
      const urlMatched = matchesUrlPattern(url, params);
      const reachedState = waitUntil === 'commit' ? changed : tab.status === 'complete';
      return (changed || hasUrlPattern(params)) && urlMatched && reachedState;
    });
    if (result.matched) {
      const url = result.tab.url || '';
      return { ok: true, tab: normalizeTab(result.tab), url, waitUntil, elapsedMs: Date.now() - started };
    }
    const lastUrl = result.tab?.url || initialUrl;
    const lastStatus = result.tab?.status || initialTab.status || null;
    throw createPageWaitTimeoutError({
      type: 'PageWaitForNavigationTimeout',
      code: 'PAGE_WAIT_FOR_NAVIGATION_TIMEOUT',
      method: 'page.waitForNavigation',
      elapsedMs: Date.now() - started,
      timeoutMs,
      waitUntil,
      initialUrl,
      currentUrl: lastUrl,
      currentStatus: lastStatus,
      urlChanged: lastUrl !== initialUrl,
      urlPattern: describeUrlPattern(params) || null,
      summary: `no matching navigation${describeUrlPattern(params)} (current=${lastUrl || '<empty>'})`
    });
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
    const mimeType = typeof params.mimeType === 'string' && params.mimeType ? params.mimeType.toLowerCase() : null;
    const minSize = Number.isInteger(params.minSize) && params.minSize >= 0 ? params.minSize : null;
    const maxSize = Number.isInteger(params.maxSize) && params.maxSize >= 0 ? params.maxSize : null;
    const bodyContains = normalizeOptionalNonEmptyString(params.bodyContains, 'page.waitForResponse bodyContains');
    const bodyRegex = normalizeOptionalRegexString(params.bodyRegex, 'page.waitForResponse bodyRegex');
    const jsonPath = normalizeOptionalNonEmptyString(params.jsonPath, 'page.waitForResponse jsonPath');
    const jsonContains = normalizeOptionalNonEmptyString(params.jsonContains, 'page.waitForResponse jsonContains');
    const jsonEquals = 'jsonEquals' in params ? params.jsonEquals : undefined;
    const started = Date.now();
    const waitOptions = { ...params, status, method, resourceType, responseHeaderContains, responseHeaderRegex, mimeType, minSize, maxSize, bodyContains, bodyRegex, jsonPath, jsonContains, jsonEquals, started };
    const needsBody = !!(bodyContains || bodyRegex || jsonPath);
    const needsFinished = needsBody || minSize !== null || maxSize !== null;
    const bodyCache = new Map();
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const events = networkEventsByTab?.get(tabId) || [];
      for (const candidate of collectMatchingResponses(events, waitOptions)) {
        // size and body filters need the response body to have finished loading.
        const finished = needsFinished ? findLoadingFinished(events, candidate.requestId, candidate.index) : null;
        if (needsFinished && !finished) continue;
        if (minSize !== null && finished.encodedDataLength < minSize) continue;
        if (maxSize !== null && finished.encodedDataLength > maxSize) continue;

        let bodyText = null;
        if (needsBody) {
          bodyText = await fetchResponseBodyText(tabId, candidate.requestId, bodyCache);
          if (!responseBodyMatches(bodyText, waitOptions)) continue;
        }

        const response = { ...candidate.summary };
        if (finished) response.encodedDataLength = finished.encodedDataLength;
        if (needsBody) {
          response.bodyMatched = true;
          response.bodyBytes = bodyText.length;
          if (params.includeBody === true) response.bodyPreview = bodyText.slice(0, 2000);
        }
        return { ok: true, response, elapsedMs: Date.now() - started };
      }
      await waitForNetworkEvent(tabId, intervalMs);
    }
    throw createNetworkWaitTimeoutError('response', params, waitOptions, networkEventsByTab?.get(tabId) || [], Date.now() - started);
  }

  async function fetchResponseBodyText(tabId, requestId, cache) {
    if (!requestId) return null;
    if (cache.has(requestId)) return cache.get(requestId);
    let text = null;
    try {
      const result = await cdp(tabId, 'Network.getResponseBody', { requestId });
      if (result && typeof result.body === 'string') {
        text = result.base64Encoded ? decodeBase64ToText(result.body) : result.body;
      }
    } catch {
      text = null;
    }
    cache.set(requestId, text);
    return text;
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
    const waitOptions = { ...params, method, resourceType, requestHeaderContains, requestHeaderRegex, postDataContains, postDataRegex, started };
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});

    while (Date.now() - started <= timeoutMs) {
      const events = networkEventsByTab?.get(tabId) || [];
      const match = findMatchingRequest(events, waitOptions);
      if (match) return { ok: true, request: match, elapsedMs: Date.now() - started };
      await waitForNetworkEvent(tabId, intervalMs);
    }
    throw createNetworkWaitTimeoutError('request', params, waitOptions, networkEventsByTab?.get(tabId) || [], Date.now() - started);
  }

  async function pageWaitForURL(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForURL');
    if (!hasUrlPattern(params)) throw new Error('page.waitForURL requires url, urlContains, or urlRegex');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    const result = await waitForTabUpdateMatch(tabId, timeoutMs, intervalMs, tab => matchesUrlPattern(tab.url || '', params));
    if (result.matched) {
      const url = result.tab.url || '';
      return { ok: true, tab: normalizeTab(result.tab), url, elapsedMs: Date.now() - started };
    }
    const lastUrl = result.tab?.url || '';
    throw createPageWaitTimeoutError({
      type: 'PageWaitForURLTimeout',
      code: 'PAGE_WAIT_FOR_URL_TIMEOUT',
      method: 'page.waitForURL',
      elapsedMs: Date.now() - started,
      timeoutMs,
      currentUrl: lastUrl,
      urlPattern: describeUrlPattern(params) || null,
      summary: `url did not match${describeUrlPattern(params)} (current=${lastUrl || '<empty>'})`
    });
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
      await waitForNetworkEvent(tabId, Math.min(intervalMs, idleMs));
    }
    const state = computeNetworkIdleState(networkEventsByTab?.get(tabId) || [], { started, now: Date.now() });
    throw createPageWaitTimeoutError({
      type: 'PageWaitForNetworkIdleTimeout',
      code: 'PAGE_WAIT_FOR_NETWORK_IDLE_TIMEOUT',
      method: 'page.waitForNetworkIdle',
      elapsedMs: Date.now() - started,
      timeoutMs,
      idleMs,
      maxInflight,
      inflight: state.inflight,
      msSinceLastActivity: Math.max(0, Date.now() - state.lastActivityAt),
      summary: `network still busy (inflight=${state.inflight}, need <=${maxInflight})`
    });
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
      await waitForDialogEvent(tabId, intervalMs);
    }
    throw createPageWaitTimeoutError({
      type: 'PageWaitForDialogTimeout',
      code: 'PAGE_WAIT_FOR_DIALOG_TIMEOUT',
      method: 'page.waitForDialog',
      elapsedMs: Date.now() - started,
      timeoutMs,
      summary: `no matching dialog${describeDialogPattern(params)}`
    });
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
    const frameTarget = await resolveFrameTarget(tabId, params);

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, visible, frameSelector, timeoutMs, intervalMs) => {
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const observers = [];
          let done = false;
          let last = null;
          let checkQueued = false;
          let observedRoots = new Set();

          const timeoutId = setTimeout(() => finish(last || { found: false }), timeoutMs);
          const fallbackId = setInterval(check, intervalMs);

          function finish(value) {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            clearInterval(fallbackId);
            for (const observer of observers) observer.disconnect();
            resolve(value);
          }

          function fail(error) {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            clearInterval(fallbackId);
            for (const observer of observers) observer.disconnect();
            reject(error);
          }

          function queueCheck() {
            if (checkQueued || done) return;
            checkQueued = true;
            setTimeout(() => {
              checkQueued = false;
              check();
            }, 0);
          }

          function observeCurrentRoots(root) {
            const roots = collectObservableRoots(root);
            let changed = roots.length !== observedRoots.size;
            for (const rootItem of roots) {
              if (!observedRoots.has(rootItem)) changed = true;
            }
            if (!changed) return;
            for (const observer of observers) observer.disconnect();
            observers.length = 0;
            observedRoots = new Set(roots);
            for (const rootItem of roots) {
              const observer = new MutationObserver(queueCheck);
              observer.observe(rootItem, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
              });
              observers.push(observer);
            }
          }

          function check() {
            if (done) return;
            try {
              const root = resolveDomRoot(frameSelector);
              observeCurrentRoots(root);
              last = inspect(root);
              if (last?.found) finish(last);
              else if (Date.now() - started >= timeoutMs) finish(last || { found: false });
            } catch (error) {
              fail(error);
            }
          }

          function inspect(root) {
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
          }

          check();

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

          function collectObservableRoots(root) {
            const roots = [];
            const visited = new Set();
            visitRoot(root);
            return roots;

            function visitRoot(currentRoot) {
              if (!currentRoot || visited.has(currentRoot)) return;
              visited.add(currentRoot);
              roots.push(currentRoot);
              if (typeof currentRoot.querySelectorAll !== 'function') return;
              for (const element of currentRoot.querySelectorAll('*')) {
                if (element.shadowRoot) visitRoot(element.shadowRoot);
              }
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
        });
      },
      args: [params.selector, visible, frameTarget.frameSelector, timeoutMs, intervalMs],
      world: 'MAIN'
    });

    if (result?.found) return { ok: true, element: result, frame: frameTarget.frame, elapsedMs: Date.now() - started };
    const last = result;
    const foundInDom = !!(last && last.tagName);
    throw createPageWaitTimeoutError({
      type: 'PageWaitForSelectorTimeout',
      code: 'PAGE_WAIT_FOR_SELECTOR_TIMEOUT',
      method: 'page.waitForSelector',
      elapsedMs: Date.now() - started,
      timeoutMs,
      selector: params.selector,
      requireVisible: visible,
      foundInDom,
      visible: last?.visible ?? null,
      tagName: last?.tagName ?? null,
      frame: frameTarget?.frame || null,
      summary: foundInDom && last.visible === false
        ? `selector "${params.selector}" found but not visible`
        : `selector "${params.selector}" not found`
    });
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

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (text, selector, exact, caseSensitive, frameSelector, timeoutMs, intervalMs) => {
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const observers = [];
          let done = false;
          let last = null;
          let checkQueued = false;
          let observedRoots = new Set();

          const timeoutId = setTimeout(() => finish(last || { found: false, selectorFound: selector ? false : true }), timeoutMs);
          const fallbackId = setInterval(check, intervalMs);

          function finish(value) {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            clearInterval(fallbackId);
            for (const observer of observers) observer.disconnect();
            resolve(value);
          }

          function fail(error) {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            clearInterval(fallbackId);
            for (const observer of observers) observer.disconnect();
            reject(error);
          }

          function queueCheck() {
            if (checkQueued || done) return;
            checkQueued = true;
            setTimeout(() => {
              checkQueued = false;
              check();
            }, 0);
          }

          function observeCurrentRoots(root) {
            const roots = collectObservableRoots(root);
            let changed = roots.length !== observedRoots.size;
            for (const rootItem of roots) {
              if (!observedRoots.has(rootItem)) changed = true;
            }
            if (!changed) return;
            for (const observer of observers) observer.disconnect();
            observers.length = 0;
            observedRoots = new Set(roots);
            for (const rootItem of roots) {
              const observer = new MutationObserver(queueCheck);
              observer.observe(rootItem, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
              });
              observers.push(observer);
            }
          }

          function check() {
            if (done) return;
            try {
              const doc = resolveDomRoot(frameSelector);
              observeCurrentRoots(doc);
              last = inspect(doc);
              if (last?.found) finish(last);
              else if (Date.now() - started >= timeoutMs) finish(last || { found: false, selectorFound: selector ? false : true });
            } catch (error) {
              fail(error);
            }
          }

          function inspect(doc) {
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
          }

          check();

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

          function collectObservableRoots(root) {
            const roots = [];
            const visited = new Set();
            visitRoot(root);
            return roots;

            function visitRoot(currentRoot) {
              if (!currentRoot || visited.has(currentRoot)) return;
              visited.add(currentRoot);
              roots.push(currentRoot);
              if (typeof currentRoot.querySelectorAll !== 'function') return;
              for (const element of currentRoot.querySelectorAll('*')) {
                if (element.shadowRoot) visitRoot(element.shadowRoot);
              }
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
        });
      },
      args: [params.text, selector, exact, caseSensitive, frameTarget.frameSelector, timeoutMs, intervalMs],
      world: 'MAIN'
    });

    if (result?.found) return { ok: true, match: result, frame: frameTarget.frame, elapsedMs: Date.now() - started };
    const last = result;
    const scopeMissing = !!(selector && last && last.selectorFound === false);
    throw createPageWaitTimeoutError({
      type: 'PageWaitForTextTimeout',
      code: 'PAGE_WAIT_FOR_TEXT_TIMEOUT',
      method: 'page.waitForText',
      elapsedMs: Date.now() - started,
      timeoutMs,
      text: params.text,
      exact,
      caseSensitive,
      selector: selector || null,
      selectorFound: last ? last.selectorFound === true : null,
      observedTextLength: last?.textLength ?? null,
      preview: last?.preview ?? null,
      frame: frameTarget?.frame || null,
      summary: scopeMissing
        ? `scope selector "${selector}" not found`
        : `text not found: ${String(params.text).slice(0, 80)}`
    });
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

  async function pageAriaSnapshot(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.ariaSnapshot');
    const { nodes, tree } = await collectAriaTree(tabId, params);
    return { snapshot: renderAriaSnapshot(tree), tree, nodeCount: countAriaNodes(tree), axNodeCount: nodes.length };
  }

  async function pageExpectAriaSnapshot(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.page.toMatchAriaSnapshot');
    const expected = typeof params.expected === 'string' && params.expected ? params.expected : params.snapshot;
    assertString(expected, 'expected');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const started = Date.now();
    let actual = '';

    while (Date.now() - started <= timeoutMs) {
      const { tree } = await collectAriaTree(tabId, params);
      actual = renderAriaSnapshot(tree);
      if (ariaSnapshotMatches(actual, expected)) {
        return { ok: true, assertion: 'toMatchAriaSnapshot', elapsedMs: Date.now() - started };
      }
      await sleep(intervalMs);
    }
    throw createPageWaitTimeoutError({
      type: 'PageExpectAriaSnapshotTimeout',
      code: 'PAGE_EXPECT_ARIA_SNAPSHOT_TIMEOUT',
      method: 'expect.page.toMatchAriaSnapshot',
      elapsedMs: Date.now() - started,
      timeoutMs,
      missing: ariaSnapshotMissingLines(actual, expected),
      actualPreview: actual.slice(0, 2000),
      summary: 'aria snapshot did not match'
    });
  }

  async function collectAriaTree(tabId, params) {
    await attachDebugger(tabId);
    await cdp(tabId, 'Accessibility.enable').catch(() => {});
    const result = await cdp(tabId, 'Accessibility.getFullAXTree', {});
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    const tree = buildAriaTree(nodes, {
      interestingOnly: params.interestingOnly !== false,
      maxDepth: Number.isInteger(params.maxDepth) && params.maxDepth > 0 ? params.maxDepth : null
    });
    return { nodes, tree };
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

  async function pageWaitForFunction(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.waitForFunction');
    const expression = typeof params.expression === 'string' && params.expression
      ? params.expression
      : params.script;
    assertString(expression, 'expression');
    await maybeEnableTemporaryCspBypass(tabId, params);
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);
    const arg = params.arg ?? null;

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (expression, arg, timeoutMs, intervalMs) => {
        return new Promise(resolve => {
          const started = Date.now();
          let last = null;

          const timeoutId = setTimeout(() => finish(last || { ok: true, truthy: false, value: undefined }), timeoutMs);
          const intervalId = setInterval(check, intervalMs);

          function finish(value) {
            clearTimeout(timeoutId);
            clearInterval(intervalId);
            resolve(value);
          }

          function check() {
            last = evaluate(expression, arg);
            if (last?.ok && last.truthy) finish(last);
            else if (Date.now() - started >= timeoutMs) finish(last || { ok: true, truthy: false, value: undefined });
          }

          function evaluate(expression, arg) {
            try {
              const evaluated = (0, eval)(`(${expression})`);
              const value = typeof evaluated === 'function' ? evaluated(arg) : evaluated;
              const safe = value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
              return { ok: true, truthy: !!value, value: safe };
            } catch (error) {
              return { ok: false, error: String((error && error.message) || error) };
            }
          }

          check();
        });
      },
      args: [expression, arg, timeoutMs, intervalMs],
      world: params.world === 'isolated' ? 'ISOLATED' : 'MAIN'
    });

    if (result?.ok && result.truthy) {
      return { ok: true, value: result.value, frame: frameTarget.frame, elapsedMs: Date.now() - started };
    }
    const last = result;
    throw createPageWaitTimeoutError({
      type: 'PageWaitForFunctionTimeout',
      code: 'PAGE_WAIT_FOR_FUNCTION_TIMEOUT',
      method: 'page.waitForFunction',
      elapsedMs: Date.now() - started,
      timeoutMs,
      lastError: last && last.ok === false ? last.error : null,
      frame: frameTarget?.frame || null,
      summary: last && last.ok === false ? `predicate threw: ${last.error}` : 'predicate did not become truthy'
    });
  }

  async function pageExpectTitle(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.page.toHaveTitle');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    const result = await waitForTabUpdateMatch(tabId, timeoutMs, intervalMs, tab => matchesTitlePattern(tab.title || '', params));
    if (result.matched) {
      const title = result.tab.title || '';
      return { ok: true, assertion: 'toHaveTitle', title, elapsedMs: Date.now() - started };
    }
    const lastTitle = result.tab?.title || '';
    throw createPageWaitTimeoutError({
      type: 'PageExpectTitleTimeout',
      code: 'PAGE_EXPECT_TITLE_TIMEOUT',
      method: 'expect.page.toHaveTitle',
      elapsedMs: Date.now() - started,
      timeoutMs,
      actual: lastTitle,
      expected: params.title ?? params.titleContains ?? params.titleRegex ?? null,
      summary: `title did not match (current="${lastTitle}")`
    });
  }

  async function pageAddInitScript(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.addInitScript');
    assertString(params.script, 'script');
    await attachDebugger(tabId);
    await cdp(tabId, 'Page.enable').catch(() => {});
    const result = await cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: params.script,
      ...(typeof params.worldName === 'string' && params.worldName ? { worldName: params.worldName } : {}),
      runImmediately: params.runImmediately === true
    });
    await recordAction(tabId, 'page.addInitScript', { script: params.script });
    return { ok: true, identifier: result?.identifier || null };
  }

  async function pageRemoveInitScript(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.removeInitScript');
    assertString(params.identifier, 'identifier');
    await attachDebugger(tabId);
    await cdp(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: params.identifier });
    return { ok: true, identifier: params.identifier };
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

  async function pageSetViewport(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.setViewport');
    if (!Number.isInteger(params.width) || params.width <= 0 || !Number.isInteger(params.height) || params.height <= 0) {
      throw new Error('page.setViewport requires positive integer width and height');
    }
    await attachDebugger(tabId);
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: params.width,
      height: params.height,
      deviceScaleFactor: Number.isFinite(params.deviceScaleFactor) && params.deviceScaleFactor > 0 ? params.deviceScaleFactor : 1,
      mobile: params.mobile === true
    });
    return { ok: true, width: params.width, height: params.height };
  }

  async function pageEmulateMedia(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.emulateMedia');
    await attachDebugger(tabId);
    const features = [];
    if (typeof params.colorScheme === 'string') features.push({ name: 'prefers-color-scheme', value: params.colorScheme === 'no-preference' ? '' : params.colorScheme });
    if (typeof params.reducedMotion === 'string') features.push({ name: 'prefers-reduced-motion', value: params.reducedMotion === 'no-preference' ? '' : params.reducedMotion });
    if (typeof params.forcedColors === 'string') features.push({ name: 'forced-colors', value: params.forcedColors });
    await cdp(tabId, 'Emulation.setEmulatedMedia', {
      media: typeof params.media === 'string' ? params.media : '',
      features
    });
    return { ok: true };
  }

  async function pageSetGeolocation(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.setGeolocation');
    if (!Number.isFinite(params.latitude) || !Number.isFinite(params.longitude)) {
      throw new Error('page.setGeolocation requires numeric latitude and longitude');
    }
    await attachDebugger(tabId);
    await cdp(tabId, 'Emulation.setGeolocationOverride', {
      latitude: params.latitude,
      longitude: params.longitude,
      accuracy: Number.isFinite(params.accuracy) ? params.accuracy : 100
    });
    return { ok: true, latitude: params.latitude, longitude: params.longitude };
  }

  async function pageSetLocale(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.setLocale');
    await attachDebugger(tabId);
    if (typeof params.locale === 'string' && params.locale) {
      await cdp(tabId, 'Emulation.setLocaleOverride', { locale: params.locale });
    }
    if (typeof params.timezone === 'string' && params.timezone) {
      await cdp(tabId, 'Emulation.setTimezoneOverride', { timezoneId: params.timezone });
    }
    return { ok: true, locale: params.locale || null, timezone: params.timezone || null };
  }

  async function pageSetOffline(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.setOffline');
    const offline = params.offline === true;
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});
    await cdp(tabId, 'Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    return { ok: true, offline };
  }

  async function pageClearEmulation(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'page.clearEmulation');
    await attachDebugger(tabId);
    await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await cdp(tabId, 'Emulation.clearGeolocationOverride').catch(() => {});
    await cdp(tabId, 'Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {});
    await cdp(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    return { ok: true };
  }

  async function waitForTabUpdateMatch(tabId, timeoutMs, intervalMs, predicate) {
    const eventApi = chromeApi.tabs?.onUpdated;
    if (!eventApi?.addListener || !eventApi?.removeListener) {
      let lastTab = await chromeApi.tabs.get(tabId);
      const started = Date.now();
      while (Date.now() - started <= timeoutMs) {
        if (predicate(lastTab)) return { matched: true, tab: lastTab };
        await sleep(intervalMs);
        lastTab = await chromeApi.tabs.get(tabId);
      }
      return { matched: predicate(lastTab), tab: lastTab };
    }

    let lastTab = await chromeApi.tabs.get(tabId);
    if (predicate(lastTab)) return { matched: true, tab: lastTab };

    return new Promise(resolve => {
      let done = false;
      let checking = false;
      let checkAgain = false;
      const fallbackMs = Math.max(intervalMs, 1000);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const fallback = setInterval(() => {
        check().catch(() => finish(false));
      }, fallbackMs);
      const listener = (updatedTabId) => {
        if (updatedTabId !== tabId) return;
        check().catch(() => finish(false));
      };

      eventApi.addListener(listener);

      async function check() {
        if (done) return;
        if (checking) {
          checkAgain = true;
          return;
        }
        checking = true;
        try {
          do {
            checkAgain = false;
            lastTab = await chromeApi.tabs.get(tabId);
            if (predicate(lastTab)) {
              finish(true);
              return;
            }
          } while (checkAgain && !done);
        } finally {
          checking = false;
        }
      }

      function finish(matched) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(fallback);
        eventApi.removeListener(listener);
        resolve({ matched, tab: lastTab });
      }
    });
  }

  async function waitForNetworkEvent(tabId, timeoutMs) {
    if (typeof waitForNetworkActivity === 'function') return waitForNetworkActivity(tabId, timeoutMs);
    return sleep(timeoutMs);
  }

  async function waitForDialogEvent(tabId, timeoutMs) {
    if (typeof waitForDialogActivity === 'function') return waitForDialogActivity(tabId, timeoutMs);
    return sleep(timeoutMs);
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
    pageWaitForFunction,
    pageExpectTitle,
    pageAddInitScript,
    pageRemoveInitScript,
    pageReadText,
    pageAccessibilityTree,
    pageAriaSnapshot,
    pageExpectAriaSnapshot,
    pageScreenshot,
    pageExecuteJavaScript,
    pageDomSnapshot,
    pageSetViewport,
    pageEmulateMedia,
    pageSetGeolocation,
    pageSetLocale,
    pageSetOffline,
    pageClearEmulation
  };
}

function matchesTitlePattern(title, params) {
  if (typeof params.title === 'string') return title === params.title;
  if (typeof params.titleContains === 'string') return title.includes(params.titleContains);
  if (typeof params.titleRegex === 'string') {
    try {
      return new RegExp(params.titleRegex).test(title);
    } catch {
      return false;
    }
  }
  return false;
}

// --- ARIA snapshot (built from CDP Accessibility.getFullAXTree) ---

const ARIA_TRANSPARENT_ROLES = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'group']);
const ARIA_SNAPSHOT_PROPS = ['level', 'checked', 'expanded', 'selected', 'pressed', 'disabled', 'required'];

// Transform the flat AX node list into a compact nested {role, name, props, children}
// tree, dropping ignored nodes and transparent wrappers (their children are promoted).
function buildAriaTree(axNodes, options = {}) {
  const byId = new Map();
  for (const node of axNodes) byId.set(node.nodeId, node);
  const childIds = new Set();
  for (const node of axNodes) for (const id of node.childIds || []) childIds.add(id);
  const roots = axNodes.filter(node => !childIds.has(node.nodeId));
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : null;

  function visit(node, depth) {
    if (!node) return [];
    const children = (maxDepth !== null && depth >= maxDepth)
      ? []
      : (node.childIds || []).flatMap(id => visit(byId.get(id), depth + 1));
    const role = node.role?.value || '';
    const ignored = node.ignored === true;
    if (ignored || (options.interestingOnly !== false && ARIA_TRANSPARENT_ROLES.has(role))) {
      return children; // promote children, drop the wrapper
    }
    const name = typeof node.name?.value === 'string' ? node.name.value.trim() : '';
    if (role === 'StaticText' || role === 'text') {
      return name ? [{ role: 'text', name, children: [] }] : children;
    }
    return [{ role: role || 'unknown', name, ...extractAriaProps(node), children }];
  }
  return roots.flatMap(node => visit(node, 0));
}

function extractAriaProps(node) {
  const out = {};
  for (const prop of node.properties || []) {
    if (!ARIA_SNAPSHOT_PROPS.includes(prop.name)) continue;
    const value = prop.value?.value;
    if (value === undefined || value === false || value === 'false') continue;
    out[prop.name] = value === 'true' ? true : value;
  }
  return out;
}

function renderAriaSnapshot(tree, indent = 0) {
  return tree.map(node => {
    const name = node.name ? ` "${node.name}"` : '';
    const props = ARIA_SNAPSHOT_PROPS
      .filter(prop => node[prop] !== undefined)
      .map(prop => (node[prop] === true ? `[${prop}]` : `[${prop}=${node[prop]}]`))
      .join('');
    const head = `${'  '.repeat(indent)}- ${node.role}${name}${props}`;
    const kids = node.children && node.children.length ? `\n${renderAriaSnapshot(node.children, indent + 1)}` : '';
    return head + kids;
  }).join('\n');
}

function countAriaNodes(tree) {
  return tree.reduce((sum, node) => sum + 1 + countAriaNodes(node.children || []), 0);
}

function normalizeAriaLines(text) {
  return String(text).split('\n').map(line => line.replace(/^\s*-?\s*/, '').trim()).filter(Boolean);
}

// Expected lines must appear, in order, as substrings of actual lines (subsequence).
function ariaSnapshotMatches(actual, expected) {
  return ariaSnapshotMissingLines(actual, expected).length === 0;
}

function ariaSnapshotMissingLines(actual, expected) {
  const have = normalizeAriaLines(actual);
  const want = normalizeAriaLines(expected);
  const missing = [];
  let cursor = 0;
  for (const wantLine of want) {
    let found = false;
    for (let i = cursor; i < have.length; i += 1) {
      if (have[i].includes(wantLine)) { cursor = i + 1; found = true; break; }
    }
    if (!found) missing.push(wantLine);
  }
  return missing;
}
function responseMetadataMatches(event, events, options, index) {
  if (event.method !== 'Network.responseReceived') return false;
  const params = event.params || {};
  const response = params.response || {};
  const url = response.url || '';
  if (!matchesUrlPattern(url, options)) return false;
  if (options.status !== null && response.status !== options.status) return false;
  if (options.resourceType && String(params.type || '').toLowerCase() !== options.resourceType) return false;
  if (options.mimeType && !String(response.mimeType || '').toLowerCase().includes(options.mimeType)) return false;
  if (!headersMatch(response.headers || {}, options.responseHeaderContains, 'contains')) return false;
  if (!headersMatch(response.headers || {}, options.responseHeaderRegex, 'regex')) return false;
  if (options.method) {
    const requestMethod = findRequestMethod(events, params.requestId, index);
    if (requestMethod !== options.method) return false;
  }
  return true;
}

function summarizeResponseMatch(event, events, options, index) {
  const params = event.params || {};
  const response = params.response || {};
  return {
    requestId: params.requestId || '',
    url: response.url || '',
    status: response.status,
    statusText: response.statusText || '',
    mimeType: response.mimeType || '',
    resourceType: params.type || '',
    method: findRequestMethod(events, params.requestId, index) || null,
    fromDiskCache: response.fromDiskCache === true,
    fromServiceWorker: response.fromServiceWorker === true,
    ...(options.includeHeaders === true ? { headers: redactHeaderMap(response.headers || {}) } : {}),
    timestamp: event.timestamp
  };
}

// Newest-first list of metadata-matched responses. Callers that also filter on
// body/size walk this list and apply the async checks per candidate.
function collectMatchingResponses(events, options) {
  const matches = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.timestamp < options.started) break;
    if (!responseMetadataMatches(event, events, options, i)) continue;
    matches.push({
      requestId: event.params?.requestId || '',
      index: i,
      summary: summarizeResponseMatch(event, events, options, i)
    });
  }
  return matches;
}

function findLoadingFinished(events, requestId, fromIndex) {
  if (!requestId) return null;
  for (let i = fromIndex; i < events.length; i += 1) {
    const event = events[i];
    if (event.method === 'Network.loadingFinished' && event.params?.requestId === requestId) {
      return { encodedDataLength: Number(event.params?.encodedDataLength) || 0, timestamp: event.timestamp };
    }
  }
  return null;
}

function responseBodyMatches(bodyText, options) {
  if (typeof bodyText !== 'string') return false;
  if (options.bodyContains && !bodyText.includes(options.bodyContains)) return false;
  if (options.bodyRegex && !new RegExp(options.bodyRegex).test(bodyText)) return false;
  if (options.jsonPath) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return false;
    }
    const value = resolveJsonPath(parsed, options.jsonPath);
    if (value === undefined) return false;
    if (options.jsonEquals !== undefined && !jsonDeepEqual(value, options.jsonEquals)) return false;
    if (options.jsonContains != null && !String(value).includes(options.jsonContains)) return false;
  }
  return true;
}

function resolveJsonPath(root, path) {
  const tokens = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = root;
  for (const token of tokens) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

function jsonDeepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

function decodeBase64ToText(value) {
  try {
    const binString = atob(value);
    const len = binString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
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

function createNetworkWaitTimeoutError(kind, params, options, events, elapsedMs) {
  const methodName = kind === 'response' ? 'page.waitForResponse' : 'page.waitForRequest';
  const relevantEvents = recentNetworkWaitCandidates(events, kind, options);
  const diagnostic = {
    type: 'NetworkWaitTimeout',
    waitFor: kind,
    method: methodName,
    elapsedMs,
    filters: networkWaitFilters(params, options),
    observedCount: relevantEvents.length,
    recent: relevantEvents.slice(-5),
    urlPattern: describeUrlPattern(params) || null
  };
  const error = new Error(formatNetworkWaitTimeoutMessage(diagnostic));
  error.name = 'NetworkWaitTimeout';
  error.code = kind === 'response' ? 'PAGE_WAIT_FOR_RESPONSE_TIMEOUT' : 'PAGE_WAIT_FOR_REQUEST_TIMEOUT';
  error.diagnostic = diagnostic;
  return error;
}

function recentNetworkWaitCandidates(events, kind, options) {
  const method = kind === 'response' ? 'Network.responseReceived' : 'Network.requestWillBeSent';
  return events
    .filter(event => event.timestamp >= options.started && event.method === method)
    .map(event => summarizeNetworkEvent(event, kind))
    .filter(Boolean);
}

function summarizeNetworkEvent(event, kind) {
  const params = event.params || {};
  if (kind === 'response') {
    const response = params.response || {};
    return {
      requestId: params.requestId || '',
      url: response.url || '',
      status: response.status ?? null,
      resourceType: params.type || '',
      mimeType: response.mimeType || '',
      timestamp: event.timestamp
    };
  }
  const request = params.request || {};
  return {
    requestId: params.requestId || '',
    url: request.url || '',
    method: request.method || '',
    resourceType: params.type || '',
    hasPostData: request.hasPostData === true,
    timestamp: event.timestamp
  };
}

function networkWaitFilters(params, options) {
  return {
    ...(params.url ? { url: params.url } : {}),
    ...(params.urlContains ? { urlContains: params.urlContains } : {}),
    ...(params.urlRegex ? { urlRegex: params.urlRegex } : {}),
    ...(options.method ? { method: options.method } : {}),
    ...(Number.isInteger(options.status) ? { status: options.status } : {}),
    ...(options.resourceType ? { resourceType: options.resourceType } : {}),
    ...(options.requestHeaderContains ? { requestHeaderContains: Object.keys(options.requestHeaderContains) } : {}),
    ...(options.requestHeaderRegex ? { requestHeaderRegex: Object.keys(options.requestHeaderRegex) } : {}),
    ...(options.responseHeaderContains ? { responseHeaderContains: Object.keys(options.responseHeaderContains) } : {}),
    ...(options.responseHeaderRegex ? { responseHeaderRegex: Object.keys(options.responseHeaderRegex) } : {}),
    ...(options.postDataContains != null ? { postDataContains: true } : {}),
    ...(options.postDataRegex != null ? { postDataRegex: options.postDataRegex } : {}),
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(options.minSize != null ? { minSize: options.minSize } : {}),
    ...(options.maxSize != null ? { maxSize: options.maxSize } : {}),
    ...(options.bodyContains != null ? { bodyContains: true } : {}),
    ...(options.bodyRegex != null ? { bodyRegex: options.bodyRegex } : {}),
    ...(options.jsonPath != null ? { jsonPath: options.jsonPath } : {}),
    ...(options.jsonContains != null ? { jsonContains: true } : {}),
    ...(options.jsonEquals !== undefined ? { jsonEquals: options.jsonEquals } : {})
  };
}

function formatNetworkWaitTimeoutMessage(diagnostic) {
  const filters = Object.keys(diagnostic.filters).length > 0
    ? ` filters=${JSON.stringify(diagnostic.filters)}`
    : '';
  const recent = diagnostic.recent.length > 0
    ? ` recent=${diagnostic.recent.map(formatNetworkWaitCandidate).join(' | ')}`
    : ' recent=<none>';
  return `Timed out after ${diagnostic.elapsedMs}ms waiting for ${diagnostic.waitFor}${filters}; observed ${diagnostic.observedCount} matching event type(s);${recent}`;
}

function formatNetworkWaitCandidate(candidate) {
  const status = candidate.status != null ? ` ${candidate.status}` : '';
  const method = candidate.method ? ` ${candidate.method}` : '';
  const type = candidate.resourceType ? ` ${candidate.resourceType}` : '';
  return `${candidate.requestId}${method}${status}${type} ${candidate.url}`;
}

// Unified timeout error for the non-network page waits (selector, text, URL,
// navigation, network idle, dialog). Mirrors the locator/network diagnostics so
// every wait surfaces a stable `error.code` plus a structured `error.diagnostic`
// that callers (and trace tooling) can consume the same way.
function createPageWaitTimeoutError({ type, code, method, summary, ...context }) {
  const diagnostic = { type, method, ...context };
  const error = new Error(formatPageWaitTimeoutMessage(method, summary, diagnostic.elapsedMs));
  error.name = type;
  error.code = code;
  error.diagnostic = diagnostic;
  return error;
}

function formatPageWaitTimeoutMessage(method, summary, elapsedMs) {
  const tail = summary ? `: ${summary}` : '';
  return `${method} timed out after ${elapsedMs}ms${tail}`;
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
