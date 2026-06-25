import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importFramesModule() {
  const source = await readFile(new URL('../extension/sw/frames.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeFrameElement({ src = '', srcdoc = false, id = '', name = '', href = '', rect }) {
  return {
    id,
    contentWindow: { location: { href } },
    getAttribute(attribute) {
      if (attribute === 'src') return src;
      if (attribute === 'name') return name;
      return '';
    },
    hasAttribute(attribute) {
      return attribute === 'srcdoc' && srcdoc;
    },
    getBoundingClientRect() {
      return rect;
    }
  };
}

test('resolveFrameTarget computes viewport offset for srcdoc frames', async () => {
  const { createFrameTargetResolver } = await importFramesModule();
  const frames = [
    { frameId: 0, parentFrameId: -1, processId: 1, url: 'file:///tmp/page.html' },
    { frameId: 7, parentFrameId: 0, processId: 1, url: 'about:srcdoc' }
  ];
  const iframe = makeFrameElement({
    srcdoc: true,
    href: 'about:srcdoc',
    rect: { x: 120.5, y: 240.25, width: 400, height: 150 }
  });
  const chromeApi = {
    webNavigation: {
      async getAllFrames() {
        return frames;
      }
    },
    scripting: {
      async executeScript({ target, func, args }) {
        assert.deepEqual(target, { tabId: 42 });
        const previousDocument = globalThis.document;
        globalThis.document = {
          querySelectorAll(selector) {
            assert.equal(selector, 'iframe,frame');
            return [iframe];
          }
        };
        try {
          return [{ result: func(...args) }];
        } finally {
          if (previousDocument === undefined) {
            delete globalThis.document;
          } else {
            globalThis.document = previousDocument;
          }
        }
      }
    }
  };

  const resolver = createFrameTargetResolver({ chromeApi });
  const result = await resolver.resolveFrameTarget(42, { frameId: 7 });

  assert.deepEqual(result.target, { tabId: 42, frameIds: [7] });
  assert.deepEqual(result.frameOffset, { x: 120.5, y: 240.25 });
  assert.equal(result.frame.url, 'about:srcdoc');
});

