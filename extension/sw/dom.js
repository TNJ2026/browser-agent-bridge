export function createDomHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  attachDebugger,
  cdp,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  defaultTimeoutMs = 30000,
  chromeApi = chrome
}) {
  async function domQuery(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.query');
    assertString(params.selector, 'selector');
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 200) : 50;
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, limit, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        return Array.from(root.querySelectorAll(selector)).slice(0, limit).map((element, index) => summarizeElement(element, index));

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
      args: [params.selector, limit, params.frameSelector || null],
      world: 'MAIN'
    });
    return { elements: result || [] };
  }

  async function domClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.click');
    assertString(params.selector, 'selector');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const target = params.force === true ? await getDomClickTarget(tabId, params) : await waitForDomActionable(tabId, params, 'click');
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point: ${params.selector} at index ${index}`);
    await dispatchRealClick(tabId, target.element.clickPoint, params);
    const result = target.element;
    await recordAction(tabId, 'dom.click', { selector: params.selector, index, frameSelector: params.frameSelector || null }, result);
    return { ok: true, element: result, ...(params.force === true ? {} : { actionability: target.actionability }) };
  }

  async function domType(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.type');
    assertString(params.selector, 'selector');
    assertString(params.text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const replace = params.replace !== false;
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'type');
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, text, replace, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = root.querySelectorAll(selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof element.focus === 'function') element.focus({ preventScroll: true });
        if (element.isContentEditable) {
          if (replace) element.textContent = text;
          else element.textContent = `${element.textContent || ''}${text}`;
        } else if ('value' in element) {
          element.value = replace ? text : `${element.value || ''}${text}`;
        } else {
          throw new Error('Element is not editable');
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName.toLowerCase(),
          value: 'value' in element ? String(element.value) : element.textContent || '',
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
      args: [params.selector, index, params.text, replace, params.scrollIntoView !== false, params.frameSelector || null],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.type', { selector: params.selector, index, text: params.text, replace, frameSelector: params.frameSelector || null }, result);
    return { ok: true, element: result, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domSelect(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.select');
    assertString(params.selector, 'selector');
    assertString(params.value, 'value');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'select');
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, value, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = root.querySelectorAll(selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a select');
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
      args: [params.selector, index, params.value, params.scrollIntoView !== false, params.frameSelector || null],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.select', { selector: params.selector, index, value: params.value, frameSelector: params.frameSelector || null }, result);
    return { ok: true, element: result, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domHover(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.hover');
    assertString(params.selector, 'selector');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const readiness = params.force === true ? null : await waitForDomActionable(tabId, params, 'hover');
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = root.querySelectorAll(selector)[index];
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
      args: [params.selector, index, params.scrollIntoView !== false, params.frameSelector || null],
      world: 'MAIN'
    });
    await recordAction(tabId, 'dom.hover', { selector: params.selector, index, frameSelector: params.frameSelector || null }, result);
    return { ok: true, element: result, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function domScroll(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.scroll');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const x = typeof params.x === 'number' ? params.x : 0;
    const y = typeof params.y === 'number' ? params.y : 0;
    const mode = params.mode === 'scrollTo' ? 'scrollTo' : 'scrollBy';
    const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, x, y, mode, behavior, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        let target;
        if (selector) {
          target = root.querySelectorAll(selector)[index];
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
      args: [params.selector || null, index, x, y, mode, behavior, params.frameSelector || null],
      world: 'MAIN'
    });

    await recordAction(tabId, 'dom.scroll', { selector: params.selector || null, index, x, y, mode, behavior, frameSelector: params.frameSelector || null }, result);
    return { ok: true, result };
  }

  async function waitForDomActionable(tabId, params, actionKind) {
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const started = Date.now();
    let previousRect = null;
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: (selector, index, scroll, frameSelector, actionKind) => {
          const root = resolveDomRoot(frameSelector);
          const matches = Array.from(root.querySelectorAll(selector));
          const element = matches[index];
          if (!element) {
            return {
              found: false,
              count: matches.length,
              actionability: { visible: false, enabled: false, editable: false, selectable: false, reasons: ['not found'] }
            };
          }
          if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
          const actionability = getActionability(element, root, actionKind);
          return {
            found: true,
            count: matches.length,
            element: summarizeElement(element, root),
            actionability
          };

          function getActionability(element, root, actionKind) {
            const visible = isVisible(element);
            const enabled = isEnabled(element);
            const editable = isEditable(element);
            const selectable = element instanceof HTMLSelectElement;
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
              const localHit = root.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
              return {
                receivesEvents: Boolean(localHit && (localHit === element || element.contains(localHit))),
                description: describeElementForHit(localHit)
              };
            }
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              receivesEvents: Boolean(hit && (hit === element || element.contains(hit))),
              description: describeElementForHit(hit)
            };
          }

          function frameForRoot(root) {
            for (const frame of document.querySelectorAll('iframe,frame')) {
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
            if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
            return !element.readOnly && !element.disabled;
          }

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
        args: [params.selector, index, params.scrollIntoView !== false, params.frameSelector || null, actionKind],
        world: 'MAIN'
      });

      last = result;
      if (params.strict === true && result.count !== 1) {
        await sleep(intervalMs);
        continue;
      }

      const rect = result.element?.rect || null;
      const stable = params.stable === false || (rect && previousRect && rectsAlmostEqual(rect, previousRect));
      const checks = result.actionability || {};
      if (result.found && checks.actionable === true && stable === true) {
        return {
          ok: true,
          elapsedMs: Date.now() - started,
          element: result.element,
          actionability: { ...checks, stable: true, strict: params.strict === true }
        };
      }

      if (rect) previousRect = rect;
      await sleep(intervalMs);
    }

    const reasons = last?.actionability?.reasons || ['not found'];
    throw new Error(`Timed out waiting for selector ${params.selector} to be actionable for dom.${actionKind}: ${reasons.join(', ')}`);
  }

  async function getDomClickTarget(tabId, params) {
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const matches = Array.from(root.querySelectorAll(selector));
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
          const selectable = element instanceof HTMLSelectElement;
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
            const localHit = root.elementFromPoint(point.x - frameRect.x, point.y - frameRect.y);
            return {
              receivesEvents: Boolean(localHit && (localHit === element || element.contains(localHit))),
              description: describeElementForHit(localHit)
            };
          }
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            receivesEvents: Boolean(hit && (hit === element || element.contains(hit))),
            description: describeElementForHit(hit)
          };
        }

        function frameForRoot(root) {
          for (const frame of document.querySelectorAll('iframe,frame')) {
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
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
          return !element.readOnly && !element.disabled;
        }

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
      args: [params.selector, index, params.scrollIntoView !== false, params.frameSelector || null],
      world: 'MAIN'
    });
    return result;
  }

  async function dispatchRealClick(tabId, point, params) {
    await attachDebugger(tabId);
    const button = params.button || 'left';
    const clickCount = Number.isInteger(params.clickCount) && params.clickCount > 0 ? params.clickCount : 1;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount });
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
    domType,
    domSelect,
    domHover,
    domScroll
  };
}
