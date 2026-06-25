export function createDownloadsHandlers({ chromeApi = chrome }) {
  const downloadEvents = [];
  const maxEvents = 500;

  function initDownloadEvents() {
    chromeApi.downloads.onCreated.addListener(item => {
      pushDownloadEvent({ type: 'created', item, timestamp: Date.now() });
    });
    chromeApi.downloads.onChanged.addListener(delta => {
      pushDownloadEvent({ type: 'changed', delta, timestamp: Date.now() });
    });
  }

  async function downloadsList(params) {
    const query = {
      limit: Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50,
      orderBy: ['-startTime'],
      ...(typeof params.query === 'string' && params.query ? { query: [params.query] } : {}),
      ...(typeof params.filenameRegex === 'string' ? { filenameRegex: params.filenameRegex } : {}),
      ...(typeof params.urlRegex === 'string' ? { urlRegex: params.urlRegex } : {})
    };
    const items = await chromeApi.downloads.search(query);
    return {
      items: items.map(item => ({
        id: item.id,
        url: item.url,
        finalUrl: item.finalUrl,
        filename: item.filename,
        mime: item.mime,
        state: item.state,
        danger: item.danger,
        exists: item.exists,
        paused: item.paused,
        startTime: item.startTime,
        endTime: item.endTime,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes
      }))
    };
  }

  async function downloadsWaitFor(params) {
    const timeoutMs = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : 30000;
    const intervalMs = Number.isInteger(params.intervalMs) && params.intervalMs > 0 ? params.intervalMs : 250;
    const state = typeof params.state === 'string' && params.state ? params.state : 'complete';
    const started = Date.now();

    while (Date.now() - started <= timeoutMs) {
      const item = await findMatchingDownload(params, state, started);
      if (item) return { ok: true, item: normalizeDownloadItem(item), elapsedMs: Date.now() - started };
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for download${describeDownloadPattern(params)} to be ${state}`);
  }

  async function findMatchingDownload(params, state, started) {
    const query = {
      limit: 50,
      orderBy: ['-startTime'],
      ...(typeof params.query === 'string' && params.query ? { query: [params.query] } : {}),
      ...(typeof params.filenameRegex === 'string' && params.filenameRegex ? { filenameRegex: params.filenameRegex } : {}),
      ...(typeof params.urlRegex === 'string' && params.urlRegex ? { urlRegex: params.urlRegex } : {})
    };
    const items = await chromeApi.downloads.search(query);
    return items.find(item => {
      if (!matchesDownloadItem(item, params)) return false;
      if (params.includeExisting !== true && Date.parse(item.startTime || '') < started) return false;
      return state === 'any' || item.state === state;
    }) || null;
  }

  function pushDownloadEvent(event) {
    downloadEvents.push(event);
    if (downloadEvents.length > maxEvents) downloadEvents.shift();
  }

  function matchesDownloadItem(item, params) {
    if (Number.isInteger(params.id) && item.id !== params.id) return false;
    if (typeof params.url === 'string' && params.url && item.url !== params.url && item.finalUrl !== params.url) return false;
    if (typeof params.urlContains === 'string' && params.urlContains && !(item.url || '').includes(params.urlContains) && !(item.finalUrl || '').includes(params.urlContains)) return false;
    if (typeof params.filename === 'string' && params.filename && item.filename !== params.filename) return false;
    if (typeof params.filenameContains === 'string' && params.filenameContains && !(item.filename || '').includes(params.filenameContains)) return false;
    return true;
  }

  function normalizeDownloadItem(item) {
    return {
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      state: item.state,
      danger: item.danger,
      exists: item.exists,
      paused: item.paused,
      startTime: item.startTime,
      endTime: item.endTime,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes
    };
  }

  function describeDownloadPattern(params) {
    if (Number.isInteger(params.id)) return ` id=${params.id}`;
    if (typeof params.filenameContains === 'string' && params.filenameContains) return ` filename containing ${params.filenameContains}`;
    if (typeof params.urlContains === 'string' && params.urlContains) return ` URL containing ${params.urlContains}`;
    if (typeof params.query === 'string' && params.query) return ` query=${params.query}`;
    return '';
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    initDownloadEvents,
    downloadsList,
    downloadsWaitFor
  };
}
