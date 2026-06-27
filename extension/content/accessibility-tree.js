(() => {
  if (globalThis.__localBrowserAgentAccessibilityTreeLoaded) return;
  globalThis.__localBrowserAgentAccessibilityTreeLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING_AGENT_BRIDGE_CONTENT') {
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type !== 'GET_ACCESSIBILITY_TREE') return false;
    try {
      sendResponse({ ok: true, tree: buildTree(message.maxNodes || 1000, message.offsetX || 0, message.offsetY || 0) });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });

  function buildTree(maxNodes, initialOffsetX = 0, initialOffsetY = 0) {
    const nodes = [];
    const iframes = [];
    const docView = window;
    let currentIndex = 1;

    const TEXT_BLOCK_TAGS = new Set([
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dt', 'dd', 'span', 'strong', 'em', 'b', 'i', 'code', 'pre', 'mark'
    ]);

    const CONTAINER_ROLES = new Set([
      'document', 'article', 'aside', 'main', 'navigation', 'region', 'form',
      'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'group', 'dialog'
    ]);

    function isElementVisible(el, rect, style) {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }

    function hasInteractiveDescendants(el) {
      return el.querySelector('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"],[role],h1,h2,h3,h4,h5,h6,img,option') !== null;
    }

    function traverse(node, offsetX = 0, offsetY = 0) {
      if (nodes.length >= maxNodes) return;

      // Handle Text Nodes
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = node.textContent.replace(/\s+/g, ' ').trim();
        if (txt) {
          const parentEl = node.parentElement;
          if (parentEl) {
            const rect = parentEl.getBoundingClientRect();
            nodes.push({
              ref: `ref_${currentIndex++}`,
              tag: 'text',
              text: txt,
              bounds: {
                x: Math.round(rect.x + offsetX),
                y: Math.round(rect.y + offsetY),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            });
          }
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;

      // Handle iframe traversal
      if (el.tagName.toLowerCase() === 'iframe') {
        const rect = el.getBoundingClientRect();
        const style = docView.getComputedStyle(el);
        if (!isElementVisible(el, rect, style)) return;

        const absoluteX = Math.round(rect.left + offsetX);
        const absoluteY = Math.round(rect.top + offsetY);

        iframes.push({
          src: el.src || '',
          id: el.id || '',
          name: el.name || '',
          x: absoluteX,
          y: absoluteY,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });

        try {
          const iframeDoc = el.contentDocument || el.contentWindow?.document;
          if (iframeDoc) {
            let child = iframeDoc.body?.firstChild || iframeDoc.documentElement?.firstChild;
            while (child) {
              traverse(child, absoluteX, absoluteY);
              child = child.nextSibling;
            }
            return;
          }
        } catch (e) {
          // Cross-origin iframe
        }
        return;
      }

      const rect = el.getBoundingClientRect();
      const style = docView.getComputedStyle(el);
      if (!isElementVisible(el, rect, style)) {
        if (style.display === 'none') return;
      }

      const role = firstExplicitRole(el) || implicitRole(el);
      const isInteractive = Boolean(
        (role && !CONTAINER_ROLES.has(role)) ||
        el.matches('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]')
      );

      if (isInteractive) {
        const name = accessibleName(el);
        nodes.push({
          ref: `ref_${currentIndex++}`,
          tag: el.tagName.toLowerCase(),
          role: role || undefined,
          name,
          type: el.getAttribute('type') || undefined,
          value: valueOf(el),
          href: el instanceof HTMLAnchorElement ? el.href : undefined,
          bounds: {
            x: Math.round(rect.x + offsetX),
            y: Math.round(rect.y + offsetY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
        // Stop traversing children of interactive elements to prevent redundancy
        return;
      }

      // Non-interactive node handling
      const hasInteractive = hasInteractiveDescendants(el);

      if (hasInteractive) {
        // Traverse all child nodes (both Element and Text nodes)
        let child = el.firstChild;
        while (child) {
          traverse(child, offsetX, offsetY);
          child = child.nextSibling;
        }
      } else {
        const isTextTag = TEXT_BLOCK_TAGS.has(el.tagName.toLowerCase());
        const hasElementChildren = el.children.length > 0;
        
        if (isTextTag || !hasElementChildren) {
          const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (txt) {
            nodes.push({
              ref: `ref_${currentIndex++}`,
              tag: el.tagName.toLowerCase(),
              text: txt.slice(0, 500),
              bounds: {
                x: Math.round(rect.x + offsetX),
                y: Math.round(rect.y + offsetY),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            });
          }
          // Do not traverse children of consolidated text blocks
          return;
        }

        // Traverse only element children for structural non-text-block nodes
        let child = el.firstElementChild;
        while (child) {
          traverse(child, offsetX, offsetY);
          child = child.nextElementSibling;
        }
      }

      // Handle shadow root if present
      if (el.shadowRoot) {
        let child = el.shadowRoot.firstChild;
        while (child) {
          traverse(child, offsetX, offsetY);
          child = child.nextSibling;
        }
      }
    }

    traverse(document.body || document.documentElement, initialOffsetX, initialOffsetY);

    return {
      url: location.href,
      title: document.title,
      nodes,
      iframes,
      truncated: nodes.length >= maxNodes
    };
  }

  // Best-effort DOM a11y helpers. Keep common name/role behavior aligned with
  // extension/sw/locator.js, which uses the same concepts for locator matching.
  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'area' && el.hasAttribute('href')) return 'link';
    const type = (el.getAttribute('type') || '').toLowerCase();
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
    if (tag === 'summary') return 'button';
    if (tag === 'progress') return 'progressbar';
    if (tag === 'meter') return 'meter';
    return '';
  }

  function accessibleName(el) {
    if (isAriaHidden(el)) return '';
    return accessibleNameInternal(el, new Set()).trim().replace(/\s+/g, ' ').slice(0, 500);
  }

  function accessibleNameInternal(el, visited) {
    if (!el || visited.has(el)) return '';
    visited.add(el);
    const doc = el.ownerDocument || document;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const value = labelledBy.split(/\s+/)
        .map(id => doc.getElementById?.(id))
        .filter(Boolean)
        .map(label => accessibleNameInternal(label, visited) || visibleText(label))
        .join(' ')
        .trim();
      if (value) return value;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.id) {
      const label = doc.querySelector?.(`label[for="${cssEscape(el.id)}"]`);
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
      const caption = el.querySelector?.(':scope > caption');
      if (caption) return visibleText(caption);
    }
    return [
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      visibleText(el),
      'value' in el ? String(el.value) : ''
    ].filter(Boolean).join(' ').trim();
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

  function valueOf(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return el.value;
    }
    return undefined;
  }
})();
