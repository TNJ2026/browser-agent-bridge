const TRACE_STORAGE_KEY = 'browserAgentBridgeTraces';
const DEFAULT_TRACE_MAX_EVENTS = 1000;
const MAX_TRACE_MAX_EVENTS = 10000;
const DEFAULT_TRACE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createTraceHandlers({
  assertString,
  errorMessage,
  chromeApi = chrome,
  now = () => Date.now(),
  cryptoApi = crypto,
  captureFailureContext = null
}) {
  const traces = new Map();
  let tracesLoaded = false;
  let activeTraceId = null;

  async function traceStart(params = {}) {
    await ensureTracesLoaded();
    await pruneExpiredTraces();
    const timestamp = now();
    const trace = {
      id: cryptoApi.randomUUID(),
      name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Trace',
      isTracing: true,
      startedAt: new Date(timestamp).toISOString(),
      stoppedAt: null,
      updatedAt: new Date(timestamp).toISOString(),
      retentionMs: normalizeRetention(params.retentionMs),
      expiresAt: new Date(timestamp + normalizeRetention(params.retentionMs)).toISOString(),
      maxEvents: normalizeMaxEvents(params.maxEvents),
      includeText: params.includeText === true,
      includeParams: params.includeParams !== false,
      includeResults: params.includeResults !== false,
      includeContext: params.includeContext !== false,
      events: []
    };
    traces.set(trace.id, trace);
    activeTraceId = trace.id;
    await saveTracesNow();
    return { trace: summarizeTrace(trace) };
  }

  async function traceStop(params = {}) {
    await ensureTracesLoaded();
    const trace = params.traceId ? requireTrace(params.traceId) : activeTrace();
    trace.isTracing = false;
    trace.stoppedAt = new Date(now()).toISOString();
    trace.updatedAt = trace.stoppedAt;
    if (activeTraceId === trace.id) activeTraceId = null;
    await saveTracesNow();
    return { trace: summarizeTrace(trace) };
  }

  async function traceStatus(params = {}) {
    await ensureTracesLoaded();
    await pruneExpiredTraces();
    if (params.traceId) return { trace: summarizeTrace(requireTrace(params.traceId)) };
    return {
      activeTraceId,
      traces: Array.from(traces.values()).map(summarizeTrace)
    };
  }

  async function traceExport(params = {}) {
    await ensureTracesLoaded();
    await pruneExpiredTraces();
    const trace = params.traceId ? requireTrace(params.traceId) : activeTrace();
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date(now()).toISOString(),
      trace
    };
    if (params.download === true) {
      const filename = safeFilename(params.filename || `${trace.name}-${trace.id}.json`);
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
      const downloadId = await chromeApi.downloads.download({ url, filename, saveAs: params.saveAs === true });
      return { downloadId, trace: summarizeTrace(trace) };
    }
    return payload;
  }

  async function traceExportHtml(params = {}) {
    await ensureTracesLoaded();
    await pruneExpiredTraces();
    const trace = params.traceId ? requireTrace(params.traceId) : activeTrace();
    const html = renderTraceHtml(trace);
    if (params.download === true) {
      const filename = safeFilename(params.filename || `${trace.name}-${trace.id}.html`, 'trace.html');
      const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      const downloadId = await chromeApi.downloads.download({ url, filename, saveAs: params.saveAs === true });
      return { downloadId, trace: summarizeTrace(trace) };
    }
    return { schemaVersion: 1, exportedAt: new Date(now()).toISOString(), trace: summarizeTrace(trace), html };
  }

  async function traceClear(params = {}) {
    await ensureTracesLoaded();
    if (params.traceId) {
      traces.delete(params.traceId);
      if (activeTraceId === params.traceId) activeTraceId = null;
      await saveTracesNow();
      return { cleared: [params.traceId] };
    }
    const ids = Array.from(traces.keys());
    traces.clear();
    activeTraceId = null;
    await saveTracesNow();
    return { cleared: ids };
  }

  async function traceRpcStart(request) {
    await ensureTracesLoaded();
    const trace = getActiveTraceSync();
    if (!trace) return null;
    return {
      traceId: trace.id,
      startedAtMs: now(),
      method: typeof request?.method === 'string' ? request.method : '<invalid>',
      requestId: request?.id
    };
  }

  async function traceRpcEnd(token, request, result) {
    if (!token) return;
    await appendRpcEvent(token, request, { ok: true, result });
  }

  async function traceRpcError(token, request, error) {
    if (!token) return;
    await appendRpcEvent(token, request, { ok: false, error });
  }

  // Records a network interceptor hit (mock/redirect/block/modifyHeaders) on the
  // active trace, so the failure postmortem shows which requests were rerouted.
  async function traceNetworkEvent(hit) {
    if (!hit) return;
    await ensureTracesLoaded();
    const trace = getActiveTraceSync();
    if (!trace || !trace.isTracing) return;
    const event = {
      index: trace.events.length,
      type: 'interceptor',
      action: hit.action || '',
      method: hit.method || '',
      url: hit.url || '',
      resourceType: hit.resourceType || '',
      ruleId: hit.ruleId ?? null,
      requestId: hit.requestId ?? null,
      status: 'ok',
      durationMs: 0,
      timestamp: new Date(Number.isFinite(hit.timestamp) ? hit.timestamp : now()).toISOString()
    };
    pushTraceEvent(trace, event);
    await saveTracesNow();
  }

  async function appendRpcEvent(token, request, outcome) {
    await ensureTracesLoaded();
    const trace = traces.get(token.traceId);
    if (!trace || !trace.isTracing) return;
    const endedAtMs = now();
    const event = {
      index: trace.events.length,
      type: 'rpc',
      method: token.method,
      requestId: token.requestId ?? null,
      timestamp: new Date(token.startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - token.startedAtMs),
      status: outcome.ok ? 'ok' : 'error'
    };
    if (trace.includeParams && request?.params !== undefined) {
      event.params = sanitizeForTrace(request.params, trace);
    }
    if (outcome.ok && trace.includeResults && outcome.result !== undefined) {
      event.result = compactForTrace(outcome.result, trace);
    }
    if (!outcome.ok) {
      event.error = errorMessage(outcome.error);
      const data = errorData(outcome.error);
      if (data) event.errorData = compactForTrace(data, trace);
      if (trace.includeContext && typeof captureFailureContext === 'function') {
        // Best-effort lightweight page snapshot for postmortem. Never let a
        // capture failure mask the original error.
        try {
          const context = await captureFailureContext(request);
          // sanitize (redacts the `text` preview when includeText is false) but
          // keep the structure rather than whole-object truncating it.
          if (context) event.context = sanitizeForTrace(context, trace);
        } catch {
          // ignore capture failures
        }
      }
    }
    pushTraceEvent(trace, event);
    await saveTracesNow();
  }

  function activeTrace() {
    const trace = getActiveTraceSync();
    if (!trace) throw new Error('No active trace');
    return trace;
  }

  function getActiveTraceSync() {
    if (!activeTraceId) {
      for (const trace of traces.values()) {
        if (trace.isTracing) {
          activeTraceId = trace.id;
          break;
        }
      }
    }
    return activeTraceId ? traces.get(activeTraceId) || null : null;
  }

  function requireTrace(traceId) {
    assertString(traceId, 'traceId');
    const trace = traces.get(traceId);
    if (!trace) throw new Error(`Trace not found: ${traceId}`);
    return trace;
  }

  async function ensureTracesLoaded() {
    if (tracesLoaded) return;
    const result = await chromeApi.storage.local.get(TRACE_STORAGE_KEY);
    traces.clear();
    const stored = result[TRACE_STORAGE_KEY];
    if (Array.isArray(stored)) {
      for (const trace of stored) {
        if (!trace || typeof trace.id !== 'string') continue;
        const normalized = normalizeTrace(trace);
        if (!isExpired(normalized)) traces.set(normalized.id, normalized);
      }
    }
    tracesLoaded = true;
    getActiveTraceSync();
  }

  async function pruneExpiredTraces() {
    let changed = false;
    for (const [id, trace] of traces.entries()) {
      if (isExpired(trace)) {
        traces.delete(id);
        if (activeTraceId === id) activeTraceId = null;
        changed = true;
      }
    }
    if (changed) await saveTracesNow();
  }

  async function saveTracesNow() {
    await chromeApi.storage.local.set({
      [TRACE_STORAGE_KEY]: Array.from(traces.values())
    });
  }

  function normalizeTrace(trace) {
    const startedAt = Number.isFinite(Date.parse(trace.startedAt)) ? trace.startedAt : new Date(now()).toISOString();
    const retentionMs = normalizeRetention(trace.retentionMs);
    return {
      id: trace.id,
      name: typeof trace.name === 'string' ? trace.name : 'Trace',
      isTracing: trace.isTracing === true,
      startedAt,
      stoppedAt: typeof trace.stoppedAt === 'string' ? trace.stoppedAt : null,
      updatedAt: typeof trace.updatedAt === 'string' ? trace.updatedAt : null,
      retentionMs,
      expiresAt: Number.isFinite(Date.parse(trace.expiresAt))
        ? trace.expiresAt
        : new Date(Date.parse(startedAt) + retentionMs).toISOString(),
      maxEvents: normalizeMaxEvents(trace.maxEvents),
      includeText: trace.includeText === true,
      includeParams: trace.includeParams !== false,
      includeResults: trace.includeResults !== false,
      includeContext: trace.includeContext !== false,
      events: Array.isArray(trace.events) ? trace.events : []
    };
  }

  function summarizeTrace(trace) {
    return {
      id: trace.id,
      name: trace.name,
      isTracing: trace.isTracing,
      startedAt: trace.startedAt,
      stoppedAt: trace.stoppedAt,
      updatedAt: trace.updatedAt,
      expiresAt: trace.expiresAt,
      retentionMs: trace.retentionMs,
      maxEvents: trace.maxEvents,
      includeText: trace.includeText,
      includeParams: trace.includeParams,
      includeResults: trace.includeResults,
      includeContext: trace.includeContext,
      eventCount: trace.events.length,
      errorCount: trace.events.reduce((count, event) => count + (event.status === 'error' ? 1 : 0), 0)
    };
  }

  function traceErrorSummary(events) {
    return events
      .filter(event => event.status === 'error')
      .map(event => ({
        index: event.index,
        method: event.method || '',
        code: event.errorData?.code || null,
        message: event.error || '',
        diagnostic: event.errorData?.diagnostic || null,
        context: event.context || null
      }));
  }

  function pushTraceEvent(trace, event) {
    trace.events.push(event);
    while (trace.events.length > trace.maxEvents) trace.events.shift();
    trace.events.forEach((item, index) => {
      item.index = index;
    });
    trace.updatedAt = new Date(now()).toISOString();
  }

  function sanitizeForTrace(value, trace) {
    if (Array.isArray(value)) return value.map(item => sanitizeForTrace(item, trace));
    if (!value || typeof value !== 'object') return value;
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      if (!trace.includeText && typeof item === 'string' && ['text', 'value', 'key', 'script'].includes(key)) {
        sanitized[key] = { redacted: true, length: item.length, empty: item.length === 0 };
      } else {
        sanitized[key] = sanitizeForTrace(item, trace);
      }
    }
    return sanitized;
  }

  function compactForTrace(value, trace) {
    const sanitized = sanitizeForTrace(value, trace);
    try {
      const json = JSON.stringify(sanitized);
      if (json.length <= 2000) return sanitized;
      return { truncated: true, preview: json.slice(0, 2000) };
    } catch {
      return { unserializable: true };
    }
  }

  function errorData(error) {
    if (!error || typeof error !== 'object') return null;
    const data = {};
    if (typeof error.code === 'string' && error.code) data.code = error.code;
    if (error.diagnostic && typeof error.diagnostic === 'object') data.diagnostic = error.diagnostic;
    return Object.keys(data).length > 0 ? data : null;
  }

  function normalizeRetention(value) {
    if (!Number.isFinite(value)) return DEFAULT_TRACE_RETENTION_MS;
    return Math.max(60 * 1000, Math.min(Math.trunc(value), MAX_TRACE_RETENTION_MS));
  }

  function normalizeMaxEvents(value) {
    if (!Number.isInteger(value)) return DEFAULT_TRACE_MAX_EVENTS;
    return Math.max(1, Math.min(value, MAX_TRACE_MAX_EVENTS));
  }

  function isExpired(trace) {
    return typeof trace.expiresAt === 'string' && Date.parse(trace.expiresAt) <= now();
  }

  function safeFilename(value, fallback = 'trace.json') {
    return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
  }

  function renderTraceHtml(trace) {
    const events = Array.isArray(trace.events) ? trace.events : [];
    const maxDuration = Math.max(1, ...events.map(event => Number(event.durationMs) || 0));
    const errors = traceErrorSummary(events);
    const errorCount = errors.length;
    const rows = events.map(event => renderTraceEvent(event, maxDuration)).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(trace.name)} trace</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1f2328;--muted:#667085;--line:#d0d5dd;--ok:#177245;--err:#b42318;--bar:#2f6fed;--card:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#101114;--fg:#f2f4f7;--muted:#98a2b3;--line:#344054;--card:#181a20}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:24px 28px 16px;border-bottom:1px solid var(--line);background:var(--card)}
h1{margin:0 0 8px;font-size:22px}
.meta{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted)}
.wrap{padding:20px 28px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:120px}
.stat strong{display:block;font-size:18px}
.event{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0;overflow:hidden}
.event summary{cursor:pointer;display:grid;grid-template-columns:64px 1fr 96px 120px;gap:12px;align-items:center;padding:10px 12px}
.idx{color:var(--muted);font-variant-numeric:tabular-nums}
.method{font-weight:600;overflow-wrap:anywhere}
.status.ok{color:var(--ok)}.status.error{color:var(--err)}
.bar{height:8px;background:color-mix(in srgb,var(--bar) 20%,transparent);border-radius:999px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--bar)}
pre{margin:0;padding:12px;border-top:1px solid var(--line);overflow:auto;white-space:pre-wrap;word-break:break-word}
.failures{background:var(--card);border:1px solid var(--err);border-radius:8px;padding:12px 14px;margin-bottom:16px}
.failures h2{margin:0 0 8px;font-size:15px;color:var(--err)}
.failures ul{margin:0;padding-left:18px}
.failures li{margin:4px 0}
.failures .muted{color:var(--muted);font-size:12px}
code.chip{font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,var(--err) 14%,transparent);color:var(--err);border-radius:4px;padding:1px 5px;margin-left:6px}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(trace.name)}</h1>
<div class="meta"><span>ID ${escapeHtml(trace.id)}</span><span>Started ${escapeHtml(trace.startedAt)}</span><span>Stopped ${escapeHtml(trace.stoppedAt || 'active')}</span></div>
</header>
<main class="wrap">
<section class="stats">
<div class="stat"><strong>${events.length}</strong><span>events</span></div>
<div class="stat"><strong>${errorCount}</strong><span>errors</span></div>
<div class="stat"><strong>${Math.round(events.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0))}ms</strong><span>total duration</span></div>
</section>
${errors.length ? renderTraceFailures(errors) : ''}
${rows || '<p>No events recorded.</p>'}
</main>
</body>
</html>`;
  }

  function renderTraceFailures(errors) {
    const items = errors.map(error => {
      const code = error.code ? `<code class="chip">${escapeHtml(error.code)}</code>` : '';
      const where = error.context?.url ? `<div class="muted">at ${escapeHtml(error.context.url)}</div>` : '';
      return `<li>#${error.index} <strong>${escapeHtml(error.method)}</strong>${code} — ${escapeHtml(error.message)}${where}</li>`;
    }).join('\n');
    return `<section class="failures">
<h2>Failures (${errors.length})</h2>
<ul>${items}</ul>
</section>`;
  }

  function renderTraceEvent(event, maxDuration) {
    const duration = Number(event.durationMs) || 0;
    const width = Math.max(2, Math.round((duration / maxDuration) * 100));
    const isInterceptor = event.type === 'interceptor';
    const detail = isInterceptor
      ? { timestamp: event.timestamp, action: event.action, method: event.method, url: event.url, resourceType: event.resourceType, ruleId: event.ruleId, requestId: event.requestId }
      : {
          timestamp: event.timestamp,
          endedAt: event.endedAt,
          requestId: event.requestId,
          params: event.params,
          result: event.result,
          error: event.error,
          errorData: event.errorData,
          context: event.context
        };
    const label = isInterceptor ? `[${event.action}] ${event.method} ${event.url}`.trim() : (event.method || '');
    const code = event.errorData?.code ? `<code class="chip">${escapeHtml(event.errorData.code)}</code>` : '';
    return `<details class="event" ${event.status === 'error' ? 'open' : ''}>
<summary>
<span class="idx">#${event.index}</span>
<span class="method">${escapeHtml(label)}${code}</span>
<span class="status ${event.status === 'error' ? 'error' : 'ok'}">${escapeHtml(event.status || '')}</span>
<span>${duration}ms</span>
<span class="bar" style="grid-column:1/-1"><span style="width:${width}%"></span></span>
</summary>
<pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
</details>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  return {
    traceStart,
    traceStop,
    traceStatus,
    traceExport,
    traceExportHtml,
    traceClear,
    traceRpcStart,
    traceRpcEnd,
    traceRpcError,
    traceNetworkEvent
  };
}
