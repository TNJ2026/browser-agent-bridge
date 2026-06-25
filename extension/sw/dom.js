export function createDomHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
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
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (selector, index, scroll, frameSelector) => {
        const root = resolveDomRoot(frameSelector);
        const element = root.querySelectorAll(selector)[index];
        if (!element) throw new Error(`Element not found: ${selector} at index ${index}`);
        if (scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof element.focus === 'function') element.focus({ preventScroll: true });
        element.click();
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
    await recordAction(tabId, 'dom.click', { selector: params.selector, index, frameSelector: params.frameSelector || null }, result);
    return { ok: true, element: result };
  }

  async function domType(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.type');
    assertString(params.selector, 'selector');
    assertString(params.text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const replace = params.replace !== false;
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
    return { ok: true, element: result };
  }

  async function domSelect(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.select');
    assertString(params.selector, 'selector');
    assertString(params.value, 'value');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
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
    return { ok: true, element: result };
  }

  async function domHover(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'dom.hover');
    assertString(params.selector, 'selector');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
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
    return { ok: true, element: result };
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

  return {
    domQuery,
    domClick,
    domType,
    domSelect,
    domHover,
    domScroll
  };
}
