export function createDomHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  attachDebugger,
  cdp,
  resolveFrameTarget,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  defaultTimeoutMs = 30000,
  chromeApi = chrome
}) {
  async function domQuery(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.query');
    assertString(params.selector, 'selector');
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 200) : 50;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, limit, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        return querySelectorAllDeep(root, selector).slice(0, limit).map((element, index) => summarizeElement(element, index));

        function summarizeElement(element, index) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            id: element.id || '',
            name: element.getAttribute('name') || '',
            placeholder: element.getAttribute('placeholder') || '',
            role: element.getAttribute('role') || '',
            type: element.getAttribute('type') || '',
            text: (element.innerText || element.textContent || '').trim().slice(0, 500),
            value: 'value' in element ? String(element.value).slice(0, 500) : '',
            ariaLabel: element.getAttribute('aria-label') || '',
            href: element.href || '',
            disabled: Boolean(element.disabled),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          };
        }

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
      args: [params.selector, limit, frameTarget.frameSelector],
      world: 'MAIN'
    });
    return { elements: result || [], frame: frameTarget.frame };
  }

  async function domClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.click');
    assertString(params.selector, 'selector');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    let frameTarget = await resolveFrameTarget(tabId, params);
    const target = params.force === true ? await getDomClickTarget(tabId, params, frameTarget) : await waitForDomActionable(tabId, params, 'click', frameTarget);
    if (!target?.element?.clickPoint) {
      throw createDomNotActionableError(`Element has no clickable point: ${params.selector} at index ${index}`, { selector: params.selector, index, action: 'dom.click' });
    }
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, params);
    await dispatchRealClick(tabId, applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const result = target.element;
    await recordAction(tabId, 'dom.click', { selector: params.selector, index, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result, frame: frameTarget.frame, ...(params.force === true ? {} : { actionability: target.actionability }) };
  }

  async function domDragTo(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.dragTo');
    assertString(params.selector, 'selector');
    assertString(params.targetSelector, 'targetSelector');
    const sourceIndex = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const targetIndex = Number.isInteger(params.targetIndex) && params.targetIndex >= 0 ? params.targetIndex : 0;
    let frameTarget = await resolveFrameTarget(tabId, params);
    const source = params.force === true
      ? await getDomClickTarget(tabId, { ...params, index: sourceIndex }, frameTarget)
      : await waitForDomActionable(tabId, { ...params, index: sourceIndex }, 'click', frameTarget);
    const target = params.force === true
      ? await getDomClickTarget(tabId, { ...params, selector: params.targetSelector, index: targetIndex }, frameTarget)
      : await waitForDomActionable(tabId, { ...params, selector: params.targetSelector, index: targetIndex }, 'click', frameTarget);
    if (!source?.element?.clickPoint) {
      throw createDomNotActionableError(`Source element has no draggable point: ${params.selector} at index ${sourceIndex}`, { selector: params.selector, index: sourceIndex, action: 'dom.dragTo' });
    }
    if (!target?.element?.clickPoint) {
      throw createDomNotActionableError(`Target element has no drop point: ${params.targetSelector} at index ${targetIndex}`, { selector: params.targetSelector, index: targetIndex, action: 'dom.dragTo' });
    }
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, params);
    await dispatchRealDrag(tabId, applyFrameOffset(source.element.clickPoint, frameTarget), applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const result = { source: source.element, target: target.element };
    await recordAction(tabId, 'dom.dragTo', { selector: params.selector, index: sourceIndex, targetSelector: params.targetSelector, targetIndex, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return {
      ok: true,
      source: result.source,
      target: result.target,
      frame: frameTarget.frame,
      ...(params.force === true ? {} : { actionability: { source: source.actionability, target: target.actionability } })
    };
  }

  async function domDispatchDragDrop(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.dispatchDragDrop');
    assertString(params.selector, 'selector');
    assertString(params.targetSelector, 'targetSelector');
    const sourceIndex = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const targetIndex = Number.isInteger(params.targetIndex) && params.targetIndex >= 0 ? params.targetIndex : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, sourceIndex, targetSelector, targetIndex, data, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const source = querySelectorAllDeep(root, selector)[sourceIndex];
        const target = querySelectorAllDeep(root, targetSelector)[targetIndex];
        if (!source) throw new Error(`Source element not found: ${selector} at index ${sourceIndex}`);
        if (!target) throw new Error(`Target element not found: ${targetSelector} at index ${targetIndex}`);
        const dataTransfer = new DataTransfer();
        for (const item of normalizeDragData(data)) dataTransfer.setData(item.type, item.value);
        const sourceRect = source.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        dispatchDragEvent(source, 'dragstart', dataTransfer, sourceRect);
        dispatchDragEvent(target, 'dragenter', dataTransfer, targetRect);
        dispatchDragEvent(target, 'dragover', dataTransfer, targetRect);
        dispatchDragEvent(target, 'drop', dataTransfer, targetRect);
        dispatchDragEvent(source, 'dragend', dataTransfer, sourceRect);
        return {
          source: summarizeElement(source),
          target: summarizeElement(target),
          types: Array.from(dataTransfer.types || [])
        };

        function dispatchDragEvent(element, type, dataTransfer, rect) {
          const event = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            dataTransfer
          });
          element.dispatchEvent(event);
        }

        function normalizeDragData(data) {
          if (!data) return [];
          if (Array.isArray(data)) return data.filter(item => item && typeof item.type === 'string' && typeof item.value === 'string');
          if (typeof data === 'object') {
            return Object.entries(data)
              .filter(([, value]) => typeof value === 'string')
              .map(([type, value]) => ({ type, value }));
          }
          return [];
        }

        function summarizeElement(element) {
          const rect = element.getBoundingClientRect();
          return {
            tagName: element.tagName.toLowerCase(),
            id: element.id || '',
            text: (element.innerText || element.textContent || '').trim().slice(0, 500),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }

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
      args: [params.selector, sourceIndex, params.targetSelector, targetIndex, params.data || null, frameTarget.frameSelector],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.dispatchDragDrop', { selector: params.selector, index: sourceIndex, targetSelector: params.targetSelector, targetIndex, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, ...result, frame: frameTarget.frame };
  }

  async function domType(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.type');
    assertString(params.selector, 'selector');
    assertString(params.text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const replace = params.replace !== false;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'type', frameTarget);
    await prepareDomTextInput(tabId, params, frameTarget, replace);
    await dispatchRealTextInput(tabId, params.text);
    const result = await getDomElementSummary(tabId, params, frameTarget);
    await recordAction(tabId, 'dom.type', { selector: params.selector, index, text: params.text, replace, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domSelect(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.select');
    assertString(params.selector, 'selector');
    assertString(params.value, 'value');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'select', frameTarget);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, value, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorAllDeep(root, selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (element.tagName.toLowerCase() !== 'select') throw new Error('Element is not a select');
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        const option = element.selectedOptions[0] || null;
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName.toLowerCase(),
          value: element.value,
          text: option ? option.textContent : '',
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
      args: [params.selector, index, params.value, params.scrollIntoView !== false, frameTarget.frameSelector],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.select', { selector: params.selector, index, value: params.value, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domSetInputFiles(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.setInputFiles');
    assertString(params.selector, 'selector');
    const files = normalizeFilePaths(params);
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const markerName = 'data-browser-agent-bridge-file-input';
    const markerValue = `bab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const [{ result: prepared }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, markerName, markerValue, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorAllDeep(root, selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (element.tagName.toLowerCase() !== 'input' || (element.getAttribute('type') || '').toLowerCase() !== 'file') {
          throw new Error('Element is not an input[type=file]');
        }
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        element.setAttribute(markerName, markerValue);
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          multiple: element.multiple === true,
          disabled: element.disabled === true,
          accept: element.getAttribute('accept') || '',
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
      args: [params.selector, index, markerName, markerValue, params.scrollIntoView !== false, frameTarget.frameSelector],
      world: 'MAIN'
    });

    if (files.length > 1 && prepared.multiple !== true) {
      await clearFileInputMarker(tabId, frameTarget, markerName, markerValue).catch(() => {});
      throw new Error('Cannot set multiple files on an input without the multiple attribute');
    }

    let summary = null;
    try {
      await attachDebugger(tabId);
      await cdp(tabId, 'DOM.enable').catch(() => {});
      await cdp(tabId, 'DOM.getDocument', { depth: 0 }).catch(() => {});
      const search = await cdp(tabId, 'DOM.performSearch', {
        query: `input[${markerName}="${escapeCssAttributeValue(markerValue)}"]`,
        includeUserAgentShadowDOM: true
      });
      try {
        if (!search.resultCount) throw new Error('Unable to resolve file input through CDP DOM');
        const result = await cdp(tabId, 'DOM.getSearchResults', {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: 1
        });
        const nodeId = result.nodeIds?.[0];
        if (!nodeId) throw new Error('Unable to resolve file input node');
        await cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files });
      } finally {
        if (search.searchId) await cdp(tabId, 'DOM.discardSearchResults', { searchId: search.searchId }).catch(() => {});
      }
      summary = await summarizeFileInputAfterSet(tabId, frameTarget, markerName, markerValue);
    } catch (error) {
      await clearFileInputMarker(tabId, frameTarget, markerName, markerValue).catch(() => {});
      throw error;
    }

    await recordAction(tabId, 'dom.setInputFiles', { selector: params.selector, index, files, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, summary);
    return { ok: true, element: summary, frame: frameTarget.frame };
  }

  async function domHover(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.hover');
    assertString(params.selector, 'selector');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'hover', frameTarget);
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorAllDeep(root, selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
      
        // Dispatch mouseover/mouseenter events to simulate hover
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      
        const rect = element.getBoundingClientRect();
        return {
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
      args: [params.selector, index, params.scrollIntoView !== false, frameTarget.frameSelector],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.hover', { selector: params.selector, index, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domScroll(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.scroll');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const x = typeof params.x === 'number' ? params.x : 0;
    const y = typeof params.y === 'number' ? params.y : 0;
    const mode = params.mode === 'scrollTo' ? 'scrollTo' : 'scrollBy';
    const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';
    const frameTarget = await resolveFrameTarget(tabId, params);

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, x, y, mode, behavior, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        let target;
        if (selector) {
          target = querySelectorAllDeep(root, selector)[index];
          if (!target) throw new Error(`Element not found: ${selector} at index ${index}`);
        } else {
          target = frameSelector ? root.defaultView || root : window;
        }

        if (target.scrollBy || target.scrollTo) {
          target[mode]({ left: x, top: y, behavior });
        } else if (target.document && (target.document.documentElement || target.document.body)) {
          const docEl = target.document.documentElement || target.document.body;
          docEl[mode]({ left: x, top: y, behavior });
        } else {
          target[mode]({ left: x, top: y, behavior });
        }

        let currentX = 0;
        let currentY = 0;
        if (target === window || target.defaultView) {
          currentX = window.scrollX;
          currentY = window.scrollY;
        } else if (target) {
          currentX = target.scrollLeft;
          currentY = target.scrollTop;
        }

        return {
          scrolled: true,
          scrollLeft: currentX,
          scrollTop: currentY
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
      args: [params.selector || null, index, x, y, mode, behavior, frameTarget.frameSelector],
      world: 'MAIN'
    });

    await recordAction(tabId, 'dom.scroll', { selector: params.selector || null, index, x, y, mode, behavior, frameSelector: params.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, result, frame: frameTarget.frame };
  }

  async function waitForDomActionable(tabId, params, actionKind, frameTarget) {
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const started = Date.now();

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, scroll, frameSelector, actionKind, timeoutMs, intervalMs, requireStable, strict) => {
        return new Promise((resolve, reject) => {
          const root = resolveDomRoot(frameSelector);
          const started = Date.now();
          const observers = [];
          let done = false;
          let last = null;
          let previousRect = null;
          let checkQueued = false;
          let observedRoots = new Set();

          const timeoutId = setTimeout(() => finish(last || runCheck()), timeoutMs);
          const fallbackId = setInterval(check, intervalMs);

          // Eager check on start
          check();

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
              observeCurrentRoots(root);
              const snapshot = runCheck();
              last = snapshot;
              const satisfies = snapshot.found && snapshot.actionability?.actionable === true;
              if (satisfies) finish(snapshot);
              else if (Date.now() - started >= timeoutMs) finish(snapshot);
            } catch (error) {
              fail(error);
            }
          }

          function runCheck() {
            const matches = querySelectorAllDeep(root, selector);
            const element = matches[index];
            if (!element) {
              return {
                found: false,
                count: matches.length,
                actionability: { visible: false, enabled: false, editable: false, stable: false, actionable: false, reasons: ['not found'] }
              };
            }

            if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });

            const baseActionability = getActionability(element, root, actionKind);
            const rect = summarizeElement(element, root).rect;

            let stable = true;
            if (requireStable !== false) {
              stable = rect && previousRect && rectsAlmostEqualInPage(rect, previousRect);
            }
            if (rect) previousRect = rect;

            let actionable = baseActionability.actionable && stable;
            const reasons = [...baseActionability.reasons];
            if (!stable) reasons.push('not stable');

            if (strict === true && matches.length !== 1) {
              actionable = false;
              reasons.unshift(`strict mode expected 1 match, got ${matches.length}`);
            }

            return {
              found: true,
              count: matches.length,
              element: summarizeElement(element, root),
              actionability: {
                ...baseActionability,
                actionable,
                stable,
                reasons,
                strict: strict === true
              }
            };
          }

          function getActionability(element, root, actionKind) {
            const visible = isVisible(element);
            const enabled = isEnabled(element);
            const editable = isEditable(element);
            const selectable = element.tagName.toLowerCase() === 'select';
            const pointerEvents = getComputedStyle(element).pointerEvents !== 'none';
            const clickPoint = clickablePoint(element, root);
            const hitTarget = actionKind === 'click' && clickPoint ? hitTestElement(element, root, clickPoint) : { receivesEvents: true };
            const reasons = [];
            if (!visible) reasons.push('not visible');
            if (actionKind !== 'hover' && !enabled) reasons.push('disabled');
            if ((actionKind === 'click' || actionKind === 'hover') && !pointerEvents) reasons.push('pointer-events none');
            if (actionKind === 'click' && !hitTarget.receivesEvents) reasons.push(`covered by ${hitTarget.description || 'another element'}`);
            if (actionKind === 'type' && !editable) reasons.push('not editable');
            if (actionKind === 'select' && !selectable) reasons.push('not a select');
            return {
              visible,
              enabled,
              editable,
              selectable,
              pointerEvents,
              receivesEvents: hitTarget.receivesEvents,
              hitTarget: hitTarget.description || null,
              actionable: reasons.length === 0,
              reasons
            };
          }

          function summarizeElement(element, root) {
            const rect = viewportRect(element, root);
            return {
              tagName: element.tagName.toLowerCase(),
              text: (element.innerText || element.textContent || '').trim().slice(0, 500),
              value: 'value' in element ? String(element.value).slice(0, 500) : '',
              rect,
              clickPoint: clickablePoint(element, root)
            };
          }

          function clickablePoint(element, root) {
            const rect = viewportRect(element, root);
            if (rect.width <= 0 || rect.height <= 0) return null;
            const x = Math.min(Math.max(rect.x + rect.width / 2, 0), window.innerWidth - 1);
            const y = Math.min(Math.max(rect.y + rect.height / 2, 0), window.innerHeight - 1);
            return { x, y };
          }

          function viewportRect(element, root) {
            const rect = element.getBoundingClientRect();
            if (root === document) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            const frame = frameForRoot(root);
            if (!frame) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            const frameRect = frame.getBoundingClientRect();
            return { x: frameRect.x + rect.x, y: frameRect.y + rect.y, width: frameRect.width, height: frameRect.height };
          }

          function hitTestElement(element, root, point) {
            if (!point) return { receivesEvents: false, description: 'no clickable point' };
            if (root !== document) {
              const frame = frameForRoot(root);
              const frameHit = document.elementFromPoint(point.x, point.y);
              if (!frame || !(frameHit === frame || frame.contains(frameHit))) {
                return { receivesEvents: false, description: describeElementForHit(frameHit) };
              }
              const frameRect = frame.getBoundingClientRect();
              let localHit = root.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
              while (localHit && localHit.shadowRoot) {
                const inner = localHit.shadowRoot.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
                if (!inner || inner === localHit) break;
                localHit = inner;
              }
              return {
                receivesEvents: Boolean(localHit && (localHit === element || element.contains(localHit))),
                description: describeElementForHit(localHit)
              };
            }
            let hit = document.elementFromPoint(point.x, point.y);
            while (hit && hit.shadowRoot) {
              const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
              if (!inner || inner === hit) break;
              hit = inner;
            }
            return {
              receivesEvents: Boolean(hit && (hit === element || element.contains(hit))),
              description: describeElementForHit(hit)
            };
          }

          function frameForRoot(root) {
            for (const frame of querySelectorAllDeep(document, 'iframe,frame')) {
              try {
                if (frame.contentDocument === root) return frame;
              } catch {}
            }
            return null;
          }

          function describeElementForHit(element) {
            if (!element) return 'none';
            const id = element.id ? `#${element.id}` : '';
            const classes = typeof element.className === 'string' && element.className.trim()
              ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
              : '';
            return `${element.tagName.toLowerCase()}${id}${classes}`;
          }

          function isVisible(element) {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          }

          function isEnabled(element) {
            return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
          }

          function isEditable(element) {
            if (element.isContentEditable) return true;
            return isTextInputElement(element) && !element.readOnly && !element.disabled;
          }

          function isTextInputElement(element) {
            const tag = element.tagName.toLowerCase();
            const type = (element.getAttribute('type') || '').toLowerCase();
            if (tag === 'textarea') return true;
            if (tag !== 'input') return false;
            return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
          }

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

          function rectsAlmostEqualInPage(a, b) {
            return Math.abs(a.x - b.x) < 0.5 &&
              Math.abs(a.y - b.y) < 0.5 &&
              Math.abs(a.width - b.width) < 0.5 &&
              Math.abs(a.height - b.height) < 0.5;
          }
        });
      },
      args: [params.selector, index, params.scrollIntoView !== false, frameTarget.frameSelector, actionKind, timeoutMs, intervalMs, params.stable !== false, params.strict === true],
      world: 'MAIN'
    });

    const elapsedMs = Date.now() - started;
    if (result.found && result.actionability?.actionable === true && !(params.strict === true && result.count !== 1)) {
      return {
        ok: true,
        elapsedMs,
        element: result.element,
        actionability: result.actionability
      };
    }

    throw createDomActionabilityTimeoutError(params, actionKind, frameTarget, result, elapsedMs);
  }

  async function getDomClickTarget(tabId, params, frameTarget) {
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const matches = querySelectorAllDeep(root, selector);
        const element = matches[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        return {
          found: true,
          count: matches.length,
          element: summarizeElement(element, root),
          actionability: getActionability(element, root, 'click')
        };

        function getActionability(element, root, actionKind) {
          const visible = isVisible(element);
          const enabled = isEnabled(element);
          const editable = isEditable(element);
          const selectable = element.tagName.toLowerCase() === 'select';
          const pointerEvents = getComputedStyle(element).pointerEvents !== 'none';
          const clickPoint = clickablePoint(element, root);
          const hitTarget = actionKind === 'click' && clickPoint ? hitTestElement(element, root, clickPoint) : { receivesEvents: true };
          const reasons = [];
          if (!visible) reasons.push('not visible');
          if (actionKind !== 'hover' && !enabled) reasons.push('disabled');
          if ((actionKind === 'click' || actionKind === 'hover') && !pointerEvents) reasons.push('pointer-events none');
          if (actionKind === 'click' && !hitTarget.receivesEvents) reasons.push(`covered by ${hitTarget.description || 'another element'}`);
          if (actionKind === 'type' && !editable) reasons.push('not editable');
          if (actionKind === 'select' && !selectable) reasons.push('not a select');
          return {
            visible,
            enabled,
            editable,
            selectable,
            pointerEvents,
            receivesEvents: hitTarget.receivesEvents,
            hitTarget: hitTarget.description || null,
            actionable: reasons.length === 0,
            reasons
          };
        }

        function summarizeElement(element, root) {
          const rect = viewportRect(element, root);
          return {
            tagName: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').trim().slice(0, 500),
            value: 'value' in element ? String(element.value).slice(0, 500) : '',
            rect,
            clickPoint: clickablePoint(element, root)
          };
        }

        function clickablePoint(element, root) {
          const rect = viewportRect(element, root);
          if (rect.width <= 0 || rect.height <= 0) return null;
          const x = Math.min(Math.max(rect.x + rect.width / 2, 0), window.innerWidth - 1);
          const y = Math.min(Math.max(rect.y + rect.height / 2, 0), window.innerHeight - 1);
          return { x, y };
        }

        function viewportRect(element, root) {
          const rect = element.getBoundingClientRect();
          if (root === document) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          const frame = frameForRoot(root);
          if (!frame) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          const frameRect = frame.getBoundingClientRect();
          return { x: frameRect.x + rect.x, y: frameRect.y + rect.y, width: rect.width, height: rect.height };
        }

        function hitTestElement(element, root, point) {
          if (!point) return { receivesEvents: false, description: 'no clickable point' };
          if (root !== document) {
            const frame = frameForRoot(root);
            const frameHit = document.elementFromPoint(point.x, point.y);
            if (!frame || !(frameHit === frame || frame.contains(frameHit))) {
              return { receivesEvents: false, description: describeElementForHit(frameHit) };
            }
            const frameRect = frame.getBoundingClientRect();
            let localHit = root.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
            while (localHit && localHit.shadowRoot) {
              const inner = localHit.shadowRoot.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
              if (!inner || inner === localHit) break;
              localHit = inner;
            }
            return {
              receivesEvents: Boolean(localHit && (localHit === element || element.contains(localHit))),
              description: describeElementForHit(localHit)
            };
          }
          let hit = document.elementFromPoint(point.x, point.y);
          while (hit && hit.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
            if (!inner || inner === hit) break;
            hit = inner;
          }
          return {
            receivesEvents: Boolean(hit && (hit === element || element.contains(hit))),
            description: describeElementForHit(hit)
          };
        }

        function frameForRoot(root) {
          for (const frame of querySelectorAllDeep(document, 'iframe,frame')) {
            try {
              if (frame.contentDocument === root) return frame;
            } catch {}
          }
          return null;
        }

        function describeElementForHit(element) {
          if (!element) return 'none';
          const id = element.id ? `#${element.id}` : '';
          const classes = typeof element.className === 'string' && element.className.trim()
            ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
            : '';
          return `${element.tagName.toLowerCase()}${id}${classes}`;
        }

        function isVisible(element) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }

        function isEnabled(element) {
          return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        }

        function isEditable(element) {
          if (element.isContentEditable) return true;
          return isTextInputElement(element) && !element.readOnly && !element.disabled;
        }

        function isTextInputElement(element) {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'textarea') return true;
          if (tag !== 'input') return false;
          return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
        }

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
      args: [params.selector, index, params.scrollIntoView !== false, frameTarget.frameSelector],
      world: 'MAIN'
    });
    return result;
  }

  function applyFrameOffset(point, frameTarget) {
    if (!frameTarget?.frameOffset) return point;
    return {
      x: point.x + frameTarget.frameOffset.x,
      y: point.y + frameTarget.frameOffset.y
    };
  }

  async function prepareDomTextInput(tabId, params, frameTarget, replace) {
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, scroll, frameSelector, replace) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorAllDeep(root, selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof element.focus === 'function') element.focus({ preventScroll: true });
        if (element.isContentEditable) {
          const selection = element.ownerDocument.getSelection();
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          if (!replace) range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          return summarizeElement(element);
        }
        if (isTextInputElement(element)) {
          const length = String(element.value || '').length;
          if (typeof element.setSelectionRange === 'function') {
            element.setSelectionRange(replace ? 0 : length, length);
          } else if (typeof element.select === 'function' && replace) {
            element.select();
          }
          return summarizeElement(element);
        }
        throw new Error('Element is not editable');

        function summarizeElement(element) {
          const rect = element.getBoundingClientRect();
          return {
            tagName: element.tagName.toLowerCase(),
            value: 'value' in element ? String(element.value) : element.textContent || '',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }

        function isTextInputElement(element) {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'textarea') return true;
          if (tag !== 'input') return false;
          return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
        }

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
      args: [params.selector, index, params.scrollIntoView !== false, frameTarget.frameSelector, replace],
      world: 'MAIN'
    });
    return result;
  }

  async function getDomElementSummary(tabId, params, frameTarget) {
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (selector, index, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorAllDeep(root, selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName.toLowerCase(),
          value: 'value' in element ? String(element.value) : element.textContent || '',
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
      args: [params.selector, index, frameTarget.frameSelector],
      world: 'MAIN'
    });
    return result;
  }

  async function dispatchRealTextInput(tabId, text) {
    await attachDebugger(tabId);
    await cdp(tabId, 'Input.insertText', { text });
  }

  function normalizeFilePaths(params) {
    const value = params.files ?? params.filePaths ?? params.filePath ?? params.path;
    const files = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    for (const file of files) {
      if (typeof file !== 'string' || !file) throw new Error('dom.setInputFiles requires file path strings');
    }
    return files;
  }

  function escapeCssAttributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  async function summarizeFileInputAfterSet(tabId, frameTarget, markerName, markerValue) {
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (markerName, markerValue, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorDeep(root, `input[${markerName}="${cssEscapeAttribute(markerValue)}"]`);
        if (!element) throw new Error('Marked file input not found after setting files');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.removeAttribute(markerName);
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          multiple: element.multiple === true,
          fileCount: element.files ? element.files.length : 0,
          files: Array.from(element.files || []).map(file => ({ name: file.name, size: file.size, type: file.type })),
          value: element.value || '',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };

        function cssEscapeAttribute(value) {
          return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }

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
      args: [markerName, markerValue, frameTarget.frameSelector],
      world: 'MAIN'
    });
    return result;
  }

  async function clearFileInputMarker(tabId, frameTarget, markerName, markerValue) {
    await chromeApi.scripting.executeScript({
      target: frameTarget.target,
      func: (markerName, markerValue, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = querySelectorDeep(root, `input[${markerName}="${cssEscapeAttribute(markerValue)}"]`);
        if (element) element.removeAttribute(markerName);

        function cssEscapeAttribute(value) {
          return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }

        function resolveDomRoot(frameSelector) {
          if (!frameSelector) return document;
          const frame = querySelectorDeep(document, frameSelector);
          if (!frame) throw new Error(`Frame not found: ${frameSelector}`);
          try {
            if (!frame.contentDocument) throw new Error('Frame document is not accessible');
            return frame.contentDocument;
          } catch {
            return document;
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
      args: [markerName, markerValue, frameTarget.frameSelector],
      world: 'MAIN'
    });
  }

  async function dispatchRealClick(tabId, point, params) {
    await attachDebugger(tabId);
    const button = params.button || 'left';
    const clickCount = Number.isInteger(params.clickCount) && params.clickCount > 0 ? params.clickCount : 1;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount });
  }

  async function dispatchRealDrag(tabId, from, to, params) {
    await attachDebugger(tabId);
    const button = params.button || 'left';
    const steps = Number.isInteger(params.steps) && params.steps > 0 ? params.steps : 12;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        button,
        buttons: 1
      });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, clickCount: 1 });
  }

  function rectsAlmostEqual(a, b) {
    return Math.abs(a.x - b.x) < 0.5 &&
      Math.abs(a.y - b.y) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5;
  }

  return {
    domQuery,
    domClick,
    domDragTo,
    domDispatchDragDrop,
    domType,
    domSelect,
    domSetInputFiles,
    domHover,
    domScroll
  };
}

// Structured errors for dom.* actions, mirroring the locator diagnostics so
// every interaction surface attaches a stable error.code + error.diagnostic.
function createDomActionabilityTimeoutError(params, actionKind, frameTarget, last, elapsedMs) {
  const checks = (last && last.actionability) || {};
  const reasons = domDiagnosticReasons(last, checks, params);
  const diagnostic = {
    type: 'DomActionabilityTimeout',
    selector: params.selector,
    action: `dom.${actionKind}`,
    elapsedMs,
    count: last?.count ?? 0,
    visibleCount: last?.visibleCount ?? 0,
    index: Number.isInteger(params.index) && params.index >= 0 ? params.index : 0,
    strict: params.strict === true,
    reasons,
    actionability: { ...checks, stable: checks.stable === true },
    element: last?.element || null,
    frame: frameTarget?.frame || null
  };
  const error = new Error(`Timed out after ${elapsedMs}ms waiting for selector ${params.selector} to be actionable for dom.${actionKind}: ${reasons.join(', ')}`);
  error.name = 'DomActionabilityTimeout';
  error.code = 'DOM_ACTIONABILITY_TIMEOUT';
  error.diagnostic = diagnostic;
  return error;
}

function domDiagnosticReasons(last, checks, params) {
  const reasons = Array.isArray(checks.reasons) && checks.reasons.length > 0 ? [...checks.reasons] : [];
  if (params.strict === true && Number.isInteger(last?.count) && last.count !== 1) {
    reasons.unshift(`strict mode expected 1 match, got ${last.count}`);
  }
  if (last?.found && checks.stable !== true && params.stable !== false) reasons.push('not stable');
  if (reasons.length === 0) reasons.push(last?.found ? 'not actionable' : 'not found');
  return Array.from(new Set(reasons));
}

function createDomNotActionableError(message, diagnostic) {
  const error = new Error(message);
  error.name = 'DomElementNotActionable';
  error.code = 'DOM_ELEMENT_NOT_ACTIONABLE';
  error.diagnostic = { type: 'DomElementNotActionable', ...diagnostic };
  return error;
}
