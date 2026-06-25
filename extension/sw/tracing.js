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
  cryptoApi = crypto
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
      eventCount: trace.events.length
    };
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

  function safeFilename(value) {
    return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'trace.json';
  }

  return {
    traceStart,
    traceStop,
    traceStatus,
    traceExport,
    traceClear,
    traceRpcStart,
    traceRpcEnd,
    traceRpcError
  };
}
