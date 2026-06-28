export function createLocatorHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  recordAction,
  attachDebugger,
  cdp,
  captureElementScreenshot,
  resolveFrameTarget,
  ensureContentScripts = async () => {},
  keyboardDispatcher,
  sleep,
  defaultTimeoutMs,
  chromeApi = chrome,
  domA11ySource = null
}) {
  async function ensureDomA11yAtom(tabId, frameTarget) {
    const target = frameTarget?.target || { tabId };
    if (typeof domA11ySource === 'string') {
      await chromeApi.scripting.executeScript({
        target,
        func: source => {
          if (!globalThis.__browserAgentBridgeDomA11y) (0, eval)(source);
        },
        args: [domA11ySource],
        world: 'MAIN'
      });
      return;
    }
    if (!chromeApi.runtime?.getURL && !globalThis.chrome?.runtime?.getURL) return;
    await chromeApi.scripting.executeScript({
      target,
      files: ['content/dom-a11y.js'],
      world: 'MAIN'
    });
  }

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

  async function locatorAllTextContents(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.allTextContents');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, params, 'allTextContents', frameTarget);
    return { texts: result.texts, count: result.count, frame: frameTarget.frame };
  }

  async function locatorAllInnerTexts(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.allInnerTexts');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, params, 'allInnerTexts', frameTarget);
    return { texts: result.texts, count: result.count, frame: frameTarget.frame };
  }

  async function locatorGetAttribute(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.getAttribute');
    assertString(params.name, 'name');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, { ...params, index, attributeName: params.name }, 'getAttribute', frameTarget);
    return { value: result.value, element: result.element, frame: frameTarget.frame };
  }

  async function locatorNth(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.nth');
    const nth = Number.isInteger(params.nth) && params.nth >= 0
      ? params.nth
      : Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, { ...params, index: nth }, 'summarize', frameTarget);
    return { element: result.element, index: nth, frame: frameTarget.frame };
  }

  async function locatorFirst(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.first');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, { ...params, index: 0 }, 'summarize', frameTarget);
    return { element: result.element, index: 0, frame: frameTarget.frame };
  }

  async function locatorLast(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.last');
    const frameTarget = await resolveFrameTarget(tabId, params);
    const query = await runLocatorScript(tabId, params, 'query', frameTarget);
    if (query.count <= 0) throw new Error(`Element not found for locator: ${describeLocator(params)}`);
    const index = query.count - 1;
    const result = await runLocatorScript(tabId, { ...params, index }, 'summarize', frameTarget);
    return { element: result.element, index, count: query.count, frame: frameTarget.frame };
  }

  async function locatorWaitFor(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.waitFor');
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const state = ['attached', 'visible', 'hidden', 'detached'].includes(params.state) ? params.state : 'visible';
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);

    const result = await runLocatorScript(tabId, {
      ...params,
      wait: { kind: 'locatorState', state, timeoutMs, intervalMs }
    }, 'query', frameTarget);
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

    throw new Error(`Timed out waiting for locator ${describeLocator(params)} to be ${state}${result ? ` (last count: ${result.count})` : ''}`);
  }

  async function expectLocatorToBeVisible(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.locator.toBeVisible');
    const result = await locatorWaitFor({ ...params, state: 'visible' });
    return { ok: true, assertion: 'toBeVisible', ...result };
  }

  async function expectLocatorToHaveCount(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.locator.toHaveCount');
    const expected = normalizeExpectedCount(params);
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);

    const result = await runLocatorScript(tabId, {
      ...params,
      wait: { kind: 'count', expected, timeoutMs, intervalMs }
    }, 'query', frameTarget);
    if (result.count === expected) {
      return { ok: true, assertion: 'toHaveCount', expected, actual: result.count, elapsedMs: Date.now() - started, frame: frameTarget.frame };
    }
    throw createLocatorExpectTimeoutError(params, 'toHaveCount', frameTarget, {
      expected,
      actual: result?.count ?? 0,
      elapsedMs: Date.now() - started,
      last: result
    });
  }

  async function expectLocatorToHaveText(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.locator.toHaveText');
    const expected = normalizeExpectedText(params);
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);

    const result = await runLocatorScript(tabId, {
      ...params,
      wait: { kind: 'text', expected, timeoutMs, intervalMs, match: locatorTextMatchOptions(params) }
    }, Array.isArray(expected) ? 'allInnerTexts' : 'textContent', frameTarget);
    const actual = Array.isArray(expected) ? result.texts : result.text;
    if (matchesExpectedText(actual, expected, params)) {
      return { ok: true, assertion: 'toHaveText', expected, actual, elapsedMs: Date.now() - started, frame: frameTarget.frame };
    }
    throw createLocatorExpectTimeoutError(params, 'toHaveText', frameTarget, {
      expected,
      actual,
      elapsedMs: Date.now() - started,
      last: result
    });
  }

  async function expectLocatorElementState(params, assertion, predicate, actualOf, expected) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, `expect.locator.${assertion}`);
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);

    const result = await runLocatorScript(tabId, {
      ...params,
      index,
      wait: { kind: 'elementState', assertion, expected, timeoutMs, intervalMs, match: locatorTextMatchOptions(params) }
    }, 'summarize', frameTarget);
    const element = result.element;
    if (element && predicate(element)) {
      return { ok: true, assertion, expected, actual: actualOf(element), elapsedMs: Date.now() - started, frame: frameTarget.frame };
    }
    throw createLocatorExpectTimeoutError(params, assertion, frameTarget, {
      expected,
      actual: element ? actualOf(element) : null,
      elapsedMs: Date.now() - started,
      last: { element }
    });
  }

  async function expectLocatorToBeEnabled(params) {
    const want = params.enabled !== false;
    return expectLocatorElementState(params, 'toBeEnabled', el => (el.disabled === false) === want, el => el.disabled === false, want);
  }

  async function expectLocatorToBeDisabled(params) {
    return expectLocatorElementState(params, 'toBeDisabled', el => el.disabled === true, el => el.disabled === true, true);
  }

  async function expectLocatorToBeEditable(params) {
    const want = params.editable !== false;
    return expectLocatorElementState(params, 'toBeEditable', el => (el.editable === true) === want, el => el.editable === true, want);
  }

  async function expectLocatorToBeChecked(params) {
    const want = params.checked !== false;
    return expectLocatorElementState(params, 'toBeChecked', el => el.checked === want, el => el.checked, want);
  }

  async function expectLocatorToHaveValue(params) {
    const expected = params.expectedValue ?? params.expected ?? params.value;
    if (typeof expected !== 'string') throw new Error('expect.locator.toHaveValue requires expectedValue, expected, or value');
    return expectLocatorElementState(
      params,
      'toHaveValue',
      el => matchesExpectedText(el.value || '', expected, params),
      el => el.value || '',
      expected
    );
  }

  async function expectLocatorToBeHidden(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.locator.toBeHidden');
    const result = await locatorWaitFor({ ...params, state: 'hidden' });
    return { ok: true, assertion: 'toBeHidden', ...result };
  }

  async function expectLocatorToHaveAttribute(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'expect.locator.toHaveAttribute');
    const attributeName = typeof params.attribute === 'string' && params.attribute ? params.attribute : params.name;
    assertString(attributeName, 'attribute');
    const expected = params.expectedValue ?? params.expected ?? params.value;
    if (typeof expected !== 'string') throw new Error('expect.locator.toHaveAttribute requires expectedValue, expected, or value');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : defaultTimeoutMs;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const started = Date.now();
    const frameTarget = await resolveFrameTarget(tabId, params);

    const result = await runLocatorScript(tabId, {
      ...params,
      index,
      attributeName,
      wait: { kind: 'attribute', expected, attributeName, timeoutMs, intervalMs, match: locatorTextMatchOptions(params) }
    }, 'getAttribute', frameTarget);
    const actual = result.value;
    if (matchesExpectedText(actual || '', expected, params)) {
      return { ok: true, assertion: 'toHaveAttribute', attribute: attributeName, expected, actual, elapsedMs: Date.now() - started, frame: frameTarget.frame };
    }
    throw createLocatorExpectTimeoutError(params, 'toHaveAttribute', frameTarget, {
      attribute: attributeName,
      expected,
      actual,
      elapsedMs: Date.now() - started,
      last: result
    });
  }

  async function locatorClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.click');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    let frameTarget = await resolveFrameTarget(tabId, params);
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...params, index, actionKind: 'click' }, 'actionability', frameTarget)
      : await waitForLocatorActionable(tabId, { ...params, index }, 'click', frameTarget);
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point for locator ${describeLocator(params)}`);
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, params);
    await dispatchRealClick(tabId, applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const result = { element: target.element };
    await recordAction(tabId, 'locator.click', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame, ...(params.force === true ? {} : { actionability: target.actionability }) };
  }

  async function locatorClickRef(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.clickRef');
    assertString(params.ref, 'ref');
    const frameId = Number.isInteger(params.frameId) && params.frameId >= 0 ? params.frameId : 0;
    let frameTarget = await resolveFrameTarget(tabId, { ...params, frameId });
    await ensureContentScripts(tabId, frameId);
    const response = await chromeApi.tabs.sendMessage(tabId, {
      type: 'GET_ACCESSIBILITY_REF_TARGET',
      ref: params.ref,
      snapshotId: typeof params.snapshotId === 'string' && params.snapshotId ? params.snapshotId : undefined
    }, { frameId });
    if (!response?.ok) throw new Error(response?.error || `Accessibility ref not found: ${params.ref}`);
    const target = response.target;
    if (params.force !== true && target?.actionability?.actionable !== true) {
      throw createLocatorRefNotActionableError(params, frameTarget, target);
    }
    if (!target?.element?.clickPoint) throw new Error(`Element has no clickable point for ref ${params.ref}`);
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, { ...params, frameId });
    await dispatchRealClick(tabId, applyFrameOffset(target.element.clickPoint, frameTarget), params);
    const result = { element: target.element };
    await recordAction(tabId, 'locator.clickRef', {
      ref: params.ref,
      snapshotId: target.snapshotId || params.snapshotId || null,
      frameId
    }, result);
    return {
      ok: true,
      ref: params.ref,
      snapshotId: target.snapshotId || null,
      element: result.element,
      frame: frameTarget.frame,
      actionability: target.actionability || null
    };
  }

  async function locatorDragTo(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.dragTo');
    const sourceIndex = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const targetParams = normalizeTargetLocatorParams(params);
    const targetIndex = Number.isInteger(params.targetIndex) && params.targetIndex >= 0 ? params.targetIndex : 0;
    let sourceFrameTarget = await resolveFrameTarget(tabId, params);
    let targetFrameTarget = await resolveFrameTarget(tabId, targetParams);
    const source = params.force === true
      ? await runLocatorScript(tabId, { ...params, index: sourceIndex, actionKind: 'click' }, 'actionability', sourceFrameTarget)
      : await waitForLocatorActionable(tabId, { ...params, index: sourceIndex }, 'click', sourceFrameTarget);
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...targetParams, index: targetIndex, actionKind: 'click' }, 'actionability', targetFrameTarget)
      : await waitForLocatorActionable(tabId, { ...targetParams, index: targetIndex }, 'click', targetFrameTarget);
    if (!source?.element?.clickPoint) throw new Error(`Source element has no draggable point for locator ${describeLocator(params)}`);
    if (!target?.element?.clickPoint) throw new Error(`Target element has no drop point for locator ${describeLocator(targetParams)}`);
    if (sourceFrameTarget.frameOffset) sourceFrameTarget = await resolveFrameTarget(tabId, params);
    if (targetFrameTarget.frameOffset) targetFrameTarget = await resolveFrameTarget(tabId, targetParams);
    await dispatchRealDrag(
      tabId,
      applyFrameOffset(source.element.clickPoint, sourceFrameTarget),
      applyFrameOffset(target.element.clickPoint, targetFrameTarget),
      params
    );
    const result = { source: source.element, target: target.element };
    await recordAction(tabId, 'locator.dragTo', {
      locator: locatorSpecForRecording(params),
      index: sourceIndex,
      target: locatorSpecForRecording(targetParams),
      targetIndex,
      frameSelector: params.frameSelector || params.locator?.frameSelector || null,
      frameId: sourceFrameTarget.frameId,
      targetFrameId: targetFrameTarget.frameId
    }, result);
    return {
      ok: true,
      source: result.source,
      target: result.target,
      frame: sourceFrameTarget.frame,
      targetFrame: targetFrameTarget.frame,
      ...(params.force === true ? {} : { actionability: { source: source.actionability, target: target.actionability } })
    };
  }

  async function locatorDispatchDragDrop(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.dispatchDragDrop');
    const sourceIndex = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const targetParams = normalizeTargetLocatorParams(params);
    const targetIndex = Number.isInteger(params.targetIndex) && params.targetIndex >= 0 ? params.targetIndex : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const targetFrameTarget = await resolveFrameTarget(tabId, targetParams);
    if (frameTarget.frameId !== targetFrameTarget.frameId || frameTarget.frameSelector !== targetFrameTarget.frameSelector) {
      throw new Error('locator.dispatchDragDrop requires source and target in the same frame');
    }
    const result = await runLocatorScript(tabId, {
      ...params,
      index: sourceIndex,
      targetLocator: normalizeLocatorParams(targetParams),
      targetIndex,
      dragData: params.data || null
    }, 'dispatchDragDrop', frameTarget);
    await recordAction(tabId, 'locator.dispatchDragDrop', {
      locator: locatorSpecForRecording(params),
      index: sourceIndex,
      target: locatorSpecForRecording(targetParams),
      targetIndex,
      frameSelector: params.frameSelector || params.locator?.frameSelector || null,
      frameId: frameTarget.frameId
    }, result);
    return { ok: true, ...result, frame: frameTarget.frame };
  }

  async function locatorScreenshot(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.screenshot');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    let frameTarget = await resolveFrameTarget(tabId, params);
    const target = params.force === true
      ? await runLocatorScript(tabId, { ...params, index, actionKind: 'screenshot' }, 'actionability', frameTarget)
      : await waitForLocatorActionable(tabId, { ...params, index, stable: params.stable !== false }, 'screenshot', frameTarget);
    const rect = target?.element?.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`Element has no screenshot area for locator ${describeLocator(params)}`);
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, params);
    const deviceScaleFactor = await getDeviceScaleFactor(tabId, frameTarget);
    const dataUrl = await captureElementScreenshot(tabId, applyFrameOffset(rect, frameTarget), { ...params, deviceScaleFactor });
    await recordAction(tabId, 'locator.screenshot', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, target.element);
    return { dataUrl, element: target.element, frame: frameTarget.frame };
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

  async function locatorPress(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.press');
    assertString(params.key, 'key');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    // 'press' actionability gate requires visible+enabled+stable (no editable /
    // hit-test), so it works on buttons and inputs alike.
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index }, 'press', frameTarget);
    const result = await runLocatorScript(tabId, { ...params, index, force: true }, 'focus', frameTarget);
    await attachDebugger(tabId);
    await keyboardDispatcher.press(tabId, params.key, params);
    await recordAction(tabId, 'locator.press', { locator: locatorSpecForRecording(params), index, key: params.key, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame, ...(readiness ? { actionability: readiness.actionability } : {}) };
  }

  async function locatorPressSequentially(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.pressSequentially');
    const text = typeof params.text === 'string' ? params.text : params.value;
    assertString(text, 'text');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const readiness = params.force === true ? null : await waitForLocatorActionable(tabId, { ...params, index, _ignoreTopLevelTextLocator: true }, 'fill', frameTarget);
    const result = await runLocatorScript(tabId, { ...params, index, force: true, _ignoreTopLevelTextLocator: true }, 'focus', frameTarget);
    await attachDebugger(tabId);
    await keyboardDispatcher.typeText(tabId, text, params);
    await recordAction(tabId, 'locator.pressSequentially', { locator: locatorSpecForRecording({ ...params, _ignoreTopLevelTextLocator: true }), index, text, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
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
    let frameTarget = await resolveFrameTarget(tabId, params);
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
    if (frameTarget.frameOffset) frameTarget = await resolveFrameTarget(tabId, params);
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
    const last = await runLocatorScript(tabId, {
      ...params,
      actionKind,
      wait: {
        kind: 'actionability',
        actionKind,
        timeoutMs,
        intervalMs,
        strict: params.strict === true,
        requireStable: params.stable !== false
      }
    }, 'actionability', frameTarget);

    const checks = last?.actionability || {};
    const ready = last?.found &&
      checks.visible === true &&
      (actionKind === 'screenshot' || checks.enabled === true) &&
      (actionKind !== 'click' || checks.receivesEvents === true) &&
      checks.stable === true &&
      (actionKind !== 'fill' || checks.editable === true) &&
      (actionKind !== 'select' || checks.selectable === true) &&
      (params.strict !== true || last.count === 1);

    if (ready) {
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        element: last.element,
        actionability: { ...checks, stable: true, strict: params.strict === true }
      };
    }

    if (params.strict === true && (last?.count ?? 0) > 1) {
      throw createLocatorStrictModeError(params, actionKind, frameTarget, last, Date.now() - started);
    }
    throw createLocatorTimeoutError(params, actionKind, frameTarget, last, Date.now() - started);
  }

  function createLocatorTimeoutError(params, actionKind, frameTarget, last, elapsedMs) {
    const checks = last?.actionability || {};
    const reasons = diagnosticReasons(last, checks, params);
    const diagnostic = {
      type: 'LocatorActionabilityTimeout',
      locator: describeLocator(params),
      action: actionKind,
      elapsedMs,
      count: last?.count ?? 0,
      visibleCount: last?.visibleCount ?? 0,
      index: Number.isInteger(params.index) && params.index >= 0 ? params.index : 0,
      strict: params.strict === true,
      reasons,
      actionability: { ...checks, stable: checks.stable === true },
      element: compactLocatorElement(last?.element),
      candidates: (last?.elements || []).slice(0, 5).map(compactLocatorElement).filter(Boolean),
      frame: frameTarget?.frame || null
    };
    const error = new Error(formatLocatorTimeoutMessage(diagnostic));
    error.name = 'LocatorActionabilityTimeout';
    error.code = 'LOCATOR_ACTIONABILITY_TIMEOUT';
    error.diagnostic = diagnostic;
    return error;
  }

  function createLocatorStrictModeError(params, actionKind, frameTarget, last, elapsedMs) {
    // List every observed candidate (capped only by the in-page collection
    // limit) so "matched too many" is diagnosable without re-querying.
    const candidates = (last?.elements || []).map(compactLocatorElement).filter(Boolean);
    const count = Number.isInteger(last?.count) ? last.count : candidates.length;
    const diagnostic = {
      type: 'LocatorStrictModeViolation',
      locator: describeLocator(params),
      action: actionKind,
      elapsedMs,
      count,
      visibleCount: last?.visibleCount ?? null,
      strict: true,
      candidates,
      candidatesTruncated: count > candidates.length,
      frame: frameTarget?.frame || null
    };
    const error = new Error(formatLocatorStrictModeMessage(diagnostic));
    error.name = 'LocatorStrictModeViolation';
    error.code = 'LOCATOR_STRICT_MODE_VIOLATION';
    error.diagnostic = diagnostic;
    return error;
  }

  function formatFramePathSuffix(frame) {
    const path = Array.isArray(frame?.framePath) ? frame.framePath : [];
    if (path.length <= 1) return '';
    return ` (path: ${path.map(item => item.frameId).join(' > ')})`;
  }

  function formatLocatorStrictModeMessage(diagnostic) {
    const parts = [
      `Strict mode violation: locator ${diagnostic.locator} resolved to ${diagnostic.count} elements for ${diagnostic.action}`
    ];
    if (diagnostic.frame?.frameId != null) {
      parts.push(`frame: ${diagnostic.frame.frameId}${diagnostic.frame.url ? ` ${diagnostic.frame.url}` : ''}${formatFramePathSuffix(diagnostic.frame)}`);
    }
    if (diagnostic.candidates.length > 0) {
      const shown = diagnostic.candidates.slice(0, 10).map(formatCompactLocatorElement).join(' | ');
      const hidden = diagnostic.count - Math.min(10, diagnostic.candidates.length);
      parts.push(`candidates: ${shown}${hidden > 0 ? ` (+${hidden} more)` : ''}`);
    }
    return parts.join('; ');
  }

  function createLocatorExpectTimeoutError(params, assertion, frameTarget, details) {
    const diagnostic = {
      type: 'LocatorExpectationTimeout',
      locator: describeLocator(params),
      assertion,
      elapsedMs: details.elapsedMs,
      expected: details.expected,
      actual: details.actual,
      ...(details.attribute ? { attribute: details.attribute } : {}),
      count: details.last?.count ?? null,
      visibleCount: details.last?.visibleCount ?? null,
      candidates: locatorDiagnosticCandidates(details.last),
      frame: frameTarget?.frame || null
    };
    const error = new Error(formatLocatorExpectTimeoutMessage(diagnostic));
    error.name = 'LocatorExpectationTimeout';
    error.code = 'LOCATOR_EXPECT_TIMEOUT';
    error.diagnostic = diagnostic;
    return error;
  }

  function formatLocatorExpectTimeoutMessage(diagnostic) {
    const subject = diagnostic.attribute
      ? ` attribute ${diagnostic.attribute}`
      : '';
    const parts = [
      `Timed out after ${diagnostic.elapsedMs}ms expecting locator ${diagnostic.locator}${subject} ${diagnostic.assertion}`,
      `expected: ${JSON.stringify(diagnostic.expected)}`,
      `actual: ${JSON.stringify(diagnostic.actual)}`
    ];
    if (Number.isInteger(diagnostic.count)) {
      parts.push(`matches: ${diagnostic.count}, visible: ${diagnostic.visibleCount ?? 0}`);
    }
    if (diagnostic.frame?.frameId != null) {
      parts.push(`frame: ${diagnostic.frame.frameId}${diagnostic.frame.url ? ` ${diagnostic.frame.url}` : ''}${formatFramePathSuffix(diagnostic.frame)}`);
    }
    if (diagnostic.candidates.length > 0) {
      parts.push(`candidates: ${diagnostic.candidates.map(formatCompactLocatorElement).join(' | ')}`);
    }
    return parts.join('; ');
  }

  function locatorDiagnosticCandidates(last) {
    if (Array.isArray(last?.elements)) return last.elements.slice(0, 5).map(compactLocatorElement).filter(Boolean);
    const element = compactLocatorElement(last?.element);
    return element ? [element] : [];
  }

  function diagnosticReasons(last, checks, params) {
    const reasons = Array.isArray(checks.reasons) && checks.reasons.length > 0 ? [...checks.reasons] : [];
    if (params.strict === true && Number.isInteger(last?.count) && last.count !== 1) {
      reasons.unshift(`strict mode expected 1 match, got ${last.count}`);
    }
    if (last?.found && checks.stable !== true && params.stable !== false) reasons.push('not stable');
    if (reasons.length === 0) reasons.push(last?.found ? 'not actionable' : 'not found');
    return Array.from(new Set(reasons));
  }

  function formatLocatorTimeoutMessage(diagnostic) {
    const parts = [
      `Timed out after ${diagnostic.elapsedMs}ms waiting for locator ${diagnostic.locator} to be actionable for ${diagnostic.action}`,
      `matches: ${diagnostic.count}, visible: ${diagnostic.visibleCount}, index: ${diagnostic.index}`,
      `reasons: ${diagnostic.reasons.join(', ')}`
    ];
    if (diagnostic.frame?.frameId != null) {
      parts.push(`frame: ${diagnostic.frame.frameId}${diagnostic.frame.url ? ` ${diagnostic.frame.url}` : ''}${formatFramePathSuffix(diagnostic.frame)}`);
    }
    if (diagnostic.element) {
      parts.push(`target: ${formatCompactLocatorElement(diagnostic.element)}`);
    } else if (diagnostic.candidates.length > 0) {
      parts.push(`candidates: ${diagnostic.candidates.map(formatCompactLocatorElement).join(' | ')}`);
    }
    if (diagnostic.actionability?.hitTarget) parts.push(`hit target: ${diagnostic.actionability.hitTarget}`);
    return parts.join('; ');
  }

  function createLocatorRefNotActionableError(params, frameTarget, target) {
    const reasons = Array.isArray(target?.actionability?.reasons) && target.actionability.reasons.length > 0
      ? target.actionability.reasons
      : ['not actionable'];
    const diagnostic = {
      type: 'LocatorRefNotActionable',
      ref: params.ref,
      snapshotId: params.snapshotId || target?.snapshotId || null,
      action: 'locator.clickRef',
      reasons,
      actionability: target?.actionability || null,
      element: target?.element || null,
      frame: frameTarget?.frame || null
    };
    const error = new Error(`Ref ${params.ref} is not actionable for locator.clickRef: ${reasons.join(', ')}`);
    error.name = 'LocatorRefNotActionable';
    error.code = 'LOCATOR_REF_NOT_ACTIONABLE';
    error.diagnostic = diagnostic;
    return error;
  }

  function compactLocatorElement(element) {
    if (!element || typeof element !== 'object') return null;
    return {
      index: element.index,
      tagName: element.tagName,
      id: element.id || '',
      role: element.role || '',
      accessibleName: element.accessibleName || '',
      text: element.text || '',
      visible: element.visible === true,
      disabled: element.disabled === true,
      rect: element.rect || null,
      clickPoint: element.clickPoint || null
    };
  }

  function formatCompactLocatorElement(element) {
    const name = element.accessibleName ? ` name=${JSON.stringify(element.accessibleName)}` : '';
    const text = !name && element.text ? ` text=${JSON.stringify(element.text.slice(0, 80))}` : '';
    const id = element.id ? `#${element.id}` : '';
    const role = element.role ? ` role=${element.role}` : '';
    const rect = element.rect ? ` rect=${Math.round(element.rect.x)},${Math.round(element.rect.y)} ${Math.round(element.rect.width)}x${Math.round(element.rect.height)}` : '';
    return `${element.tagName || 'element'}${id}${role}${name}${text}${rect}`;
  }

  function applyFrameOffset(point, frameTarget) {
    if (!frameTarget?.frameOffset) return point;
    return {
      x: point.x + frameTarget.frameOffset.x,
      y: point.y + frameTarget.frameOffset.y
    };
  }

  async function getDeviceScaleFactor(tabId, frameTarget) {
    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget?.target || { tabId },
      func: () => window.devicePixelRatio || 1,
      world: 'MAIN'
    });
    return typeof result === 'number' && result > 0 ? result : 1;
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

  async function dispatchRealDrag(tabId, from, to, params) {
    await attachDebugger(tabId);
    const button = params.button || 'left';
    const steps = Number.isInteger(params.steps) && params.steps > 0 ? params.steps : 12;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none'
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button,
      buttons: 1,
      clickCount: 1
    });
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
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button,
      clickCount: 1
    });
  }

  async function dispatchRealTextInput(tabId, text) {
    await attachDebugger(tabId);
    await cdp(tabId, 'Input.insertText', { text });
  }

  async function runLocatorScript(tabId, params, action, frameTarget) {
    await ensureDomA11yAtom(tabId, frameTarget);
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
      attributeName: typeof params.attributeName === 'string' ? params.attributeName : '',
      targetLocator: params.targetLocator && typeof params.targetLocator === 'object' ? params.targetLocator : null,
      targetIndex: Number.isInteger(params.targetIndex) && params.targetIndex >= 0 ? params.targetIndex : 0,
      dragData: params.dragData || null,
      replace: params.replace !== false,
      scrollIntoView: params.scrollIntoView !== false,
      force: params.force === true,
      actionKind: params.actionKind || null,
      wait: params.wait || null
    };

    const [{ result }] = await chromeApi.scripting.executeScript({
      target: frameTarget?.target || { tabId },
      func: options => {
        const domA11y = globalThis.__browserAgentBridgeDomA11y;
        if (!domA11y) throw new Error('DOM a11y atom is not loaded');
        const root = resolveDomRoot(options.locator.frameSelector);
        if (options.wait) return waitForLocatorCondition(root, options);

        const matches = findLocatorMatches(root, options.locator);
        const elements = matches.slice(0, options.limit).map((element, index) => summarizeElement(element, index));

        if (options.action === 'query') {
          return { count: matches.length, visibleCount: matches.filter(isVisible).length, elements };
        }

        if (options.action === 'allTextContents') {
          return { count: matches.length, texts: matches.slice(0, options.limit).map(item => item.textContent || '') };
        }

        if (options.action === 'allInnerTexts') {
          return { count: matches.length, texts: matches.slice(0, options.limit).map(item => item.innerText || item.textContent || '') };
        }

        const element = matches[options.index];
        if (!element) {
          if (options.action === 'actionability') {
            return {
              found: false,
              count: matches.length,
              visibleCount: matches.filter(isVisible).length,
              elements,
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

        if (options.action === 'getAttribute') {
          return {
            value: element.getAttribute(options.attributeName),
            element: summarizeElement(element, options.index)
          };
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

        if (options.action === 'dispatchDragDrop') {
          if (!options.targetLocator) throw new Error('Missing target locator');
          const targetMatches = findLocatorMatches(root, options.targetLocator);
          const target = targetMatches[options.targetIndex];
          if (!target) throw new Error(`Target element not found for locator: ${describeLocator(options.targetLocator)} at index ${options.targetIndex}`);
          const dataTransfer = new DataTransfer();
          for (const item of normalizeDragData(options.dragData)) dataTransfer.setData(item.type, item.value);
          const sourceRect = element.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          dispatchDragEvent(element, 'dragstart', dataTransfer, sourceRect);
          dispatchDragEvent(target, 'dragenter', dataTransfer, targetRect);
          dispatchDragEvent(target, 'dragover', dataTransfer, targetRect);
          dispatchDragEvent(target, 'drop', dataTransfer, targetRect);
          dispatchDragEvent(element, 'dragend', dataTransfer, sourceRect);
          return {
            source: summarizeElement(element, options.index),
            target: summarizeElement(target, options.targetIndex),
            types: Array.from(dataTransfer.types || [])
          };
        }

        if (!options.force && !actionability.actionable) {
          throw new Error(`Element is not actionable: ${actionability.reasons.join(', ')}`);
        }

        if (typeof element.focus === 'function') element.focus({ preventScroll: true });

        if (options.action === 'focus') {
          return { element: summarizeElement(element, options.index) };
        }

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

        function waitForLocatorCondition(root, options) {
          return new Promise((resolve, reject) => {
            const timeoutMs = Number.isInteger(options.wait.timeoutMs) && options.wait.timeoutMs > 0 ? options.wait.timeoutMs : 30000;
            const intervalMs = Number.isInteger(options.wait.intervalMs) && options.wait.intervalMs > 0 ? options.wait.intervalMs : 250;
            const started = Date.now();
            const observers = [];
            let done = false;
            let last = null;
            let previousRect = null;
            let checkQueued = false;
            let observedRoots = new Set();

            const timeoutId = setTimeout(() => finish(last || locatorSnapshot(root, options)), timeoutMs);
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
                observeCurrentRoots(root);
                last = locatorSnapshot(root, options);
                if (options.wait.kind === 'actionability') {
                  const annotated = annotateActionabilitySnapshot(last, options.wait, previousRect);
                  last = annotated.snapshot;
                  previousRect = annotated.nextRect;
                }
                if (locatorWaitSatisfied(last, options.wait)) finish(last);
                else if (Date.now() - started >= timeoutMs) finish(last);
              } catch (error) {
                fail(error);
              }
            }

            check();
          });
        }

        function locatorSnapshot(root, options) {
          const matches = findLocatorMatches(root, options.locator);
          const elements = matches.slice(0, options.limit).map((element, index) => summarizeElement(element, index));
          const visibleCount = matches.filter(isVisible).length;
          const base = { count: matches.length, visibleCount, elements };
          if (options.action === 'query') return base;
          if (options.action === 'allTextContents') {
            return { ...base, texts: matches.slice(0, options.limit).map(item => item.textContent || '') };
          }
          if (options.action === 'allInnerTexts') {
            return { ...base, texts: matches.slice(0, options.limit).map(item => item.innerText || item.textContent || '') };
          }
          const element = matches[options.index];
          if (!element) {
            if (options.action === 'actionability') {
              return {
                ...base,
                found: false,
                element: null,
                actionability: { visible: false, enabled: false, editable: false, reasons: ['not found'] }
              };
            }
            return { ...base, element: null, value: null, text: null };
          }
          if (options.action === 'textContent') {
            return { ...base, text: (element.innerText || element.textContent || '').trim(), element: summarizeElement(element, options.index) };
          }
          if (options.action === 'getAttribute') {
            return { ...base, value: element.getAttribute(options.attributeName), element: summarizeElement(element, options.index) };
          }
          if (options.action === 'actionability') {
            const actionability = getActionability(element, options.actionKind);
            return {
              ...base,
              found: true,
              element: summarizeElement(element, options.index),
              actionability
            };
          }
          return { ...base, element: summarizeElement(element, options.index) };
        }

        function annotateActionabilitySnapshot(snapshot, wait, previousRect) {
          if (wait.strict === true && snapshot.count !== 1) {
            return {
              snapshot: {
                ...snapshot,
                actionability: {
                  ...(snapshot.actionability || {}),
                  stable: false,
                  reasons: [`strict mode expected 1 match, got ${snapshot.count}`]
                }
              },
              nextRect: snapshot.element?.rect || previousRect
            };
          }
          const rect = snapshot.element?.rect || null;
          const stable = wait.requireStable === false || (rect && previousRect && rectsAlmostEqualInPage(rect, previousRect));
          return {
            snapshot: {
              ...snapshot,
              actionability: { ...(snapshot.actionability || {}), stable: stable === true }
            },
            nextRect: rect || previousRect
          };
        }

        function locatorWaitSatisfied(snapshot, wait) {
          if (wait.kind === 'locatorState') {
            const found = snapshot.count > 0;
            const visibleCount = snapshot.visibleCount || 0;
            return (wait.state === 'attached' && found) ||
              (wait.state === 'visible' && visibleCount > 0) ||
              (wait.state === 'hidden' && (!found || visibleCount === 0)) ||
              (wait.state === 'detached' && !found);
          }
          if (wait.kind === 'count') return snapshot.count === wait.expected;
          if (wait.kind === 'text') {
            const actual = Array.isArray(wait.expected) ? snapshot.texts : snapshot.text;
            return matchesExpectedTextInPage(actual, wait.expected, wait.match || {});
          }
          if (wait.kind === 'attribute') {
            return matchesExpectedTextInPage(snapshot.value || '', wait.expected, wait.match || {});
          }
          if (wait.kind === 'elementState') {
            const element = snapshot.element;
            if (!element) return false;
            if (wait.assertion === 'toBeEnabled') return (element.disabled === false) === wait.expected;
            if (wait.assertion === 'toBeDisabled') return element.disabled === true;
            if (wait.assertion === 'toBeEditable') return (element.editable === true) === wait.expected;
            if (wait.assertion === 'toBeChecked') return element.checked === wait.expected;
            if (wait.assertion === 'toHaveValue') return matchesExpectedTextInPage(element.value || '', wait.expected, wait.match || {});
          }
          if (wait.kind === 'actionability') {
            const checks = snapshot.actionability || {};
            return snapshot.found === true &&
              checks.visible === true &&
              (wait.actionKind === 'screenshot' || checks.enabled === true) &&
              (wait.actionKind !== 'click' || checks.receivesEvents === true) &&
              checks.stable === true &&
              (wait.actionKind !== 'fill' || checks.editable === true) &&
              (wait.actionKind !== 'select' || checks.selectable === true) &&
              (wait.strict !== true || snapshot.count === 1);
          }
          return false;
        }

        function rectsAlmostEqualInPage(a, b) {
          return Math.abs(a.x - b.x) < 0.5 &&
            Math.abs(a.y - b.y) < 0.5 &&
            Math.abs(a.width - b.width) < 0.5 &&
            Math.abs(a.height - b.height) < 0.5;
        }

        function matchesExpectedTextInPage(actual, expected, options) {
          if (Array.isArray(expected)) {
            if (!Array.isArray(actual) || actual.length !== expected.length) return false;
            return expected.every((item, index) => matchesExpectedTextValueInPage(actual[index] || '', item, options));
          }
          return matchesExpectedTextValueInPage(String(actual || ''), expected, options);
        }

        function matchesExpectedTextValueInPage(actual, expected, options) {
          if (options.regex === true) {
            try {
              return new RegExp(String(expected), options.caseSensitive === true ? '' : 'i').test(String(actual ?? ''));
            } catch {
              return false;
            }
          }
          const normalizeWhitespace = options.normalizeWhitespace !== false;
          const contains = options.contains === true;
          const caseSensitive = options.caseSensitive === true;
          let left = normalizeWhitespace ? actual.replace(/\s+/g, ' ').trim() : actual;
          let right = normalizeWhitespace ? String(expected).replace(/\s+/g, ' ').trim() : String(expected);
          if (!caseSensitive) {
            left = left.toLowerCase();
            right = right.toLowerCase();
          }
          return contains ? left.includes(right) : left === right;
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

        function findLocatorMatches(root, locator) {
          if (locator.within) {
            // locator.locator() scoping: resolve the parent(s) first, then match
            // the child within each parent subtree (descendants only), deduped.
            const parents = findLocatorMatches(root, locator.within);
            const childLocator = { ...locator, within: null };
            const seen = new Set();
            const out = [];
            for (const parent of parents) {
              for (const match of findLocatorMatches(parent, childLocator)) {
                if (seen.has(match)) continue;
                seen.add(match);
                out.push(match);
              }
            }
            return out;
          }
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
          if (locator.hasText && !matchesText(visibleText(element), locator.hasText, locator)) return false;
          if (locator.hasNotText && matchesText(visibleText(element), locator.hasNotText, locator)) return false;
          if (locator.hasAttribute && !matchesAttributeFilter(element, locator.hasAttribute, locator)) return false;
          if (locator.hasNotAttribute && matchesAttributeFilter(element, locator.hasNotAttribute, locator)) return false;
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

        function matchesAttributeFilter(element, filter, locator) {
          if (!filter || typeof filter !== 'object') return false;
          const name = typeof filter.name === 'string' ? filter.name : '';
          if (!name) return false;
          if (!element.hasAttribute(name)) return filter.present === false;
          if (filter.present === true) return true;
          if (filter.present === false) return false;
          if (typeof filter.value !== 'string') return true;
          return matchesText(element.getAttribute(name) || '', filter.value, {
            ...locator,
            exact: filter.exact === true || locator.exact === true,
            caseSensitive: filter.caseSensitive === true || locator.caseSensitive === true
          });
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
          return domA11y.accessibleName(element, root);
        }

        function inferredRole(element) {
          return domA11y.implicitRole(element, root);
        }

        function firstExplicitRole(element) {
          return domA11y.firstExplicitRole(element);
        }

        // Pure text/visibility predicates live in the shared dom-a11y atom;
        // delegate so the logic has a single, unit-tested home.
        function headingLevel(element) {
          return domA11y.headingLevel(element);
        }

        function ariaBooleanState(element, state) {
          return domA11y.ariaBooleanState(element, state);
        }

        function matchesDisabled(element, expected) {
          return domA11y.matchesDisabled(element, expected);
        }

        function visibleText(element) {
          return domA11y.visibleText(element);
        }

        function isVisible(element) {
          return domA11y.isVisible(element);
        }

        function isAriaHidden(element) {
          return domA11y.isAriaHidden(element);
        }

        function isHiddenForRole(element) {
          return domA11y.isHiddenForRole(element);
        }

        function isEnabled(element) {
          return domA11y.isEnabled(element);
        }

        function isEditable(element) {
          return domA11y.isEditable(element);
        }

        function isTextInputElement(element) {
          return domA11y.isTextInputElement(element);
        }

        function matchesText(value, expected, locator) {
          return domA11y.matchesText(value, expected, locator);
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

        // Deep DOM query helpers live in the shared dom-a11y atom; delegate so
        // the logic has a single, unit-tested home.
        function querySelectorDeep(root, selector) {
          return domA11y.querySelectorDeep(root, selector);
        }

        function querySelectorAllDeep(root, selector) {
          return domA11y.querySelectorAllDeep(root, selector);
        }

        function getElementByIdDeep(root, id) {
          return domA11y.getElementByIdDeep(root, id);
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
    const withinSource = objectOrNull(params.within, nested.within);
    const locator = {
      within: withinSource ? normalizeLocatorParams({ locator: withinSource }) : null,
      selector: pickString('selector'),
      text: params._ignoreTopLevelTextLocator ? stringOrNull(nested.text) : pickString('text'),
      hasText: pickString('hasText'),
      hasNotText: pickString('hasNotText'),
      role: pickString('role'),
      name: pickString('name'),
      label: pickString('label'),
      placeholder: pickString('placeholder'),
      hasAttribute: objectOrNull(params.hasAttribute, nested.hasAttribute),
      hasNotAttribute: objectOrNull(params.hasNotAttribute, nested.hasNotAttribute),
      frameSelector: pickString('frameSelector'),
      exact: params.exact === true || nested.exact === true,
      regex: params.regex === true || nested.regex === true,
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

  function objectOrNull(value, nestedValue) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) return nestedValue;
    return null;
  }

  function integerOrNull(value, nestedValue) {
    if (Number.isInteger(value)) return value;
    if (Number.isInteger(nestedValue)) return nestedValue;
    return null;
  }

  function normalizeTargetLocatorParams(params) {
    const target = params.targetLocator || params.target;
    if (!target || typeof target !== 'object') {
      if (typeof params.targetSelector === 'string' && params.targetSelector) {
        return inheritFrameParams(params, { selector: params.targetSelector });
      }
      throw new Error('locator.dragTo requires targetLocator, target, or targetSelector');
    }
    return inheritFrameParams(params, { locator: target });
  }

  function inheritFrameParams(source, target) {
    return {
      tabId: source.tabId,
      ...target,
      ...(Number.isInteger(source.targetFrameId) ? { frameId: source.targetFrameId } : {}),
      ...(typeof source.targetFrameUrl === 'string' ? { frameUrl: source.targetFrameUrl } : {}),
      ...(typeof source.targetFrameSelector === 'string' ? { frameSelector: source.targetFrameSelector } : {}),
      ...(!Number.isInteger(source.targetFrameId) && typeof source.targetFrameUrl !== 'string' && typeof source.targetFrameSelector !== 'string' && Number.isInteger(source.frameId) ? { frameId: source.frameId } : {}),
      ...(!Number.isInteger(source.targetFrameId) && typeof source.targetFrameUrl !== 'string' && typeof source.targetFrameSelector !== 'string' && typeof source.frameUrl === 'string' ? { frameUrl: source.frameUrl } : {}),
      ...(!Number.isInteger(source.targetFrameId) && typeof source.targetFrameUrl !== 'string' && typeof source.targetFrameSelector !== 'string' && typeof source.frameSelector === 'string' ? { frameSelector: source.frameSelector } : {})
    };
  }

  async function setFilesOnMarkedInput(tabId, markerName, markerValue, files) {
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

  function normalizeExpectedCount(params) {
    const value = params.count ?? params.expected ?? params.value;
    if (!Number.isInteger(value) || value < 0) throw new Error('expect.locator.toHaveCount requires a non-negative integer count');
    return value;
  }

  function normalizeExpectedText(params) {
    const value = params.expectedText ?? params.expected ?? params.value;
    if (Array.isArray(value)) {
      if (!value.every(item => typeof item === 'string')) throw new Error('Expected text array must contain only strings');
      return value;
    }
    if (typeof value !== 'string') throw new Error('expect.locator.toHaveText requires expectedText, expected, or value');
    return value;
  }

  function matchesExpectedText(actual, expected, params) {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) return false;
      return expected.every((item, index) => matchesExpectedTextValue(actual[index] || '', item, params));
    }
    return matchesExpectedTextValue(String(actual || ''), expected, params);
  }

  function matchesExpectedTextValue(actual, expected, params) {
    if (params.regex === true) {
      try {
        return new RegExp(String(expected), params.caseSensitive === true ? '' : 'i').test(String(actual ?? ''));
      } catch {
        return false;
      }
    }
    const normalizeWhitespace = params.normalizeWhitespace !== false;
    const contains = params.contains === true;
    const caseSensitive = params.caseSensitive === true;
    let left = normalizeWhitespace ? actual.replace(/\s+/g, ' ').trim() : actual;
    let right = normalizeWhitespace ? expected.replace(/\s+/g, ' ').trim() : expected;
    if (!caseSensitive) {
      left = left.toLowerCase();
      right = right.toLowerCase();
    }
    return contains ? left.includes(right) : left === right;
  }

  function locatorTextMatchOptions(params) {
    return {
      regex: params.regex === true,
      caseSensitive: params.caseSensitive === true,
      normalizeWhitespace: params.normalizeWhitespace !== false,
      contains: params.contains === true
    };
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
    return ['selector', 'role', 'name', 'text', 'hasText', 'hasNotText', 'label', 'placeholder']
      .filter(key => locator[key])
      .map(key => `${key}=${JSON.stringify(locator[key])}`)
      .join(', ') || '<empty>';
  }

  function locatorSpecForRecording(params) {
    const locator = normalizeLocatorParams(params);
    return Object.fromEntries(Object.entries(locator).filter(([, value]) => value !== null));
  }

  async function locatorBoundingBox(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.boundingBox');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    // summarize only requires the element to exist; do not scroll the page.
    const result = await runLocatorScript(tabId, { ...params, index, scrollIntoView: false }, 'summarize', frameTarget);
    const rect = result.element?.rect || null;
    return { boundingBox: rect, element: result.element, frame: frameTarget.frame };
  }

  async function locatorFocus(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'locator.focus');
    const index = Number.isInteger(params.index) && params.index >= 0 ? params.index : 0;
    const frameTarget = await resolveFrameTarget(tabId, params);
    const result = await runLocatorScript(tabId, { ...params, index, force: true }, 'focus', frameTarget);
    await recordAction(tabId, 'locator.focus', { locator: locatorSpecForRecording(params), index, frameSelector: params.frameSelector || params.locator?.frameSelector || null, frameId: frameTarget.frameId }, result);
    return { ok: true, element: result.element, frame: frameTarget.frame };
  }

  return {
    locatorCount,
    locatorTextContent,
    locatorAllTextContents,
    locatorAllInnerTexts,
    locatorGetAttribute,
    locatorNth,
    locatorFirst,
    locatorLast,
    locatorWaitFor,
    locatorBoundingBox,
    locatorFocus,
    expectLocatorToBeVisible,
    expectLocatorToBeHidden,
    expectLocatorToBeEnabled,
    expectLocatorToBeDisabled,
    expectLocatorToBeEditable,
    expectLocatorToBeChecked,
    expectLocatorToHaveValue,
    expectLocatorToHaveCount,
    expectLocatorToHaveText,
    expectLocatorToHaveAttribute,
    locatorClickRef,
    locatorClick,
    locatorDragTo,
    locatorScreenshot,
    locatorDispatchDragDrop,
    locatorFill,
    locatorPress,
    locatorPressSequentially,
    locatorCheck,
    locatorUncheck,
    locatorSelectOption,
    locatorSetInputFiles
  };
}
