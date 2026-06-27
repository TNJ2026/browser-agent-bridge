(() => {
  if (globalThis.__browserAgentBridgeDomA11y) return;

  function accessibleName(el, root = document) {
    if (isAriaHidden(el)) return '';
    return accessibleNameInternal(el, root, new Set()).trim().replace(/\s+/g, ' ').slice(0, 500);
  }

  function accessibleNameInternal(el, root, visited) {
    if (!el || visited.has(el)) return '';
    visited.add(el);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const value = labelledBy.split(/\s+/)
        .map(id => getElementByIdDeep(root, id))
        .filter(Boolean)
        .map(label => accessibleNameInternal(label, root, visited) || visibleText(label))
        .join(' ')
        .trim();
      if (value) return value;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.id) {
      const label = querySelectorDeep(root, `label[for="${cssEscape(el.id)}"]`);
      if (label) return visibleText(label);
    }
    const wrappingLabel = el.closest?.('label');
    if (wrappingLabel) return visibleText(wrappingLabel);
    if (tag === 'img' || tag === 'area') return el.getAttribute('alt') || '';
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
      return el.value || el.getAttribute('value') || defaultInputButtonName(type);
    }
    if (tag === 'button') return visibleText(el);
    if (tag === 'fieldset') {
      const legend = Array.from(el.children || []).find(child => child.tagName?.toLowerCase() === 'legend');
      if (legend) return visibleText(legend);
    }
    if (tag === 'table') {
      const caption = querySelectorDeep(el, ':scope > caption');
      if (caption) return visibleText(caption);
    }
    return [
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      visibleText(el),
      'value' in el ? String(el.value) : ''
    ].filter(Boolean).join(' ').trim();
  }

  function implicitRole(el, root = document) {
    const explicit = firstExplicitRole(el);
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'area' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || ['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea' || (tag === 'input' && ['email', 'password', 'tel', 'text', 'url', ''].includes(type))) return 'textbox';
    if (tag === 'input' && type === 'search') return 'searchbox';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'input' && type === 'range') return 'slider';
    if (tag === 'input' && type === 'number') return 'spinbutton';
    if (tag === 'option') return 'option';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'article') return 'article';
    if (tag === 'aside') return 'complementary';
    if (tag === 'body') return 'document';
    if (tag === 'form' && accessibleName(el, root)) return 'form';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'section' && accessibleName(el, root)) return 'region';
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

  function firstExplicitRole(el) {
    const role = el.getAttribute('role');
    if (!role) return '';
    const token = role.trim().split(/\s+/).find(Boolean);
    if (!token || token === 'none' || token === 'presentation') return '';
    return token.toLowerCase();
  }

  function visibleText(el) {
    if (isAriaHidden(el)) return '';
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function isAriaHidden(el) {
    return Boolean(el.closest?.('[aria-hidden="true"]'));
  }

  function defaultInputButtonName(type) {
    if (type === 'submit') return 'Submit';
    if (type === 'reset') return 'Reset';
    return '';
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
    return querySelectorDeep(root, `#${cssEscape(id)}`);
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

  function isHiddenForRole(element) {
    return !isVisible(element) || isAriaHidden(element);
  }

  function isEnabled(element) {
    return !Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('fieldset[disabled]'));
  }

  function isTextInputElement(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
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

  function matchesDisabled(element, expected) {
    return expected ? !isEnabled(element) : isEnabled(element);
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

  function matchesText(value, expected, locator) {
    if (locator.regex === true) {
      try {
        return new RegExp(String(expected), locator.caseSensitive ? '' : 'i').test(String(value));
      } catch {
        return false;
      }
    }
    const source = locator.caseSensitive ? String(value) : String(value).toLowerCase();
    const needle = locator.caseSensitive ? String(expected) : String(expected).toLowerCase();
    return locator.exact ? source.trim() === needle.trim() : source.includes(needle);
  }

  globalThis.__browserAgentBridgeDomA11y = {
    accessibleName,
    implicitRole,
    firstExplicitRole,
    visibleText,
    isAriaHidden,
    cssEscape,
    querySelectorDeep,
    querySelectorAllDeep,
    getElementByIdDeep,
    isVisible,
    isHiddenForRole,
    isEnabled,
    isEditable,
    isTextInputElement,
    matchesDisabled,
    headingLevel,
    ariaBooleanState,
    matchesText
  };
})();
