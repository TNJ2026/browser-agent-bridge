(() => {
  if (globalThis.__localBrowserAgentAccessibilityTreeLoaded) return;
  globalThis.__localBrowserAgentAccessibilityTreeLoaded = true;
  const refState = {
    snapshotId: '',
    frameId: 0,
    refs: new Map()
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING_AGENT_BRIDGE_CONTENT') {
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'GET_ACCESSIBILITY_REF_TARGET') {
      try {
        sendResponse({ ok: true, target: resolveRefTarget(message) });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (message?.type !== 'GET_ACCESSIBILITY_TREE') return false;
    try {
      sendResponse({
        ok: true,
        tree: buildTree(
          message.maxNodes || 1000,
          message.offsetX || 0,
          message.offsetY || 0,
          message.snapshotId || '',
          Number.isInteger(message.frameId) ? message.frameId : 0
        )
      });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });

  function buildTree(maxNodes, initialOffsetX = 0, initialOffsetY = 0, snapshotId = '', frameId = 0) {
    const nodes = [];
    const iframes = [];
    const docView = window;
    let currentIndex = 1;
    refState.snapshotId = snapshotId || `snapshot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    refState.frameId = frameId;
    refState.refs = new Map();

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
            const ref = `ref_${currentIndex++}`;
            rememberRef(ref, parentEl, frameId === 0 ? offsetX : 0, frameId === 0 ? offsetY : 0);
            nodes.push({
              ref,
              snapshotId: refState.snapshotId,
              frameId,
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

      const role = globalThis.__browserAgentBridgeDomA11y.implicitRole(el);
      const isInteractive = Boolean(
        (role && !CONTAINER_ROLES.has(role)) ||
        el.matches('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]')
      );

      if (isInteractive) {
        const name = globalThis.__browserAgentBridgeDomA11y.accessibleName(el);
        const ref = `ref_${currentIndex++}`;
        rememberRef(ref, el, frameId === 0 ? offsetX : 0, frameId === 0 ? offsetY : 0);
        nodes.push({
          ref,
          snapshotId: refState.snapshotId,
          frameId,
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
            const ref = `ref_${currentIndex++}`;
            rememberRef(ref, el, frameId === 0 ? offsetX : 0, frameId === 0 ? offsetY : 0);
            nodes.push({
              ref,
              snapshotId: refState.snapshotId,
              frameId,
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
      snapshotId: refState.snapshotId,
      frameId,
      nodes,
      iframes,
      truncated: nodes.length >= maxNodes
    };
  }

  function rememberRef(ref, element, offsetX = 0, offsetY = 0) {
    refState.refs.set(ref, { element, offsetX, offsetY });
  }

  function resolveRefTarget(message) {
    const ref = typeof message.ref === 'string' ? message.ref : '';
    if (!ref) throw new Error('ref is required');
    if (message.snapshotId && message.snapshotId !== refState.snapshotId) {
      throw new Error(`Stale accessibility ref snapshot: ${message.snapshotId}`);
    }
    const entry = refState.refs.get(ref);
    if (!entry?.element || entry.element.isConnected === false) throw new Error(`Accessibility ref not found or stale: ${ref}`);
    return summarizeRefTarget(ref, entry);
  }

  function summarizeRefTarget(ref, entry) {
    const { element, offsetX = 0, offsetY = 0 } = entry;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const localClickPoint = clickablePoint(element, rect);
    const clickPoint = localClickPoint ? { x: localClickPoint.x + offsetX, y: localClickPoint.y + offsetY } : null;
    const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    const enabled = !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    const hitDocument = element.ownerDocument || document;
    const hit = localClickPoint && typeof hitDocument.elementFromPoint === 'function' ? hitDocument.elementFromPoint(localClickPoint.x, localClickPoint.y) : null;
    const receivesEvents = !clickPoint || !hit || element === hit || element.contains(hit);
    const reasons = [];
    if (!visible) reasons.push('not visible');
    if (!enabled) reasons.push('disabled');
    if (!clickPoint) reasons.push('no clickable point');
    if (!receivesEvents) reasons.push('covered by another element');
    return {
      ref,
      snapshotId: refState.snapshotId,
      frameId: refState.frameId,
      element: {
        ref,
        tagName: element.tagName.toLowerCase(),
        id: element.id || '',
        role: element.getAttribute('role') || globalThis.__browserAgentBridgeDomA11y.implicitRole(element) || '',
        accessibleName: globalThis.__browserAgentBridgeDomA11y.accessibleName(element),
        text: (element.innerText || element.textContent || '').trim().slice(0, 500),
        visible,
        disabled: !enabled,
        rect: { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height },
        clickPoint
      },
      actionability: {
        actionable: visible && enabled && Boolean(clickPoint) && receivesEvents,
        visible,
        enabled,
        receivesEvents,
        reasons
      }
    };
  }

  function clickablePoint(element, rect = element.getBoundingClientRect()) {
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    if (width <= 0 || height <= 0) return null;
    return { x: rect.x + width / 2, y: rect.y + height / 2 };
  }

  function valueOf(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return el.value;
    }
    return undefined;
  }
})();
