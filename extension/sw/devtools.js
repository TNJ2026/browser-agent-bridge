import { fetchPatternsForRules, harEntriesToRules } from './network-interceptors.js';

export function createDevtoolsHandlers({
  assertTabId,
  assertTabAllowed,
  attachDebugger,
  cdp,
  consoleEventsByTab,
  networkEventsByTab,
  fetchInterceptorsByTab,
  interceptorStatus = () => ({ tabs: [] }),
  clearInterceptors = async tabId => ({ ok: true, tabId, rulesCount: 0 }),
  interceptorEvents = (tabId, limit) => ({ tabId, events: [], limit }),
  clearInterceptorEvents = tabId => ({ ok: true, tabId, eventsCount: 0 })
}) {
  async function consoleRead(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'console.read');
    await attachDebugger(tabId);
    await cdp(tabId, 'Runtime.enable').catch(() => {});
    return { events: (consoleEventsByTab.get(tabId) || []).slice(-(params.limit || 100)) };
  }

  async function networkRead(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.read');
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});
    return { events: (networkEventsByTab.get(tabId) || []).slice(-(params.limit || 100)) };
  }

  async function networkGetResponseBody(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.getResponseBody');
    if (typeof params.requestId !== 'string' || !params.requestId) {
      throw new Error('network.getResponseBody requires a requestId');
    }
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});
    const result = await cdp(tabId, 'Network.getResponseBody', { requestId: params.requestId });
    // CDP returns the raw body: text when base64Encoded is false, a base64
    // string otherwise. Forwarded as-is so callers decode binary deliberately.
    return {
      requestId: params.requestId,
      base64Encoded: result?.base64Encoded === true,
      body: typeof result?.body === 'string' ? result.body : ''
    };
  }

  async function networkSetBlockedUrls(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.setBlockedUrls');
    const urls = normalizeBlockedUrls(params.urls);
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});
    await cdp(tabId, 'Network.setBlockedURLs', { urls });
    return { ok: true, urls };
  }

  async function networkSetInterceptors(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.setInterceptors');
    const rules = normalizeInterceptorRules(params.rules);
    await attachDebugger(tabId);
    if (rules.length > 0) {
      fetchInterceptorsByTab.set(tabId, rules);
      await cdp(tabId, 'Fetch.enable', {
        patterns: fetchPatternsForRules(rules)
      });
    } else {
      fetchInterceptorsByTab.delete(tabId);
      await cdp(tabId, 'Fetch.disable').catch(() => {});
    }
    return { ok: true, rulesCount: rules.length };
  }

  async function networkRouteFromHAR(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.routeFromHAR');
    const rules = harEntriesToRules(params.har, params);
    await attachDebugger(tabId);
    if (rules.length > 0) {
      fetchInterceptorsByTab.set(tabId, rules);
      await cdp(tabId, 'Fetch.enable', { patterns: fetchPatternsForRules(rules) });
    } else {
      fetchInterceptorsByTab.delete(tabId);
      await cdp(tabId, 'Fetch.disable').catch(() => {});
    }
    return {
      ok: true,
      rulesCount: rules.length,
      entriesRouted: rules.filter(rule => rule.action === 'mock').length,
      notFound: params.notFound === 'abort' ? 'abort' : 'fallback'
    };
  }

  async function networkInterceptorsStatus(params = {}) {
    const tabId = params.tabId == null ? null : assertTabId(params.tabId);
    if (tabId != null) await assertTabAllowed(tabId, 'network.interceptors.status');
    return interceptorStatus(tabId);
  }

  async function networkInterceptorsClear(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.interceptors.clear');
    return clearInterceptors(tabId);
  }

  async function networkInterceptorsEvents(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.interceptors.events');
    return interceptorEvents(tabId, normalizeInterceptorEventFilter(params));
  }

  async function networkInterceptorsClearEvents(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.interceptors.clearEvents');
    return clearInterceptorEvents(tabId);
  }

  return {
    consoleRead,
    networkRead,
    networkGetResponseBody,
    networkSetBlockedUrls,
    networkSetInterceptors,
    networkRouteFromHAR,
    networkInterceptorsClear,
    networkInterceptorsClearEvents,
    networkInterceptorsEvents,
    networkInterceptorsStatus
  };
}

function normalizeBlockedUrls(urls) {
  if (urls == null) return [];
  if (!Array.isArray(urls)) throw new Error('network.setBlockedUrls requires urls to be an array of strings');
  return urls.map((url, index) => {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`network.setBlockedUrls urls[${index}] must be a non-empty string`);
    }
    return url;
  });
}

function normalizeInterceptorRules(rules) {
  if (rules == null) return [];
  if (!Array.isArray(rules)) throw new Error('network.setInterceptors requires rules to be an array');
  const normalized = rules.map((rule, index) => normalizeInterceptorRule(rule, index));
  const ids = new Set();
  for (const rule of normalized) {
    if (ids.has(rule.id)) throw new Error(`network.setInterceptors rule id must be unique: ${rule.id}`);
    ids.add(rule.id);
  }
  return normalized;
}

function normalizeInterceptorRule(rule, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`network.setInterceptors rules[${index}] must be an object`);
  }
  const hasUrlPattern = typeof rule.urlPattern === 'string' && rule.urlPattern.length > 0;
  const hasUrlRegex = typeof rule.urlRegex === 'string' && rule.urlRegex.length > 0;
  if (!hasUrlPattern && !hasUrlRegex) {
    throw new Error(`network.setInterceptors rules[${index}] requires urlPattern or urlRegex`);
  }
  if (rule.urlPattern != null && !hasUrlPattern) {
    throw new Error(`network.setInterceptors rules[${index}].urlPattern must be a non-empty string`);
  }
  if (rule.urlRegex != null) {
    if (!hasUrlRegex) throw new Error(`network.setInterceptors rules[${index}].urlRegex must be a non-empty string`);
    try {
      new RegExp(rule.urlRegex);
    } catch {
      throw new Error(`network.setInterceptors rules[${index}].urlRegex must be a valid regular expression`);
    }
  }
  if (rule.postDataContains != null && (typeof rule.postDataContains !== 'string' || rule.postDataContains.length === 0)) {
    throw new Error(`network.setInterceptors rules[${index}].postDataContains must be a non-empty string`);
  }
  if (rule.postDataRegex != null) {
    if (typeof rule.postDataRegex !== 'string' || rule.postDataRegex.length === 0) {
      throw new Error(`network.setInterceptors rules[${index}].postDataRegex must be a non-empty string`);
    }
    try {
      new RegExp(rule.postDataRegex);
    } catch {
      throw new Error(`network.setInterceptors rules[${index}].postDataRegex must be a valid regular expression`);
    }
  }
  const headerContains = normalizeOptionalHeaderMatcherMap(rule.headerContains, `network.setInterceptors rules[${index}].headerContains`);
  const headerRegex = normalizeOptionalHeaderMatcherMap(rule.headerRegex, `network.setInterceptors rules[${index}].headerRegex`, { regex: true });

  const action = rule.action || 'block';
  if (!['block', 'redirect', 'mock', 'modifyHeaders'].includes(action)) {
    throw new Error(`network.setInterceptors rules[${index}].action is invalid`);
  }

  const id = rule.id == null ? `rule-${index + 1}` : rule.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`network.setInterceptors rules[${index}].id must be a non-empty string`);
  }

  const normalized = { ...rule, id, action, urlPattern: hasUrlPattern ? rule.urlPattern : '*', hitCount: 0 };
  if (hasUrlRegex) normalized.urlRegex = rule.urlRegex;
  if (rule.postDataContains != null) normalized.postDataContains = rule.postDataContains;
  if (rule.postDataRegex != null) normalized.postDataRegex = rule.postDataRegex;
  if (headerContains) normalized.headerContains = headerContains;
  if (headerRegex) normalized.headerRegex = headerRegex;
  const methods = normalizeOptionalStringList(rule.methods ?? rule.method, `network.setInterceptors rules[${index}].method`);
  const resourceTypes = normalizeOptionalStringList(rule.resourceTypes ?? rule.resourceType, `network.setInterceptors rules[${index}].resourceType`);
  if (methods) normalized.methods = methods.map(method => method.toUpperCase());
  if (resourceTypes) normalized.resourceTypes = resourceTypes;
  if (rule.times != null) {
    if (!Number.isInteger(rule.times) || rule.times <= 0) {
      throw new Error(`network.setInterceptors rules[${index}].times must be a positive integer`);
    }
    normalized.times = rule.times;
  }
  if (action === 'block') {
    if (rule.errorReason != null && (typeof rule.errorReason !== 'string' || rule.errorReason.length === 0)) {
      throw new Error(`network.setInterceptors rules[${index}].errorReason must be a non-empty string`);
    }
    normalized.errorReason = rule.errorReason || 'Aborted';
  }
  if (action === 'redirect') {
    if (typeof rule.targetUrl !== 'string' || rule.targetUrl.length === 0) {
      throw new Error(`network.setInterceptors rules[${index}].targetUrl must be a non-empty string`);
    }
  }
  if (action === 'mock') {
    if (rule.responseCode != null && (!Number.isInteger(rule.responseCode) || rule.responseCode < 100 || rule.responseCode > 599)) {
      throw new Error(`network.setInterceptors rules[${index}].responseCode must be an integer between 100 and 599`);
    }
    if (rule.responseBody != null && rule.responseBodyBase64 != null) {
      throw new Error(`network.setInterceptors rules[${index}] requires only one of responseBody or responseBodyBase64`);
    }
    if (rule.responseBodyBase64 != null && !isBase64String(rule.responseBodyBase64)) {
      throw new Error(`network.setInterceptors rules[${index}].responseBodyBase64 must be a valid base64 string`);
    }
    normalized.responseCode = rule.responseCode || 200;
    normalized.responseHeaders = normalizeHeaderMap(rule.responseHeaders, `network.setInterceptors rules[${index}].responseHeaders`);
    normalized.responseBody = rule.responseBody == null ? '' : String(rule.responseBody);
    if (rule.responseBodyBase64 != null) normalized.responseBodyBase64 = rule.responseBodyBase64;
  }
  if (action === 'modifyHeaders') {
    normalized.requestHeaders = normalizeHeaderMap(rule.requestHeaders, `network.setInterceptors rules[${index}].requestHeaders`, { allowNull: true });
  }
  return normalized;
}

function normalizeHeaderMap(headers, label, { allowNull = false } = {}) {
  if (headers == null) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (!name) throw new Error(`${label} contains an empty header name`);
    if (value === null && allowNull) return [name, null];
    if (value === null) throw new Error(`${label}.${name} must not be null`);
    return [name, String(value)];
  }));
}

function normalizeOptionalHeaderMatcherMap(headers, label, { regex = false } = {}) {
  if (headers == null) return null;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(headers);
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  return Object.fromEntries(entries.map(([name, value]) => {
    if (!name) throw new Error(`${label} contains an empty header name`);
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${name} must be a non-empty string`);
    if (regex) {
      try {
        new RegExp(value);
      } catch {
        throw new Error(`${label}.${name} must be a valid regular expression`);
      }
    }
    return [name, value];
  }));
}

function normalizeInterceptorEventFilter(params = {}) {
  const filter = {
    limit: Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 500) : 100
  };
  if (params.ruleId != null) {
    if (typeof params.ruleId !== 'string' || params.ruleId.length === 0) {
      throw new Error('network.interceptors.events ruleId must be a non-empty string');
    }
    filter.ruleId = params.ruleId;
  }
  if (params.action != null) {
    if (!['block', 'redirect', 'mock', 'modifyHeaders'].includes(params.action)) {
      throw new Error('network.interceptors.events action is invalid');
    }
    filter.action = params.action;
  }
  if (params.method != null) {
    if (typeof params.method !== 'string' || params.method.length === 0) {
      throw new Error('network.interceptors.events method must be a non-empty string');
    }
    filter.method = params.method.toUpperCase();
  }
  if (params.urlContains != null) {
    if (typeof params.urlContains !== 'string' || params.urlContains.length === 0) {
      throw new Error('network.interceptors.events urlContains must be a non-empty string');
    }
    filter.urlContains = params.urlContains;
  }
  if (params.since != null) {
    if (!Number.isFinite(params.since) || params.since < 0) {
      throw new Error('network.interceptors.events since must be a non-negative number');
    }
    filter.since = params.since;
  }
  return filter;
}

function isBase64String(value) {
  return typeof value === 'string' &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function normalizeOptionalStringList(value, label) {
  if (value == null) return null;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`${label}${Array.isArray(value) ? `[${index}]` : ''} must be a non-empty string`);
    }
    return item;
  });
}
