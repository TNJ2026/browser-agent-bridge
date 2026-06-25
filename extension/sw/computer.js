export function createComputerHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  assertNumber,
  attachDebugger,
  cdp,
  indicatorSet,
  recordAction,
  keyboardDispatcher
}) {
  async function computerClick(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.click');
    await attachDebugger(tabId);
    const x = assertNumber(params.x, 'x');
    const y = assertNumber(params.y, 'y');
    const button = params.button || 'left';
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount: params.clickCount || 1
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount: params.clickCount || 1
    });
    if (params.showIndicator === true) {
      await indicatorSet({ tabId, visible: true, x, y, label: params.indicatorLabel || 'click' }).catch(() => {});
    }
    await recordAction(tabId, 'computer.click', { x, y, button, clickCount: params.clickCount || 1 });
    return { ok: true };
  }

  async function computerDrag(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.drag');
    await attachDebugger(tabId);
    const fromX = assertNumber(params.fromX, 'fromX');
    const fromY = assertNumber(params.fromY, 'fromY');
    const toX = assertNumber(params.toX, 'toX');
    const toY = assertNumber(params.toY, 'toY');
    const button = params.button || 'left';
    const steps = Number.isInteger(params.steps) && params.steps > 0 ? params.steps : 12;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button, clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: fromX + (toX - fromX) * t,
        y: fromY + (toY - fromY) * t,
        button,
        buttons: 1
      });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, clickCount: 1 });
    if (params.showIndicator === true) {
      await indicatorSet({ tabId, visible: true, x: toX, y: toY, label: params.indicatorLabel || 'drag' }).catch(() => {});
    }
    await recordAction(tabId, 'computer.drag', { fromX, fromY, toX, toY, button, steps });
    return { ok: true };
  }

  async function computerType(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.type');
    assertString(params.text, 'text');
    await attachDebugger(tabId);
    await keyboardDispatcher.typeText(tabId, params.text, params);
    await recordAction(tabId, 'computer.type', { text: params.text });
    return { ok: true };
  }

  async function computerKey(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.key');
    assertString(params.key, 'key');
    await attachDebugger(tabId);
    await keyboardDispatcher.press(tabId, params.key, params);
    await recordAction(tabId, 'computer.key', { key: params.key });
    return { ok: true };
  }

  async function computerScroll(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.scroll');
    await attachDebugger(tabId);
    const x = typeof params.x === 'number' ? params.x : 400;
    const y = typeof params.y === 'number' ? params.y : 400;
    const deltaX = typeof params.deltaX === 'number' ? params.deltaX : 0;
    const deltaY = typeof params.deltaY === 'number' ? params.deltaY : 500;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY
    });
    await recordAction(tabId, 'computer.scroll', { x, y, deltaX, deltaY });
    return { ok: true };
  }

  async function computerHover(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'computer.hover');
    await attachDebugger(tabId);
    const x = assertNumber(params.x, 'x');
    const y = assertNumber(params.y, 'y');
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    });
    if (params.showIndicator === true) {
      await indicatorSet({ tabId, visible: true, x, y, label: params.indicatorLabel || 'hover' }).catch(() => {});
    }
    await recordAction(tabId, 'computer.hover', { x, y });
    return { ok: true };
  }

  return {
    computerClick,
    computerDrag,
    computerType,
    computerKey,
    computerScroll,
    computerHover
  };
}
