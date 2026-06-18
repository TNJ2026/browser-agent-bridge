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

    function isElementVisible(el, rect, style) {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (rect.bottom < -200 || rect.right < -200) return false;
      return true;
    }

    function hasInteractiveDescendants(el) {
      return el.querySelector('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"],[role]') !== null;
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

      const role = el.getAttribute('role') || implicitRole(el);
      const isInteractive = Boolean(role || el.matches('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]'));

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
