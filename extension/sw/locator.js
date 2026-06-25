export function createLocatorHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  attachDebugger,
  cdp,
  resolveFrameTarget,
  sleep,
  defaultTimeoutMs,
  chromeApi = chrome
}) {
  async function locatorCount(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.count');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, params, 'query', frameTarget);
    return { count: result.count, visibleCount: result.visibleCount, elements: result.elements, frame: frameTarget.frame };
  }

  async function locatorTextContent(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.textContent');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, { ...params, index }, 'textContent', frameTarget);
    return { text: result.text, element: result.element, frame: frameTarget.frame };
  }

  async function locatorWaitFor(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.waitFor');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const state = ['attached', 'visible', 'hidden', 'detached'].includes(params.state) ? params.state : 'visible';
    const started = Date.now();
    let last = null;
    const frameTarget = await resolveFrameTarget(tabId, params);

    while (Date.now() - started <= timeoutMs) {
      const result = await runLocatorScript(tabId, params, 'query', frameTarget);
      last = result;
      const visibleCount = result.visibleCount || 0;
      const found = result.count > 0;
      if (
        (state === 'attached' && found) ||
        (state === 'visible' && visibleCount > 0) ||
        (state === 'hidden' && (!found || visibleCount === 0)) ||
        (state === 'detached' && !found)
      ) {
        return { ok: true, state, elapsedMs: Date.now() - started, count: result.count, visibleCount: result.visibleCount, elements: result.elements, frame: frameTarget.frame };
      }
      await sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for locator ${describeLocator(params)} to be ${state}${last ? ` (last count: ${last.count})` : ''}`);
  }

  async function locatorClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.click');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...params, index, actionKind: 'click' }, 'actionability', frameTarget)
      : await waitForLocatorActionable(tabId, { ...params, index }, 'click', frameTarget);
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point for locator ${describeLocator(params)}`);
    await dispatchRealClick(tabId, applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const result = { element: target.element };
    await recordAction(tabId, 'locator.click', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame, ...(params.force === true ? {} : { actionability: target.actionability }) };
  }

  async function locatorFill(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.fill');
    const text = typeof params.text === 'string' ? params.text : params.value;
    assertString(text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index, _ignoreTopLevelTextLocator: true }, 'fill', frameTarget);
    const prepared = await runLocatorScript(tabId, { ...params, index, replace: params.replace !== false, _ignoreTopLevelTextLocator: true }, 'prepareTextInput', frameTarget);
    const result = prepared.inputMode === 'select'
      ? await runLocatorScript(tabId, { ...params, fillText: text, index, _ignoreTopLevelTextLocator: true }, 'fill', frameTarget)
      : await dispatchRealTextInput(tabId, text, params).then(() => runLocatorScript(tabId, { ...params, index, _ignoreTopLevelTextLocator: true }, 'summarize', frameTarget));
    await recordAction(tabId, 'locator.fill', { locator: locatorSpecForRecording({ ...params, _ignoreTopLevelTextLocator: true }), index, text, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function locatorCheck(params) {
    return locatorSetChecked(params, true, 'locator.check');
  }

  async function locatorUncheck(params) {
    return locatorSetChecked(params, false, 'locator.uncheck');
  }

  async function locatorSetChecked(params, desiredChecked, actionName) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, actionName);
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...params, index, actionKind: 'click' }, 'actionability', frameTarget)
      : await waitForLocatorActionable(tabId, { ...params, index }, 'click', frameTarget);
    const before = await runLocatorScript(tabId, { ...params, index }, 'checkState', frameTarget);
    if (!before.checkable) throw new Error(`${actionName} requires a checkbox or radio-like element`);
    if (!desiredChecked && before.radio) throw new Error('locator.uncheck does not support radio buttons');
    if (before.checked === desiredChecked) {
      const result = { element: before.element, changed: false };
      await recordAction(tabId, actionName, { locator: locatorSpecForRecording(params), index, checked: desiredChecked, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
      return { ok: true, changed: false, element: before.element, frame: frameTarget.frame, ...(params.force === true ? {} : { actionability: target.actionability }) };
    }
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point for locator ${describeLocator(params)}`);
    await dispatchRealClick(tabId, applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const after = await runLocatorScript(tabId, { ...params, index }, 'checkState', frameTarget);
    if (after.checked !== desiredChecked) throw new Error(`${actionName} failed to set checked=${desiredChecked}`);
    const result = { element: after.element, changed: true };
    await recordAction(tabId, actionName, { locator: locatorSpecForRecording(params), index, checked: desiredChecked, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, changed: true, element: after.element, frame: frameTarget.frame, ...(params.force === true ? {} : { actionability: target.actionability }) };
  }

  async function locatorSelectOption(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.selectOption');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const values = normalizeSelectOptionValues(params);
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index }, 'select', frameTarget);
    const result = await runLocatorScript(tabId, { ...params, index, selectOptions: values }, 'selectOption', frameTarget);
    await recordAction(tabId, 'locator.selectOption', { locator: locatorSpecForRecording(params), index, options: values, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, selected: result.selected, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function locatorSetInputFiles(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.setInputFiles');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const files = normalizeFilePaths(params, 'locator.setInputFiles');
    const markerName = 'data-browser-agent-bridge-file-input';
    const markerValue = `bab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const prepared = await runLocatorScript(tabId, { ...params, index, markerName, markerValue }, 'markFileInput', frameTarget);
    if (files.length > 1 && prepared.multiple !== true) {
      await runLocatorScript(tabId, { ...params, markerName, markerValue, index }, 'clearMarkedFileInput', frameTarget).catch(() => {});
      throw new Error('Cannot set multiple files on an input without the multiple attribute');
    }
    let result = null;
    try {
      await setFilesOnMarkedInput(tabId, markerName, markerValue, files);
      result = await runLocatorScript(tabId, { ...params, markerName, markerValue, index }, 'summarizeMarkedFileInput', frameTarget);
    } catch (error) {
      await runLocatorScript(tabId, { ...params, markerName, markerValue, index }, 'clearMarkedFileInput', frameTarget).catch(() => {});
      throw error;
    }
    await recordAction(tabId, 'locator.setInputFiles', { locator: locatorSpecForRecording(params), index, files, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame };
  }

  async function waitForLocatorActionable(tabId, params, actionKind, frameTarget) {
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 100;
    const started = Date.now();
    let previousRect = null;
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      const result = await runLocatorScript(tabId, { ...params, actionKind }, 'actionability', frameTarget);
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
        (actionKind !== 'fill' || checks.editable === true) &&
        (actionKind !== 'select' || checks.selectable === true);

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

  function applyFrameOffset(point, frameTarget) {
    if (!frameTarget?.frameOffset) return point;
    return {
      x: point.x + frameTarget.frameOffset.x,
      y: point.y + frameTarget.frameOffset.y
    };
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

  async function dispatchRealTextInput(tabId, text) {
    await attachDebugger(tabId);
    await cdp(tabId, 'Input.insertText', { text });
  }

  async function runLocatorScript(tabId, params, action, frameTarget) {
    const locator = normalizeLocatorParams(params);
    if (frameTarget?.frameSelector === null) locator.frameSelector = null;
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 200) : 50;
    const options = {
      locator,
      action,
      index,
      limit,
      text: typeof params.fillText === 'string' ? params.fillText : (typeof params.text === 'string' ? params.text : ''),
      selectOptions: Array.isArray(params.selectOptions) ? params.selectOptions : [],
      markerName: typeof params.markerName === 'string' ? params.markerName : '',
      markerValue: typeof params.markerValue === 'string' ? params.markerValue : '',
      replace: params.replace !== false,
      scrollIntoView: params.scrollIntoView !== false,
      force: params.force === true,
      actionKind: params.actionKind || null
    };

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget?.target || { tabId },
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

        if (options.action === 'summarize') {
          return { element: summarizeElement(element, options.index) };
        }

        if (options.action === 'checkState') {
          const state = checkState(element);
          return { ...state, element: summarizeElement(element, options.index) };
        }

        if (options.action === 'markFileInput') {
          if (element.tagName.toLowerCase() !== 'input' || (element.getAttribute('type') || '').toLowerCase() !== 'file') {
            throw new Error('Element is not an input[type=file]');
          }
          element.setAttribute(options.markerName, options.markerValue);
          return {
            element: summarizeElement(element, options.index),
            multiple: element.multiple === true,
            accept: element.getAttribute('accept') || '',
            disabled: element.disabled === true
          };
        }

        if (options.action === 'summarizeMarkedFileInput') {
          const marked = querySelectorDeep(root, `input[${options.markerName}="${cssEscapeAttribute(options.markerValue)}"]`);
          if (!marked) throw new Error('Marked file input not found after setting files');
          marked.dispatchEvent(new Event('input', { bubbles: true }));
          marked.dispatchEvent(new Event('change', { bubbles: true }));
          marked.removeAttribute(options.markerName);
          return { element: summarizeFileInput(marked, options.index) };
        }

        if (options.action === 'clearMarkedFileInput') {
          const marked = querySelectorDeep(root, `input[${options.markerName}="${cssEscapeAttribute(options.markerValue)}"]`);
          if (marked) marked.removeAttribute(options.markerName);
          return { cleared: Boolean(marked) };
        }

        if (!options.force && !actionability.actionable) {
          throw new Error(`Element is not actionable: ${actionability.reasons.join(', ')}`);
        }

        if (typeof element.focus === 'function') element.focus({ preventScroll: true });

        if (options.action === 'prepareTextInput') {
          return prepareTextInput(element, options.index, options.replace !== false);
        }

        if (options.action === 'fill') {
          fillElement(element, options.text);
          return { element: summarizeElement(element, options.index) };
        }

        if (options.action === 'selectOption') {
          const selected = selectOptions(element, options.selectOptions);
          return { element: summarizeElement(element, options.index), selected };
        }

        throw new Error(`Unsupported locator action: ${options.action}`);

        function findLocatorMatches(root, locator) {
          if (locator.label) return findByLabel(root, locator).filter(element => matchesLocator(element, locator, true));
          const candidates = locator.selector
            ? querySelectorAllDeep(root, locator.selector)
            : querySelectorAllDeep(root, candidateSelector());
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
          if (locator.level !== undefined && locator.level !== null && headingLevel(element) !== locator.level) return false;
          if (locator.checked !== undefined && locator.checked !== null && ariaBooleanState(element, 'checked') !== locator.checked) return false;
          if (locator.disabled !== undefined && locator.disabled !== null && !matchesDisabled(element, locator.disabled)) return false;
          if (locator.expanded !== undefined && locator.expanded !== null && ariaBooleanState(element, 'expanded') !== locator.expanded) return false;
          if (locator.pressed !== undefined && locator.pressed !== null && ariaBooleanState(element, 'pressed') !== locator.pressed) return false;
          if (locator.selected !== undefined && locator.selected !== null && ariaBooleanState(element, 'selected') !== locator.selected) return false;
          return true;
        }

        function findByLabel(root, locator) {
          const controls = [];
          for (const label of querySelectorAllDeep(root, 'label')) {
            const text = visibleText(label);
            if (!matchesText(text, locator.label, locator)) continue;
            let control = null;
            const forId = label.getAttribute('for');
            if (forId) control = getElementByIdDeep(root, forId);
            if (!control) control = querySelectorDeep(label, 'input, textarea, select, [contenteditable="true"], [contenteditable=""]');
            if (control) controls.push(control);
          }
          for (const element of querySelectorAllDeep(root, 'input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
            const aria = element.getAttribute('aria-label') || '';
            const placeholder = element.getAttribute('placeholder') || '';
            if (matchesText(aria, locator.label, locator) || matchesText(placeholder, locator.label, locator)) controls.push(element);
          }
          return Array.from(new Set(controls));
        }

        function fillElement(element, text) {
          if (element.tagName.toLowerCase() === 'select' && 'value' in element) {
            element.value = text;
          } else {
            throw new Error('Element is not editable');
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function prepareTextInput(element, index, replace) {
          if (element.tagName.toLowerCase() === 'select') {
            return { element: summarizeElement(element, index), inputMode: 'select' };
          }
          if (typeof element.focus === 'function') element.focus({ preventScroll: true });
          if (element.isContentEditable) {
            const selection = element.ownerDocument.getSelection();
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(element);
            if (!replace) range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            return { element: summarizeElement(element, index), inputMode: 'text' };
          }
          if (isTextInputElement(element)) {
            const length = String(element.value || '').length;
            if (typeof element.setSelectionRange === 'function') {
              element.setSelectionRange(replace ? 0 : length, length);
            } else if (typeof element.select === 'function' && replace) {
              element.select();
            }
            return { element: summarizeElement(element, index), inputMode: 'text' };
          }
          throw new Error('Element is not editable');
        }

        function checkState(element) {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          const role = inferredRole(element);
          const nativeCheckable = tag === 'input' && ['checkbox', 'radio'].includes(type);
          const ariaCheckable = role === 'checkbox' || role === 'radio' || role === 'switch';
          if (!nativeCheckable && !ariaCheckable) return { checkable: false, checked: null, radio: false };
          return {
            checkable: true,
            checked: nativeCheckable ? element.checked : element.getAttribute('aria-checked') === 'true',
            radio: type === 'radio' || role === 'radio'
          };
        }

        function selectOptions(element, requested) {
          if (element.tagName.toLowerCase() !== 'select') throw new Error('Element is not a select');
          const multiple = element.multiple === true;
          const selected = [];
          const optionsToSelect = [];
          for (const request of requested) {
            const option = findOption(element, request);
            if (!option) throw new Error(`Option not found: ${JSON.stringify(request)}`);
            optionsToSelect.push(option);
            if (!multiple) break;
          }
          for (const option of element.options) option.selected = false;
          for (const option of optionsToSelect) {
            option.selected = true;
            selected.push({ value: option.value, label: option.label || option.textContent || '', index: option.index });
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return selected;
        }

        function summarizeFileInput(element, index) {
          const rect = element.getBoundingClientRect();
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            type: element.getAttribute('type') || '',
            multiple: element.multiple === true,
            fileCount: element.files ? element.files.length : 0,
            files: Array.from(element.files || []).map(file => ({ name: file.name, size: file.size, type: file.type })),
            value: element.value || '',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }

        function cssEscapeAttribute(value) {
          return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }

        function findOption(select, request) {
          const options = Array.from(select.options);
          if (Number.isInteger(request.index)) return options[request.index] || null;
          if (typeof request.value === 'string') return options.find(option => option.value === request.value) || null;
          if (typeof request.label === 'string') {
            return options.find(option => matchesText(option.label || option.textContent || '', request.label, {
              exact: request.exact === true,
              caseSensitive: request.caseSensitive === true
            })) || null;
          }
          return null;
        }

        function getActionability(element, actionKind) {
          const visible = isVisible(element);
          const enabled = isEnabled(element);
          const editable = isEditable(element);
          const selectable = element.tagName.toLowerCase() === 'select';
          const pointerEvents = getComputedStyle(element).pointerEvents !== 'none';
          const clickPoint = clickablePoint(element, root);
          const hitTarget = actionKind === 'click' && clickPoint ? hitTestElement(element, root, clickPoint) : { receivesEvents: true };
          const reasons = [];
          if (!visible) reasons.push('not visible');
          if (!enabled) reasons.push('disabled');
          if (actionKind === 'click' && !pointerEvents) reasons.push('pointer-events none');
          if (actionKind === 'click' && !hitTarget.receivesEvents) reasons.push(`covered by ${hitTarget.description || 'another element'}`);
          if (actionKind === 'fill' && !editable) reasons.push('not editable');
          if (actionKind === 'select' && element.tagName.toLowerCase() !== 'select') reasons.push('not a select');
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
              .map(id => getElementByIdDeep(root, id))
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
            const label = querySelectorDeep(root, `label[for="${cssEscape(element.id)}"]`);
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
            const caption = querySelectorDeep(element, ':scope > caption');
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
          if (tag === 'select') return true;
          if (!isTextInputElement(element)) return false;
          if (element.readOnly) return false;
          return true;
        }

        function isTextInputElement(element) {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tag === 'textarea') return true;
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

        function getElementByIdDeep(root, id) {
          const escaped = cssEscape(id);
          return querySelectorDeep(root, `#${escaped}`);
        }

        function describeLocator(locator) {
          return ['selector', 'role', 'name', 'text', 'label', 'placeholder']
            .filter(key => locator[key])
            .map(key => `${key}=${JSON.stringify(locator[key])}`)
            .join(', ') || '<empty>';
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

  async function setFilesOnMarkedInput(tabId, markerName, markerValue, files) {
    await attachDebugger(tabId);
    await cdp(tabId, 'DOM.enable').catch(() => {});
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
  }

  function normalizeFilePaths(params, methodName) {
    const value = params.files ?? params.filePaths ?? params.filePath ?? params.path;
    const files = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    for (const file of files) {
      if (typeof file !== 'string' || !file) throw new Error(`${methodName} requires file path strings`);
    }
    return files;
  }

  function escapeCssAttributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizeSelectOptionValues(params) {
    const source = params.options ?? params.values ?? params.value ?? params.label ?? params.option;
    const values = Array.isArray(source) ? source : [source];
    const normalized = values.map(item => {
      if (typeof item === 'string') return { value: item };
      if (Number.isInteger(item)) return { index: item };
      if (item && typeof item === 'object') {
        return {
          ...(typeof item.value === 'string' ? { value: item.value } : {}),
          ...(typeof item.label === 'string' ? { label: item.label } : {}),
          ...(Number.isInteger(item.index) ? { index: item.index } : {}),
          ...(item.exact === true ? { exact: true } : {}),
          ...(item.caseSensitive === true ? { caseSensitive: true } : {})
        };
      }
      return {};
    }).filter(item => typeof item.value === 'string' || typeof item.label === 'string' || Number.isInteger(item.index));
    if (normalized.length === 0) throw new Error('locator.selectOption requires value, label, index, option, options, or values');
    return normalized;
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
    locatorFill,
    locatorCheck,
    locatorUncheck,
    locatorSelectOption,
    locatorSetInputFiles
  };
}
