export function createDownloadsHandlers({ chromeApi = chrome }) {
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

  return {
    downloadsList
  };
}
