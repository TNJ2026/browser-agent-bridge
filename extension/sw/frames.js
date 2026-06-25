export function createFrameTargetResolver({ chromeApi = chrome } = {}) {
  async function resolveFrameTarget(tabId, params = {}) {
    if (Number.isInteger(params.frameId) && params.frameId >= 0) {
      const frames = await chromeApi.webNavigation.getAllFrames({ tabId }).catch(() => []);
      const frame = frames.find(item => item.frameId === params.frameId) || null;
      if (!frame && params.frameId !== 0) throw new Error(`Frame not found: ${params.frameId}`);
      const frameOffset = params.frameId === 0 ? null : await computeFrameViewportOffset(tabId, frame, frames).catch(() => null);
      return {
        target: params.frameId === 0 ? { tabId } : { tabId, frameIds: [params.frameId] },
        frameId: params.frameId,
        frame: frame ? normalizeFrame(frame) : { frameId: 0, parentFrameId: -1, url: '' },
        frameOffset,
        frameSelector: null
      };
    }

    if (typeof params.frameUrl === 'string' && params.frameUrl) {
      const frames = await chromeApi.webNavigation.getAllFrames({ tabId }).catch(() => []);
      const frame = frames.find(item => frameUrlMatches(item.url || '', params.frameUrl));
      if (!frame) throw new Error(`Frame not found for URL: ${params.frameUrl}`);
      const frameOffset = frame.frameId === 0 ? null : await computeFrameViewportOffset(tabId, frame, frames).catch(() => null);
      return {
        target: frame.frameId === 0 ? { tabId } : { tabId, frameIds: [frame.frameId] },
        frameId: frame.frameId,
        frame: normalizeFrame(frame),
        frameOffset,
        frameSelector: null
      };
    }

    return {
      target: { tabId },
      frameId: 0,
      frame: { frameId: 0, parentFrameId: -1, url: '' },
      frameOffset: null,
      frameSelector: typeof params.frameSelector === 'string' && params.frameSelector ? params.frameSelector : null
    };
  }

  async function computeFrameViewportOffset(tabId, frame, frames) {
    if (!frame || frame.frameId === 0) return { x: 0, y: 0 };
    const chain = [];
    let current = frame;
    while (current && current.frameId !== 0) {
      chain.unshift(current);
      current = frames.find(item => item.frameId === current.parentFrameId) || null;
    }

    let offset = { x: 0, y: 0 };
    for (const child of chain) {
      const parentFrameId = child.parentFrameId;
      const [{ result }] = await chromeApi.scripting.executeScript({
        target: parentFrameId === 0 ? { tabId } : { tabId, frameIds: [parentFrameId] },
        func: (childUrl, childName) => {
          const frames = Array.from(document.querySelectorAll('iframe,frame'));
          const candidates = frames.map(frame => {
            const rect = frame.getBoundingClientRect();
            let src = frame.getAttribute('src') || '';
            try {
              src = src ? new URL(src, document.baseURI).href : '';
            } catch {}
            return {
              src,
              name: frame.getAttribute('name') || '',
              id: frame.id || '',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          });
          return candidates.find(item => item.src === childUrl)
            || candidates.find(item => childName && (item.name === childName || item.id === childName))
            || candidates.find(item => item.src && (item.src.startsWith(childUrl) || childUrl.startsWith(item.src)))
            || (candidates.length === 1 ? candidates[0] : null)
            || null;
        },
        args: [child.url || '', child.name || ''],
        world: 'MAIN'
      });
      if (!result?.rect) return null;
      offset = { x: offset.x + result.rect.x, y: offset.y + result.rect.y };
    }
    return offset;
  }

  return { resolveFrameTarget };
}

function frameUrlMatches(actual, expected) {
  if (actual === expected) return true;
  try {
    return new URL(actual).href === new URL(expected).href;
  } catch {
    return actual.includes(expected);
  }
}

function normalizeFrame(frame) {
  return {
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    processId: frame.processId,
    url: frame.url || '',
    errorOccurred: frame.errorOccurred === true
  };
}
