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

  globalThis.__browserAgentBridgeDomA11y = {
    accessibleName,
    implicitRole,
    firstExplicitRole,
    visibleText,
    isAriaHidden
  };
})();
