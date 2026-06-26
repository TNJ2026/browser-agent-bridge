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

function framesChromeApi(frames) {
  return {
    webNavigation: { async getAllFrames() { return frames; } },
    scripting: { async executeScript() { return [{ result: null }]; } }
  };
}

const NESTED_FRAMES = [
  { frameId: 0, parentFrameId: -1, processId: 1, url: 'https://host.example/page', name: '' },
  { frameId: 7, parentFrameId: 0, processId: 1, url: 'https://embed.example/a', name: 'outer' },
  { frameId: 12, parentFrameId: 7, processId: 1, url: 'https://embed.example/b', name: 'inner' }
];

test('resolveFrameTarget by frameId attaches a root-to-target framePath', async () => {
  const { createFrameTargetResolver } = await importFramesModule();
  const resolver = createFrameTargetResolver({ chromeApi: framesChromeApi(NESTED_FRAMES) });
  const result = await resolver.resolveFrameTarget(1, { frameId: 12 });

  assert.deepEqual(result.frame.framePath.map(f => f.frameId), [0, 7, 12]);
  assert.equal(result.frame.framePath[1].name, 'outer');
  assert.equal(result.frame.framePath[2].url, 'https://embed.example/b');
});

test('resolveFrameTarget by frameUrl builds the framePath', async () => {
  const { createFrameTargetResolver } = await importFramesModule();
  const resolver = createFrameTargetResolver({ chromeApi: framesChromeApi(NESTED_FRAMES) });
  const result = await resolver.resolveFrameTarget(1, { frameUrl: 'https://embed.example/b' });

  assert.deepEqual(result.frame.framePath.map(f => f.frameId), [0, 7, 12]);
});

test('main frame resolves to a single-entry framePath', async () => {
  const { createFrameTargetResolver } = await importFramesModule();
  const resolver = createFrameTargetResolver({ chromeApi: framesChromeApi(NESTED_FRAMES) });
  const result = await resolver.resolveFrameTarget(1, { frameId: 0 });

  assert.deepEqual(result.frame.framePath, [{ frameId: 0, url: 'https://host.example/page', name: '' }]);
});

test('frameSelector targeting keeps a root framePath and records the selector', async () => {
  const { createFrameTargetResolver } = await importFramesModule();
  const resolver = createFrameTargetResolver({ chromeApi: framesChromeApi(NESTED_FRAMES) });
  const result = await resolver.resolveFrameTarget(1, { frameSelector: '#editor' });

  assert.deepEqual(result.frame.framePath, [{ frameId: 0, url: '', name: '' }]);
  assert.equal(result.frame.frameSelector, '#editor');
});

