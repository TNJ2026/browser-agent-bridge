export function createKeyboardDispatcher({ cdp, sleep = async () => {} }) {
  async function typeText(tabId, text, options = {}) {
    const delayMs = Number.isInteger(options.delayMs) && options.delayMs > 0 ? options.delayMs : 0;
    if (!delayMs) {
      await cdp(tabId, 'Input.insertText', { text });
      return;
    }
    for (const char of Array.from(text)) {
      await cdp(tabId, 'Input.insertText', { text: char });
      await sleep(delayMs);
    }
  }

  async function press(tabId, keyString, options = {}) {
    const { key, modifiers } = parseKeyShortcut(keyString);
    const delayMs = Number.isInteger(options.delayMs) && options.delayMs > 0 ? options.delayMs : 0;
    const modifierState = modifierMask(modifiers);
    for (const modifier of modifiers) {
      modifierState[modifier] = true;
      await dispatchKey(tabId, 'rawKeyDown', keyDefinition(modifier), modifierMaskValue(modifierState));
    }
    await dispatchKey(tabId, 'rawKeyDown', keyDefinition(key), modifierMaskValue(modifierState), {
      autoRepeat: options.autoRepeat === true,
      suppressText: modifierState.Control || modifierState.Meta || modifierState.Alt
    });
    if (delayMs) await sleep(delayMs);
    await dispatchKey(tabId, 'keyUp', keyDefinition(key), modifierMaskValue(modifierState));
    for (const modifier of modifiers.slice().reverse()) {
      modifierState[modifier] = false;
      await dispatchKey(tabId, 'keyUp', keyDefinition(modifier), modifierMaskValue(modifierState));
    }
  }

  async function down(tabId, keyString, options = {}) {
    const { key, modifiers } = parseKeyShortcut(keyString);
    const state = modifierMask(modifiers);
    await dispatchKey(tabId, 'rawKeyDown', keyDefinition(key), modifierMaskValue(state), { autoRepeat: options.autoRepeat === true });
  }

  async function up(tabId, keyString) {
    const { key, modifiers } = parseKeyShortcut(keyString);
    const state = modifierMask(modifiers);
    await dispatchKey(tabId, 'keyUp', keyDefinition(key), modifierMaskValue(state));
  }

  async function dispatchKey(tabId, type, definition, modifiers, options = {}) {
    const text = options.suppressText ? undefined : definition.text;
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      text: type === 'rawKeyDown' ? text : undefined,
      unmodifiedText: type === 'rawKeyDown' ? text : undefined,
      modifiers,
      autoRepeat: options.autoRepeat === true,
      isKeypad: definition.location === 'numpad'
    });
  }

  return { typeText, press, down, up };
}

export function createKeyboardHandlers({
  assertTabId,
  assertTabAllowed,
  assertString,
  attachDebugger,
  recordAction,
  dispatcher
}) {
  async function keyboardType(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'keyboard.type');
    assertString(params.text, 'text');
    await attachDebugger(tabId);
    await dispatcher.typeText(tabId, params.text, params);
    await recordAction(tabId, 'keyboard.type', { text: params.text, delayMs: params.delayMs || 0 });
    return { ok: true };
  }

  async function keyboardPress(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'keyboard.press');
    assertString(params.key, 'key');
    await attachDebugger(tabId);
    await dispatcher.press(tabId, params.key, params);
    await recordAction(tabId, 'keyboard.press', { key: params.key, delayMs: params.delayMs || 0 });
    return { ok: true };
  }

  async function keyboardDown(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'keyboard.down');
    assertString(params.key, 'key');
    await attachDebugger(tabId);
    await dispatcher.down(tabId, params.key, params);
    await recordAction(tabId, 'keyboard.down', { key: params.key });
    return { ok: true };
  }

  async function keyboardUp(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'keyboard.up');
    assertString(params.key, 'key');
    await attachDebugger(tabId);
    await dispatcher.up(tabId, params.key, params);
    await recordAction(tabId, 'keyboard.up', { key: params.key });
    return { ok: true };
  }

  return {
    keyboardType,
    keyboardPress,
    keyboardDown,
    keyboardUp
  };
}

function parseKeyShortcut(keyString) {
  const parts = String(keyString).split('+').filter(Boolean);
  const modifiers = [];
  let key = parts.pop() || keyString;
  for (const part of parts) {
    const modifier = normalizeModifier(part);
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier);
    else if (!modifier) key = `${part}+${key}`;
  }
  return { key: normalizeKeyAlias(key), modifiers };
}

function normalizeModifier(key) {
  const lower = String(key).toLowerCase();
  if (lower === 'alt' || lower === 'option') return 'Alt';
  if (lower === 'control' || lower === 'ctrl') return 'Control';
  if (lower === 'meta' || lower === 'command' || lower === 'cmd') return 'Meta';
  if (lower === 'shift') return 'Shift';
  return null;
}

function normalizeKeyAlias(key) {
  const value = String(key);
  const lower = value.toLowerCase();
  const aliases = {
    esc: 'Escape',
    return: 'Enter',
    space: ' ',
    spacebar: ' ',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    up: 'ArrowUp',
    down: 'ArrowDown',
    del: 'Delete',
    cmd: 'Meta',
    command: 'Meta',
    ctrl: 'Control',
    option: 'Alt'
  };
  return aliases[lower] || value;
}

function modifierMask(modifiers) {
  return {
    Alt: modifiers.includes('Alt'),
    Control: modifiers.includes('Control'),
    Meta: modifiers.includes('Meta'),
    Shift: modifiers.includes('Shift')
  };
}

function modifierMaskValue(state) {
  return (state.Alt ? 1 : 0) | (state.Control ? 2 : 0) | (state.Meta ? 4 : 0) | (state.Shift ? 8 : 0);
}

function keyDefinition(key) {
  const normalized = normalizeKeyAlias(key);
  if (normalized.length === 1) {
    const upper = normalized.toUpperCase();
    const isDigit = /^[0-9]$/.test(normalized);
    return {
      key: normalized,
      code: normalized === ' ' ? 'Space' : isDigit ? `Digit${normalized}` : `Key${upper}`,
      keyCode: normalized === ' ' ? 32 : upper.charCodeAt(0),
      text: normalized
    };
  }

  const table = {
    Alt: ['Alt', 'AltLeft', 18],
    Backspace: ['Backspace', 'Backspace', 8],
    Control: ['Control', 'ControlLeft', 17],
    Delete: ['Delete', 'Delete', 46],
    End: ['End', 'End', 35],
    Enter: ['Enter', 'Enter', 13, '\r'],
    Escape: ['Escape', 'Escape', 27],
    Home: ['Home', 'Home', 36],
    Insert: ['Insert', 'Insert', 45],
    Meta: ['Meta', 'MetaLeft', 91],
    PageDown: ['PageDown', 'PageDown', 34],
    PageUp: ['PageUp', 'PageUp', 33],
    Shift: ['Shift', 'ShiftLeft', 16],
    Tab: ['Tab', 'Tab', 9, '\t'],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 'ArrowRight', 39],
    ArrowUp: ['ArrowUp', 'ArrowUp', 38]
  };
  if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    const index = Number(normalized.slice(1));
    return { key: normalized, code: normalized, keyCode: 111 + index, text: undefined };
  }
  const def = table[normalized] || [normalized, normalized, 0];
  return { key: def[0], code: def[1], keyCode: def[2], text: def[3] };
}
