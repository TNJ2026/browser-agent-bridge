export function createLocatorHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  sleep,
  defaultTimeoutMs,
  chromeApi = chrome
}) {
  async function locatorCount(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.count');
    const result = await runLocatorScript(tabId, params, 'query');
    return { count: result.count, visibleCount: result.visibleCount, elements: result.elements };
  }

  async function locatorTextContent(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.textContent');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const result = await runLocatorScript(tabId, { ...params, index }, 'textContent');
    return { text: result.text, element: result.element };
  }

  async function locatorWaitFor(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.waitFor');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const state = ['attached', 'visible', 'hidden', 'detached'].includes(params.state) ? params.state : 'visible';
    const started = Date.now();
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      const result = await runLocatorScript(tabId, params, 'query');
      last = result;
      const visibleCount = result.visibleCount || 0;
      const found = result.count > 0;
      if (
        (state === 'attached' && found) ||
        (state === 'visible' && visibleCount > 0) ||
        (state === 'hidden' && (!found || visibleCount === 0)) ||
        (state === 'detached' && !found)
      ) {
        return { ok: true, state, elapsedMs: Date.now() - started, count: result.count, visibleCount: result.visibleCount, elements: result.elements };
      }
      await sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for locator ${describeLocator(params)} to be ${state}${last ? ` (last count: ${last.count})` : ''}`);
  }

  async function locatorClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.click');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index }, 'click');
    const result = await runLocatorScript(tabId, { ...params, index }, 'click');
    await recordAction(tabId, 'locator.click', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null }, result);
    return { ok: true, element: result.element, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function locatorFill(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.fill');
    const text = typeof params.text === 'string' ? params.text : params.value;
    assertString(text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index, _ignoreTopLevelTextLocator: true }, 'fill');
    const result = await runLocatorScript(tabId, { ...params, fillText: text, index, _ignoreTopLevelTextLocator: true }, 'fill');
    await recordAction(tabId, 'locator.fill', { locator: locatorSpecForRecording({ ...params, _ignoreTopLevelTextLocator: true }), index, text, frameSelector: params.frameSelector || params.locator?.frameSelector || null }, result);
    return { ok: true, element: result.element, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function waitForLocatorActionable(tabId, params, actionKind) {
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    let previousRect = null;
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      const result = await runLocatorScript(tabId, { ...params, actionKind }, 'actionability');
      last = result;

      if (params.strict === true && result.count !== 1) {
        await sleep(intervalMs);
        continue;
      }

      const rect = result.element?.rect || null;
      const stable = params.stable === false || (rect && previousRect && rectsAlmostEqual(rect, previousRect));
      const checks = result.actionability || {};
      const ready = result.found &&
        checks.visible === true &&
        checks.enabled === true &&
        stable === true &&
        (actionKind !== 'fill' || checks.editable === true);

      if (ready) {
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
    throw new Error(`Timed out waiting for locator ${describeLocator(params)} to be actionable for ${actionKind}: ${reasons.join(', ')}`);
  }

  function rectsAlmostEqual(a, b) {
    return Math.abs(a.x - b.x) < 0.5 &&
      Math.abs(a.y - b.y) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5;
  }

  async function runLocatorScript(tabId, params, action) {
    const locator = normalizeLocatorParams(params);
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 200) : 50;
    const options = {
      locator,
      action,
      index,
      limit,
      text: typeof params.fillText === 'string' ? params.fillText : (typeof params.text === 'string' ? params.text : ''),
      scrollIntoView: params.scrollIntoView !== false,
      force: params.force === true,
      actionKind: params.actionKind || null
    };

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: options => {
        const root = resolveDomRoot(options.locator.frameSelector);
        const matches = findLocatorMatches(root, options.locator);
        const elements = matches.slice(0, options.limit).map((element, index) => summarizeElement(element, index));

        if (options.action === 'query') {
          return { count: matches.length, visibleCount: matches.filter(isVisible).length, elements };
        }

        const element = matches[options.index];
        if (!element) {
          if (options.action === 'actionability') {
            return {
              found: false,
              count: matches.length,
              visibleCount: matches.filter(isVisible).length,
              actionability: { visible: false, enabled: false, editable: false, reasons: ['not found'] }
            };
          }
          throw new Error(`Element not found for locator: ${describeLocator(options.locator)} at index ${options.index}`);
        }

        if (options.action === 'textContent') {
          return {
            text: (element.innerText || element.textContent || '').trim(),
            element: summarizeElement(element, options.index)
          };
        }

        if (options.scrollIntoView) element.scrollIntoView({ block: 'center', inline: 'center' });
        const actionability = getActionability(element, options.action === 'fill' ? 'fill' : (options.action === 'click' ? 'click' : options.actionKind));

        if (options.action === 'actionability') {
          return {
            found: true,
            count: matches.length,
            visibleCount: matches.filter(isVisible).length,
            element: summarizeElement(element, options.index),
            actionability
          };
        }

        if (!options.force && !actionability.actionable) {
          throw new Error(`Element is not actionable: ${actionability.reasons.join(', ')}`);
        }

        if (typeof element.focus === 'function') element.focus({ preventScroll: true });

        if (options.action === 'click') {
          element.click();
          return { element: summarizeElement(element, options.index) };
        }

        if (options.action === 'fill') {
          fillElement(element, options.text);
          return { element: summarizeElement(element, options.index) };
        }

        throw new Error(`Unsupported locator action: ${options.action}`);

        function findLocatorMatches(root, locator) {
          if (locator.label) return findByLabel(root, locator).filter(element => matchesLocator(element, locator, true));
          const candidates = locator.selector
            ? Array.from(root.querySelectorAll(locator.selector))
            : Array.from(root.querySelectorAll(candidateSelector()));
          return candidates.filter(element => matchesLocator(element, locator, false));
        }

        function matchesLocator(element, locator, labelAlreadyMatched) {
          if (!labelAlreadyMatched && locator.label && !matchesText(accessibleName(element, root), locator.label, locator)) return false;
          if (locator.role && inferredRole(element) !== locator.role.toLowerCase()) return false;
          if (locator.name && !matchesText(accessibleName(element, root), locator.name, locator)) return false;
          if (locator.text && !matchesText(visibleText(element), locator.text, locator)) return false;
          if (locator.placeholder && !matchesText(element.getAttribute('placeholder') || '', locator.placeholder, locator)) return false;
          if (locator.visible === true && !isVisible(element)) return false;
          if (locator.visible === false && isVisible(element)) return false;
          return true;
        }

        function findByLabel(root, locator) {
          const controls = [];
          for (const label of root.querySelectorAll('label')) {
            const text = visibleText(label);
            if (!matchesText(text, locator.label, locator)) continue;
            let control = null;
            const forId = label.getAttribute('for');
            if (forId) control = root.getElementById(forId);
            if (!control) control = label.querySelector('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
            if (control) controls.push(control);
          }
          for (const element of root.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
            const aria = element.getAttribute('aria-label') || '';
            const placeholder = element.getAttribute('placeholder') || '';
            if (matchesText(aria, locator.label, locator) || matchesText(placeholder, locator.label, locator)) controls.push(element);
          }
          return Array.from(new Set(controls));
        }

        function fillElement(element, text) {
          if (element.isContentEditable) {
            element.textContent = text;
          } else if ('value' in element) {
            element.value = text;
          } else {
            throw new Error('Element is not editable');
          }
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function getActionability(element, actionKind) {
          const visible = isVisible(element);
          const enabled = isEnabled(element);
          const editable = isEditable(element);
          const pointerEvents = getComputedStyle(element).pointerEvents !== 'none';
          const reasons = [];
          if (!visible) reasons.push('not visible');
          if (!enabled) reasons.push('disabled');
          if (actionKind === 'click' && !pointerEvents) reasons.push('pointer-events none');
          if (actionKind === 'fill' && !editable) reasons.push('not editable');
          return {
            visible,
            enabled,
            editable,
            pointerEvents,
            actionable: reasons.length === 0,
            reasons
          };
        }

        function summarizeElement(element, index) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            id: element.id || '',
            name: element.getAttribute('name') || '',
            role: inferredRole(element),
            type: element.getAttribute('type') || '',
            text: visibleText(element).slice(0, 500),
            value: 'value' in element ? String(element.value).slice(0, 500) : '',
            ariaLabel: element.getAttribute('aria-label') || '',
            placeholder: element.getAttribute('placeholder') || '',
            accessibleName: accessibleName(element, root).slice(0, 500),
            disabled: !isEnabled(element),
            editable: isEditable(element),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }

        function accessibleName(element, root) {
          const labelledBy = element.getAttribute('aria-labelledby');
          if (labelledBy) {
            const value = labelledBy.split(/\s+/).map(id => root.getElementById(id)?.innerText || root.getElementById(id)?.textContent || '').join(' ').trim();
            if (value) return value;
          }
          const aria = element.getAttribute('aria-label');
          if (aria) return aria.trim();
          if (element.id) {
            const label = root.querySelector(`label[for="${cssEscape(element.id)}"]`);
            if (label) return visibleText(label);
          }
          const wrappingLabel = element.closest('label');
          if (wrappingLabel) return visibleText(wrappingLabel);
          return [
            element.getAttribute('alt'),
            element.getAttribute('title'),
            element.getAttribute('placeholder'),
            visibleText(element),
            'value' in element ? String(element.value) : ''
          ].filter(Boolean).join(' ').trim();
        }

        function inferredRole(element) {
          const explicit = element.getAttribute('role');
          if (explicit) return explicit.toLowerCase();
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'a' && element.hasAttribute('href')) return 'link';
          if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset') return 'button';
          if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
          if (tag === 'textarea' || (tag === 'input' && ['email', 'password', 'search', 'tel', 'text', 'url', ''].includes(type))) return 'textbox';
          if (tag === 'input' && type === 'checkbox') return 'checkbox';
          if (tag === 'input' && type === 'radio') return 'radio';
          if (tag === 'input' && type === 'range') return 'slider';
          if (tag === 'option') return 'option';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          return '';
        }

        function visibleText(element) {
          return (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
        }

        function isVisible(element) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0' &&
            !element.hidden &&
            !element.closest('[hidden]');
        }

        function isEnabled(element) {
          return !Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('fieldset[disabled]'));
        }

        function isEditable(element) {
          if (!isEnabled(element)) return false;
          if (element.isContentEditable) return true;
          if (!('value' in element)) return false;
          if (element.readOnly) return false;
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'textarea' || tag === 'select') return true;
          if (tag !== 'input') return false;
          return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
        }

        function matchesText(value, expected, locator) {
          const source = locator.caseSensitive ? String(value) : String(value).toLowerCase();
          const needle = locator.caseSensitive ? String(expected) : String(expected).toLowerCase();
          return locator.exact ? source.trim() === needle.trim() : source.includes(needle);
        }

        function candidateSelector() {
          return [
            'a[href]',
            'button',
            'input',
            'textarea',
            'select',
            'option',
            'label',
            '[role]',
            '[aria-label]',
            '[aria-labelledby]',
            '[placeholder]',
            '[contenteditable="true"]',
            '[contenteditable=""]',
            '[tabindex]',
            'summary',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'p',
            'span',
            'div'
          ].join(',');
        }

        function cssEscape(value) {
          if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
          return String(value).replace(/["\\]/g, '\\$&');
        }

        function describeLocator(locator) {
          return ['selector', 'role', 'name', 'text', 'label', 'placeholder']
            .filter(key => locator[key])
            .map(key => `${key}=${JSON.stringify(locator[key])}`)
            .join(', ') || '<empty>';
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
      args: [options],
      world: 'MAIN'
    });
    return result;
  }

  function normalizeLocatorParams(params) {
    const nested = params.locator && typeof params.locator === 'object' ? params.locator : {};
    const pickString = key => stringOrNull(params[key]) || stringOrNull(nested[key]);
    const locator = {
      selector: pickString('selector'),
      text: params._ignoreTopLevelTextLocator ? stringOrNull(nested.text) : pickString('text'),
      role: pickString('role'),
      name: pickString('name'),
      label: pickString('label'),
      placeholder: pickString('placeholder'),
      frameSelector: pickString('frameSelector'),
      exact: params.exact === true || nested.exact === true,
      caseSensitive: params.caseSensitive === true || nested.caseSensitive === true,
      visible: typeof params.visible === 'boolean' ? params.visible : (typeof nested.visible === 'boolean' ? nested.visible : null)
    };
    if (!locator.selector && !locator.text && !locator.role && !locator.name && !locator.label && !locator.placeholder) {
      throw new Error('locator requires one of selector, text, role, name, label, or placeholder');
    }
    return locator;
  }

  function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function describeLocator(params) {
    const locator = normalizeLocatorParams(params);
    return ['selector', 'role', 'name', 'text', 'label', 'placeholder']
      .filter(key => locator[key])
      .map(key => `${key}=${JSON.stringify(locator[key])}`)
      .join(', ') || '<empty>';
  }

  function locatorSpecForRecording(params) {
    const locator = normalizeLocatorParams(params);
    return Object.fromEntries(Object.entries(locator).filter(([, value]) => value !== null));
  }

  return {
    locatorCount,
    locatorTextContent,
    locatorWaitFor,
    locatorClick,
    locatorFill
  };
}
