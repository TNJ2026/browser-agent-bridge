export function createLocatorHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  attachDebugger,
  cdp,
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
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...params, index, actionKind: 'click' }, 'actionability')
      : await waitForLocatorActionable(tabId, { ...params, index }, 'click');
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point for locator ${describeLocator(params)}`);
    await dispatchRealClick(tabId, target.element.clickPoint, params);
    const result = { element: target.element };
    await recordAction(tabId, 'locator.click', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null }, result);
    return { ok: true, element: result.element, ...(params.force === true ? {} : { actionability: target.actionability }) };
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
        (actionKind !== 'click' || checks.receivesEvents === true) &&
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

  async function dispatchRealClick(tabId, point, params) {
    await attachDebugger(tabId);
    const button = params.button || 'left';
    const clickCount = Number.isInteger(params.clickCount) && params.clickCount > 0 ? params.clickCount : 1;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none'
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button,
      clickCount
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button,
      clickCount
    });
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
          if (locator.role && locator.includeHidden !== true && isHiddenForRole(element)) return false;
          if (locator.role && inferredRole(element) !== locator.role.toLowerCase()) return false;
          if (locator.name && !matchesText(accessibleName(element, root), locator.name, locator)) return false;
          if (locator.text && !matchesText(visibleText(element), locator.text, locator)) return false;
          if (locator.placeholder && !matchesText(element.getAttribute('placeholder') || '', locator.placeholder, locator)) return false;
          if (locator.visible === true && !isVisible(element)) return false;
          if (locator.visible === false && isVisible(element)) return false;
          if (locator.level !== null && headingLevel(element) !== locator.level) return false;
          if (locator.checked !== null && ariaBooleanState(element, 'checked') !== locator.checked) return false;
          if (locator.disabled !== null && !matchesDisabled(element, locator.disabled)) return false;
          if (locator.expanded !== null && ariaBooleanState(element, 'expanded') !== locator.expanded) return false;
          if (locator.pressed !== null && ariaBooleanState(element, 'pressed') !== locator.pressed) return false;
          if (locator.selected !== null && ariaBooleanState(element, 'selected') !== locator.selected) return false;
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
          const clickPoint = clickablePoint(element, root);
          const hitTarget = actionKind === 'click' && clickPoint ? hitTestElement(element, root, clickPoint) : { receivesEvents: true };
          const reasons = [];
          if (!visible) reasons.push('not visible');
          if (!enabled) reasons.push('disabled');
          if (actionKind === 'click' && !pointerEvents) reasons.push('pointer-events none');
          if (actionKind === 'click' && !hitTarget.receivesEvents) reasons.push(`covered by ${hitTarget.description || 'another element'}`);
          if (actionKind === 'fill' && !editable) reasons.push('not editable');
          return {
            visible,
            enabled,
            editable,
            pointerEvents,
            receivesEvents: hitTarget.receivesEvents,
            hitTarget: hitTarget.description || null,
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
            checked: ariaBooleanState(element, 'checked'),
            expanded: ariaBooleanState(element, 'expanded'),
            pressed: ariaBooleanState(element, 'pressed'),
            selected: ariaBooleanState(element, 'selected'),
            level: headingLevel(element),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            rect: viewportRect(element, root),
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
          return {
            x: frameRect.x + rect.x,
            y: frameRect.y + rect.y,
            width: rect.width,
            height: rect.height
          };
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

        function accessibleName(element, root) {
          if (isAriaHidden(element)) return '';
          return accessibleNameInternal(element, root, new Set()).trim().replace(/\s+/g, ' ');
        }

        function accessibleNameInternal(element, root, visited) {
          if (!element || visited.has(element)) return '';
          visited.add(element);
          const labelledBy = element.getAttribute('aria-labelledby');
          if (labelledBy) {
            const value = labelledBy.split(/\s+/)
              .map(id => root.getElementById(id))
              .filter(Boolean)
              .map(label => accessibleNameInternal(label, root, visited) || visibleText(label))
              .join(' ')
              .trim();
            if (value) return value;
          }
          const aria = element.getAttribute('aria-label');
          if (aria) return aria.trim();
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (element.id) {
            const label = root.querySelector(`label[for="${cssEscape(element.id)}"]`);
            if (label) return visibleText(label);
          }
          const wrappingLabel = element.closest('label');
          if (wrappingLabel) return visibleText(wrappingLabel);
          if (tag === 'img' || tag === 'area') return element.getAttribute('alt') || '';
          if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return element.value || element.getAttribute('value') || defaultInputButtonName(type);
          if (tag === 'button') return visibleText(element);
          if (tag === 'fieldset') {
            const legend = Array.from(element.children).find(child => child.tagName?.toLowerCase() === 'legend');
            if (legend) return visibleText(legend);
          }
          if (tag === 'table') {
            const caption = element.querySelector(':scope > caption');
            if (caption) return visibleText(caption);
          }
          return [
            element.getAttribute('title'),
            element.getAttribute('placeholder'),
            visibleText(element),
            'value' in element ? String(element.value) : ''
          ].filter(Boolean).join(' ').trim();
        }

        function inferredRole(element) {
          const explicit = firstExplicitRole(element);
          if (explicit) return explicit;
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'a' && element.hasAttribute('href')) return 'link';
          if (tag === 'area' && element.hasAttribute('href')) return 'link';
          if (tag === 'button' || ['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
          if (tag === 'textarea' || (tag === 'input' && ['email', 'password', 'tel', 'text', 'url', ''].includes(type))) return 'textbox';
          if (tag === 'input' && type === 'search') return 'searchbox';
          if (tag === 'input' && type === 'checkbox') return 'checkbox';
          if (tag === 'input' && type === 'radio') return 'radio';
          if (tag === 'input' && type === 'range') return 'slider';
          if (tag === 'input' && ['number'].includes(type)) return 'spinbutton';
          if (tag === 'option') return 'option';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          if (tag === 'article') return 'article';
          if (tag === 'aside') return 'complementary';
          if (tag === 'body') return 'document';
          if (tag === 'form' && accessibleName(element, root)) return 'form';
          if (tag === 'main') return 'main';
          if (tag === 'nav') return 'navigation';
          if (tag === 'section' && accessibleName(element, root)) return 'region';
          if (tag === 'ul' || tag === 'ol') return 'list';
          if (tag === 'li') return 'listitem';
          if (tag === 'table') return 'table';
          if (tag === 'th') return 'columnheader';
          if (tag === 'td') return 'cell';
          if (tag === 'tr') return 'row';
          if (tag === 'summary') return 'button';
          if (tag === 'details') return 'group';
          if (tag === 'dialog') return 'dialog';
          if (tag === 'progress') return 'progressbar';
          if (tag === 'meter') return 'meter';
          return '';
        }

        function firstExplicitRole(element) {
          const role = element.getAttribute('role');
          if (!role) return '';
          const token = role.trim().split(/\s+/).find(Boolean);
          if (!token || token === 'none' || token === 'presentation') return '';
          return token.toLowerCase();
        }

        function headingLevel(element) {
          const ariaLevel = Number.parseInt(element.getAttribute('aria-level') || '', 10);
          if (Number.isInteger(ariaLevel)) return ariaLevel;
          const tag = element.tagName.toLowerCase();
          return /^h[1-6]$/.test(tag) ? Number.parseInt(tag.slice(1), 10) : null;
        }

        function ariaBooleanState(element, state) {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (state === 'checked' && tag === 'input' && ['checkbox', 'radio'].includes(type)) return element.checked;
          if (state === 'selected' && tag === 'option') return element.selected;
          if (state === 'expanded' && tag === 'details') return element.open;
          const value = element.getAttribute(`aria-${state}`);
          if (value === 'true') return true;
          if (value === 'false') return false;
          return null;
        }

        function matchesDisabled(element, expected) {
          return expected ? !isEnabled(element) : isEnabled(element);
        }

        function defaultInputButtonName(type) {
          if (type === 'submit') return 'Submit';
          if (type === 'reset') return 'Reset';
          return '';
        }

        function visibleText(element) {
          if (isAriaHidden(element)) return '';
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
            !element.closest('[hidden]') &&
            !isAriaHidden(element);
        }

        function isAriaHidden(element) {
          return Boolean(element.closest('[aria-hidden="true"]'));
        }

        function isHiddenForRole(element) {
          return !isVisible(element) || isAriaHidden(element);
        }

        function isEnabled(element) {
          return !Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('fieldset[disabled]'));
        }

        function isEditable(element) {
          if (!isEnabled(element)) return false;
          if (element.isContentEditable) return true;
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (!['input', 'textarea', 'select'].includes(tag)) return false;
          if (element.readOnly) return false;
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
            '[aria-checked]',
            '[aria-disabled]',
            '[aria-expanded]',
            '[aria-pressed]',
            '[aria-selected]',
            '[contenteditable="true"]',
            '[contenteditable=""]',
            '[tabindex]',
            'article',
            'aside',
            'area[href]',
            'dialog',
            'fieldset',
            'form',
            'main',
            'meter',
            'nav',
            'progress',
            'section',
            'summary',
            'table',
            'th',
            'td',
            'tr',
            'ul',
            'ol',
            'li',
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
      includeHidden: params.includeHidden === true || nested.includeHidden === true,
      visible: booleanOrNull(params.visible, nested.visible),
      checked: booleanOrNull(params.checked, nested.checked),
      disabled: booleanOrNull(params.disabled, nested.disabled),
      expanded: booleanOrNull(params.expanded, nested.expanded),
      pressed: booleanOrNull(params.pressed, nested.pressed),
      selected: booleanOrNull(params.selected, nested.selected),
      level: integerOrNull(params.level, nested.level)
    };
    if (!locator.selector && !locator.text && !locator.role && !locator.name && !locator.label && !locator.placeholder) {
      throw new Error('locator requires one of selector, text, role, name, label, or placeholder');
    }
    return locator;
  }

  function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function booleanOrNull(value, nestedValue) {
    if (typeof value === 'boolean') return value;
    if (typeof nestedValue === 'boolean') return nestedValue;
    return null;
  }

  function integerOrNull(value, nestedValue) {
    if (Number.isInteger(value)) return value;
    if (Number.isInteger(nestedValue)) return nestedValue;
    return null;
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
