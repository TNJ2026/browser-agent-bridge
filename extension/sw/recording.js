const DEFAULT_RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECORDING_MAX_ACTIONS = 500;
const MAX_RECORDING_MAX_ACTIONS = 5000;
const RECORDINGS_STORAGE_KEY = 'browserAgentBridgeRecordings';

export function createRecordingHandlers({
  assertTabId,
  assertString,
  normalizeTab,
  captureTabScreenshot,
  loadPolicy,
  isUrlAllowedByPolicy,
  errorMessage,
  chromeApi = chrome,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const recordings = new Map();
  let recordingsLoaded = false;
  let recordingsSaveTimer = null;

  async function recordingStart(params) {
    await ensureRecordingsLoaded();
    await pruneExpiredRecordings();
    const tabId = params.tabId == null ? null : assertTabId(params.tabId);
    const hasExplicitGroup = typeof params.groupId === 'number';
    const groupId = hasExplicitGroup ? params.groupId : tabId == null ? null : (await chromeApi.tabs.get(tabId)).groupId;
    if (tabId == null && groupId == null) throw new Error('recording.start requires tabId or groupId');
    const retentionMs = normalizeRecordingRetention(params.retentionMs);
    const maxActions = normalizeRecordingMaxActions(params.maxActions);
    const now = Date.now();
    const recording = {
      id: crypto.randomUUID(),
      name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Recording',
      scope: hasExplicitGroup ? 'group' : 'tab',
      tabId,
      groupId,
      captureScreenshots: params.captureScreenshots === true,
      includeText: params.includeText === true,
      maxActions,
      retentionMs,
      expiresAt: new Date(now + retentionMs).toISOString(),
      isRecording: true,
      startedAt: new Date(now).toISOString(),
      stoppedAt: null,
      actions: []
    };
    recordings.set(recording.id, recording);
    await saveRecordingsNow();
    if (tabId != null && recording.captureScreenshots) {
      await recordAction(tabId, 'recording.initial_state', {}, undefined, recording.id);
    }
    return { recording: summarizeRecording(recording) };
  }

  async function recordingStop(params) {
    await ensureRecordingsLoaded();
    await pruneExpiredRecordings();
    const recording = requireRecording(params.recordingId);
    recording.isRecording = false;
    recording.stoppedAt = new Date().toISOString();
    await saveRecordingsNow();
    return { recording: summarizeRecording(recording) };
  }

  async function recordingStatus(params) {
    await ensureRecordingsLoaded();
    await pruneExpiredRecordings();
    if (params.recordingId) {
      return { recording: summarizeRecording(requireRecording(params.recordingId)) };
    }
    return { recordings: Array.from(recordings.values()).map(summarizeRecording) };
  }

  async function recordingExport(params) {
    await ensureRecordingsLoaded();
    await pruneExpiredRecordings();
    const recording = requireRecording(params.recordingId);
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      recording
    };
    if (params.download === true) {
      const filename = safeFilename(params.filename || `${recording.name}-${recording.id}.json`);
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
      const downloadId = await chromeApi.downloads.download({ url, filename, saveAs: params.saveAs === true });
      return { downloadId, recording: summarizeRecording(recording) };
    }
    return payload;
  }

  async function recordingClear(params) {
    await ensureRecordingsLoaded();
    await pruneExpiredRecordings();
    if (params.recordingId) {
      recordings.delete(params.recordingId);
      await saveRecordingsNow();
      return { cleared: [params.recordingId] };
    }
    const ids = Array.from(recordings.keys());
    recordings.clear();
    await saveRecordingsNow();
    return { cleared: ids };
  }

  async function recordAction(tabId, type, input = {}, result, forcedRecordingId) {
    await ensureRecordingsLoaded();
    const matching = [];
    const tab = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    for (const recording of recordings.values()) {
      if (!recording.isRecording) continue;
      if (forcedRecordingId && recording.id !== forcedRecordingId) continue;
      if (!forcedRecordingId && recording.scope === 'tab' && recording.tabId !== tabId) continue;
      if (!forcedRecordingId && recording.scope === 'group' && recording.groupId !== tab.groupId) continue;
      matching.push(recording);
    }
    for (const recording of matching) {
      const action = {
        index: recording.actions.length,
        type,
        timestamp: new Date().toISOString(),
        tab: normalizeTab(tab),
        input: sanitizeRecordingInput(input, recording),
        ...(result !== undefined ? { result: compactResult(result) } : {})
      };
      if (recording.captureScreenshots && tab.url && isUrlAllowedByPolicy(tab.url, await loadPolicy())) {
        try {
          action.screenshot = await captureTabScreenshot(tabId, { format: 'jpeg', quality: 60 });
        } catch (error) {
          action.screenshotError = errorMessage(error);
        }
      }
      recording.actions.push(action);
      if (recording.actions.length > recording.maxActions) {
        recording.actions.splice(0, recording.actions.length - recording.maxActions);
        recording.actions.forEach((item, index) => {
          item.index = index;
        });
      }
      recording.updatedAt = new Date().toISOString();
    }
    if (matching.length > 0) scheduleRecordingsSave();
  }

  function requireRecording(recordingId) {
    assertString(recordingId, 'recordingId');
    const recording = recordings.get(recordingId);
    if (!recording) throw new Error(`Recording not found: ${recordingId}`);
    return recording;
  }

  async function ensureRecordingsLoaded() {
    if (recordingsLoaded) return;
    const result = await chromeApi.storage.local.get(RECORDINGS_STORAGE_KEY);
    recordings.clear();
    const stored = result[RECORDINGS_STORAGE_KEY];
    let pruned = false;
    if (Array.isArray(stored)) {
      for (const recording of stored) {
        if (!recording || typeof recording.id !== 'string') continue;
        const normalized = normalizeRecording(recording);
        if (isRecordingExpired(normalized)) {
          pruned = true;
          continue;
        }
        recordings.set(normalized.id, normalized);
      }
    }
    recordingsLoaded = true;
    if (pruned) await saveRecordingsNow();
  }

  function normalizeRecording(recording) {
    const startedAtTimestamp = Date.parse(recording.startedAt);
    const startedAt = Number.isFinite(startedAtTimestamp) ? recording.startedAt : new Date().toISOString();
    const startedAtMs = Date.parse(startedAt);
    const retentionMs = normalizeRecordingRetention(recording.retentionMs);
    const expiresAt = Number.isFinite(Date.parse(recording.expiresAt))
      ? recording.expiresAt
      : new Date(startedAtMs + retentionMs).toISOString();
    return {
      id: recording.id,
      name: typeof recording.name === 'string' ? recording.name : 'Recording',
      scope: recording.scope === 'group' ? 'group' : 'tab',
      tabId: Number.isInteger(recording.tabId) ? recording.tabId : null,
      groupId: typeof recording.groupId === 'number' ? recording.groupId : null,
      captureScreenshots: recording.captureScreenshots === true,
      includeText: recording.includeText === true,
      maxActions: normalizeRecordingMaxActions(recording.maxActions),
      retentionMs,
      expiresAt,
      isRecording: recording.isRecording === true,
      startedAt,
      stoppedAt: typeof recording.stoppedAt === 'string' ? recording.stoppedAt : null,
      updatedAt: typeof recording.updatedAt === 'string' ? recording.updatedAt : null,
      actions: Array.isArray(recording.actions) ? recording.actions : []
    };
  }

  function normalizeRecordingRetention(value) {
    if (!Number.isFinite(value)) return DEFAULT_RECORDING_RETENTION_MS;
    return Math.max(60 * 1000, Math.min(Math.trunc(value), MAX_RECORDING_RETENTION_MS));
  }

  function normalizeRecordingMaxActions(value) {
    if (!Number.isInteger(value)) return DEFAULT_RECORDING_MAX_ACTIONS;
    return Math.max(1, Math.min(value, MAX_RECORDING_MAX_ACTIONS));
  }

  function isRecordingExpired(recording) {
    return typeof recording.expiresAt === 'string' && Date.parse(recording.expiresAt) <= Date.now();
  }

  function pruneExpiredRecordingsSync() {
    for (const [id, recording] of recordings.entries()) {
      if (isRecordingExpired(recording)) recordings.delete(id);
    }
  }

  async function pruneExpiredRecordings() {
    const before = recordings.size;
    pruneExpiredRecordingsSync();
    if (recordings.size !== before) await saveRecordingsNow();
  }

  function scheduleRecordingsSave() {
    clearTimer(recordingsSaveTimer);
    recordingsSaveTimer = setTimer(() => {
      saveRecordingsNow().catch(() => {});
    }, 500);
  }

  async function saveRecordingsNow() {
    clearTimer(recordingsSaveTimer);
    recordingsSaveTimer = null;
    pruneExpiredRecordingsSync();
    await chromeApi.storage.local.set({
      [RECORDINGS_STORAGE_KEY]: Array.from(recordings.values())
    });
  }

  function summarizeRecording(recording) {
    return {
      id: recording.id,
      name: recording.name,
      scope: recording.scope,
      tabId: recording.tabId,
      groupId: recording.groupId,
      captureScreenshots: recording.captureScreenshots,
      includeText: recording.includeText,
      maxActions: recording.maxActions,
      retentionMs: recording.retentionMs,
      isRecording: recording.isRecording,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      expiresAt: recording.expiresAt,
      updatedAt: recording.updatedAt,
      actionCount: recording.actions.length
    };
  }

  function sanitizeRecordingInput(input, recording) {
    if (!input || typeof input !== 'object') return input;
    const sanitized = {};
    for (const [key, value] of Object.entries(input)) {
      if ((key === 'text' || key === 'value' || key === 'key') && typeof value === 'string' && !recording.includeText) {
        sanitized[key] = {
          redacted: true,
          length: value.length,
          empty: value.length === 0
        };
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  function compactResult(result) {
    try {
      const json = JSON.stringify(result);
      if (json.length <= 2000) return result;
      return { truncated: true, preview: json.slice(0, 2000) };
    } catch {
      return { unserializable: true };
    }
  }

  function safeFilename(value) {
    return String(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'recording.json';
  }


  async function onTabRemoved(tabId) {
    await ensureRecordingsLoaded();
    let changed = false;
    for (const recording of recordings.values()) {
      if (recording.isRecording && recording.scope === 'tab' && recording.tabId === tabId) {
        recording.isRecording = false;
        recording.stoppedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) scheduleRecordingsSave();
  }

  return {
    recordingStart,
    recordingStop,
    recordingStatus,
    recordingExport,
    recordingClear,
    recordAction,
    onTabRemoved
  };
}
