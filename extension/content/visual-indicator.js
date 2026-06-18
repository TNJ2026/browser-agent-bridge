(() => {
  if (globalThis.__localBrowserAgentVisualIndicatorLoaded) return;
  globalThis.__localBrowserAgentVisualIndicatorLoaded = true;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes local-agent-pulse {
      0% { transform: scale(0.8); opacity: 0.8; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .local-agent-ripple {
      position: absolute;
      left: 0;
      top: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #19a7ce;
      animation: local-agent-pulse 1.5s infinite ease-out;
      pointer-events: none;
      box-sizing: border-box;
    }
  `;
  document.documentElement.append(style);

  const root = document.createElement('div');
  root.id = 'local-browser-agent-indicator';
  root.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483647',
    'pointer-events:none',
    'display:none',
    'transform:translate3d(24px,24px,0)',
    'transition:transform 160ms ease, opacity 160ms ease',
    'opacity:0.95'
  ].join(';');

  const dot = document.createElement('div');
  dot.style.cssText = [
    'width:18px',
    'height:18px',
    'border-radius:50%',
    'background:#19a7ce',
    'box-shadow:0 0 0 3px rgba(25,167,206,.25),0 8px 22px rgba(0,0,0,.22)',
    'border:2px solid white',
    'position:relative'
  ].join(';');

  const ripple = document.createElement('div');
  ripple.className = 'local-agent-ripple';
  dot.append(ripple);

  const label = document.createElement('div');
  label.style.cssText = [
    'position:absolute',
    'left:24px',
    'top:-2px',
    'max-width:160px',
    'border-radius:6px',
    'padding:3px 7px',
    'color:#fff',
    'background:rgba(0,0,0,.72)',
    'font:12px/1.3 system-ui,sans-serif',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis'
  ].join(';');

  root.append(dot, label);
  document.documentElement.append(root);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'SET_VISUAL_INDICATOR') return false;
    const state = message.state || {};
    if (state.visible === false) {
      root.style.display = 'none';
    } else {
      const x = typeof state.x === 'number' ? state.x : 24;
      const y = typeof state.y === 'number' ? state.y : 24;
      root.style.display = 'block';
      root.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
      label.textContent = state.label || 'agent';
    }
    sendResponse({ ok: true });
    return true;
  });

  chrome.runtime.sendMessage({ type: 'VISUAL_INDICATOR_READY' }).catch(() => {});
})();
