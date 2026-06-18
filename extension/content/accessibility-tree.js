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

    function traverse(element, offsetX = 0, offsetY = 0) {
      if (nodes.length >= maxNodes) return;
      if (!(element instanceof Element)) return;

      if (element.tagName.toLowerCase() === 'iframe') {
        const rect = element.getBoundingClientRect();
        const absoluteX = Math.round(rect.left + offsetX);
        const absoluteY = Math.round(rect.top + offsetY);

        iframes.push({
          src: element.src || '',
          id: element.id || '',
          name: element.name || '',
          x: absoluteX,
          y: absoluteY,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });

        try {
          const iframeDoc = element.contentDocument || element.contentWindow?.document;
          if (iframeDoc) {
            let child = iframeDoc.body?.firstElementChild || iframeDoc.documentElement?.firstElementChild;
            while (child) {
              traverse(child, absoluteX, absoluteY);
              child = child.nextElementSibling;
            }
            return;
          }
        } catch (e) {
          // Cross-origin iframe, fallback to background-assisted traversal
        }
      }

      const item = describeElement(element, nodes.length + 1, offsetX, offsetY);
      if (item) nodes.push(item);

      if (element.shadowRoot) {
        let child = element.shadowRoot.firstElementChild;
        while (child) {
          traverse(child, offsetX, offsetY);
          child = child.nextElementSibling;
        }
      }

      let child = element.firstElementChild;
      while (child) {
        traverse(child, offsetX, offsetY);
        child = child.nextElementSibling;
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

  function describeElement(el, index, offsetX = 0, offsetY = 0) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const docView = el.ownerDocument?.defaultView || window;
    const style = docView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const role = el.getAttribute('role') || implicitRole(el);
    const name = accessibleName(el);
    const isInteractive = Boolean(role || el.matches('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]'));
    if (!isInteractive && !name) return null;
    return {
      ref: `ref_${index}`,
      tag: el.tagName.toLowerCase(),
      role,
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
    };
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') return 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
    if (aria) return aria.trim().slice(0, 500);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (text) return text.slice(0, 500);
    }
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  }

  function valueOf(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return el.value;
    }
    return undefined;
  }
})();
