const MAX_INTERCEPTOR_EVENTS_PER_TAB = 100;

export function createNetworkInterceptorController({
  cdp,
  fetchInterceptorsByTab,
  interceptorEventsByTab = new Map()
}) {
  async function handleRequestPaused(tabId, params) {
    const rules = fetchInterceptorsByTab.get(tabId) || [];
    const request = params.request || {};

    for (const rule of rules) {
      if (ruleMatchesRequest(rule, params)) {
        if (rule.action === 'block') {
          await cdp(tabId, 'Fetch.failRequest', {
            requestId: params.requestId,
            errorReason: rule.errorReason || 'Aborted'
          });
          await consumeRule(tabId, rules, rule);
          recordHit(tabId, rule, params);
          return;
        }
        if (rule.action === 'redirect') {
          await cdp(tabId, 'Fetch.continueRequest', {
            requestId: params.requestId,
            url: rule.targetUrl
          });
          await consumeRule(tabId, rules, rule);
          recordHit(tabId, rule, params);
          return;
        }
        if (rule.action === 'mock') {
          await cdp(tabId, 'Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: rule.responseCode || 200,
            responseHeaders: headerMapToArray(rule.responseHeaders || {}),
            body: rule.responseBodyBase64 ?? encodeBody(rule.responseBody || '')
          });
          await consumeRule(tabId, rules, rule);
          recordHit(tabId, rule, params);
          return;
        }
        if (rule.action === 'modifyHeaders') {
          await cdp(tabId, 'Fetch.continueRequest', {
            requestId: params.requestId,
            headers: headerMapToArray(mergeRequestHeaders(request.headers || {}, rule.requestHeaders || {}))
          });
          await consumeRule(tabId, rules, rule);
          recordHit(tabId, rule, params);
          return;
        }
      }
    }

    await cdp(tabId, 'Fetch.continueRequest', { requestId: params.requestId });
  }

  function status(tabId = null) {
    if (Number.isInteger(tabId)) {
      return {
        tabId,
        rules: cloneRules(fetchInterceptorsByTab.get(tabId) || []),
        events: cloneEvents(interceptorEventsByTab.get(tabId) || [])
      };
    }
    return {
      tabs: Array.from(fetchInterceptorsByTab.entries()).map(([id, rules]) => ({
        tabId: id,
        rules: cloneRules(rules),
        events: cloneEvents(interceptorEventsByTab.get(id) || [])
      }))
    };
  }

  function events(tabId, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
    const allEvents = interceptorEventsByTab.get(tabId) || [];
    const filtered = allEvents.filter(event => eventMatchesFilter(event, options));
    return { tabId, events: cloneEvents(filtered.slice(-limit)) };
  }

  function clearEvents(tabId) {
    interceptorEventsByTab.delete(tabId);
    return { ok: true, tabId, eventsCount: 0 };
  }

  async function clear(tabId) {
    fetchInterceptorsByTab.delete(tabId);
    interceptorEventsByTab.delete(tabId);
    await cdp(tabId, 'Fetch.disable').catch(() => {});
    return { ok: true, tabId, rulesCount: 0 };
  }

  function onDebuggerDetached(tabId) {
    fetchInterceptorsByTab.delete(tabId);
    interceptorEventsByTab.delete(tabId);
  }

  function onTabRemoved(tabId) {
    fetchInterceptorsByTab.delete(tabId);
    interceptorEventsByTab.delete(tabId);
  }

  async function consumeRule(tabId, rules, rule) {
    rule.hitCount = (rule.hitCount || 0) + 1;
    if (!Number.isInteger(rule.times)) return;
    rule.times -= 1;
    if (rule.times > 0) return;
    const index = rules.indexOf(rule);
    if (index >= 0) rules.splice(index, 1);
    if (rules.length === 0) {
      fetchInterceptorsByTab.delete(tabId);
      await cdp(tabId, 'Fetch.disable').catch(() => {});
    } else {
      await cdp(tabId, 'Fetch.enable', { patterns: fetchPatternsForRules(rules) }).catch(() => {});
    }
  }

  function recordHit(tabId, rule, params) {
    const request = params.request || {};
    const events = interceptorEventsByTab.get(tabId) || [];
    events.push({
      ruleId: rule.id || null,
      action: rule.action,
      requestId: params.requestId || null,
      url: request.url || '',
      method: request.method || '',
      resourceType: params.resourceType || '',
      remainingTimes: Number.isInteger(rule.times) ? Math.max(0, rule.times) : null,
      timestamp: Date.now()
    });
    while (events.length > MAX_INTERCEPTOR_EVENTS_PER_TAB) events.shift();
    interceptorEventsByTab.set(tabId, events);
  }

  return {
    clear,
    clearEvents,
    events,
    handleRequestPaused,
    onDebuggerDetached,
    onTabRemoved,
    status
  };
}

// Convert a HAR archive's entries into `mock` interceptor rules so recorded
// responses can be replayed. Each entry becomes a rule matching its exact
// request URL + method and fulfilling with the recorded status/headers/body.
export function harEntriesToRules(har, options = {}) {
  const log = har && har.log ? har.log : har;
  const entries = Array.isArray(log && log.entries) ? log.entries : null;
  if (!entries) throw new Error('routeFromHAR requires a HAR object with log.entries');

  const urlFilter = typeof options.urlFilter === 'string' && options.urlFilter ? options.urlFilter : null;
  const methods = Array.isArray(options.methods) && options.methods.length
    ? options.methods.map(method => String(method).toUpperCase())
    : null;
  const sequential = options.sequential === true;

  const rules = [];
  let index = 0;
  for (const entry of entries) {
    const request = (entry && entry.request) || {};
    const response = (entry && entry.response) || {};
    const url = typeof request.url === 'string' ? request.url : '';
    const method = String(request.method || 'GET').toUpperCase();
    if (!url) continue;
    if (urlFilter && !url.includes(urlFilter)) continue;
    if (methods && !methods.includes(method)) continue;
    // Skip incomplete entries (status 0 means no response was captured).
    if (!Number.isInteger(response.status) || response.status < 100) continue;

    rules.push({
      id: `har-${index++}`,
      urlPattern: url,
      methods: [method],
      action: 'mock',
      responseCode: response.status,
      responseHeaders: harHeadersToMap(response.headers),
      ...harResponseBody(response.content),
      ...(sequential ? { times: 1 } : {})
    });
  }

  if (options.notFound === 'abort') {
    rules.push({ id: 'har-not-found', urlPattern: '*', action: 'block', errorReason: 'BlockedByClient' });
  }
  return rules;
}

function harHeadersToMap(headers) {
  const map = {};
  if (!Array.isArray(headers)) return map;
  for (const header of headers) {
    if (!header || typeof header.name !== 'string') continue;
    const lower = header.name.toLowerCase();
    if (lower.startsWith(':')) continue; // HTTP/2 pseudo-headers
    // Body is decoded/replayed, so drop transfer-affecting headers.
    if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding') continue;
    map[header.name] = String(header.value ?? '');
  }
  return map;
}

function harResponseBody(content) {
  if (!content || typeof content.text !== 'string') return {};
  if (content.encoding === 'base64') return { responseBodyBase64: content.text };
  return { responseBody: content.text };
}

export function fetchPatternsForRules(rules) {
  const seen = new Set();
  const patterns = [];
  for (const rule of rules) {
    const resourceTypes = rule.resourceTypes || [null];
    for (const resourceType of resourceTypes) {
      const key = `${rule.urlPattern}\n${resourceType || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      patterns.push({
        urlPattern: rule.urlPattern,
        requestStage: 'Request',
        ...(resourceType ? { resourceType } : {})
      });
    }
  }
  return patterns;
}

function ruleMatchesRequest(rule, params) {
  const request = params.request || {};
  const url = request.url || '';
  if (!matchUrlPattern(url, rule.urlPattern)) return false;
  if (typeof rule.urlRegex === 'string' && !(new RegExp(rule.urlRegex)).test(url)) return false;
  const postData = request.postData || '';
  if (typeof rule.postDataContains === 'string' && !postData.includes(rule.postDataContains)) return false;
  if (typeof rule.postDataRegex === 'string' && !(new RegExp(rule.postDataRegex)).test(postData)) return false;
  if (!headersMatch(request.headers || {}, rule.headerContains, 'contains')) return false;
  if (!headersMatch(request.headers || {}, rule.headerRegex, 'regex')) return false;
  if (Array.isArray(rule.methods) && rule.methods.length > 0 && !rule.methods.includes(String(request.method || '').toUpperCase())) {
    return false;
  }
  if (Array.isArray(rule.resourceTypes) && rule.resourceTypes.length > 0 && !rule.resourceTypes.includes(params.resourceType)) {
    return false;
  }
  return true;
}

function matchUrlPattern(url, pattern) {
  if (pattern === '*') return true;
  const regexPattern = '^' + pattern
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexPattern, 'i').test(url);
}

function headersMatch(headers, matchers, mode) {
  if (!matchers) return true;
  for (const [name, expected] of Object.entries(matchers)) {
    const actual = headerValue(headers, name);
    if (actual == null) return false;
    if (mode === 'regex') {
      if (!(new RegExp(expected)).test(actual)) return false;
    } else if (!actual.includes(expected)) {
      return false;
    }
  }
  return true;
}

function headerValue(headers, name) {
  const actualName = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return actualName ? String(headers[actualName]) : null;
}

function headerMapToArray(headers) {
  return Object.entries(headers).filter(([, value]) => value !== null).map(([name, value]) => ({
    name,
    value: String(value)
  }));
}

function mergeRequestHeaders(headers, overrides) {
  const merged = { ...headers };
  for (const [name, value] of Object.entries(overrides)) {
    const existingName = Object.keys(merged).find(item => item.toLowerCase() === name.toLowerCase());
    if (value === null) {
      if (existingName) delete merged[existingName];
      continue;
    }
    if (existingName && existingName !== name) delete merged[existingName];
    merged[name] = value;
  }
  return merged;
}

function encodeBody(body) {
  try {
    return btoa(unescape(encodeURIComponent(body)));
  } catch {
    return btoa(body);
  }
}

function cloneRules(rules) {
  return rules.map(rule => ({
    ...rule,
    ...(rule.requestHeaders ? { requestHeaders: redactHeaderMap(rule.requestHeaders) } : {}),
    ...(rule.headerContains ? { headerContains: redactHeaderMap(rule.headerContains) } : {}),
    ...(rule.headerRegex ? { headerRegex: redactHeaderMap(rule.headerRegex) } : {})
  }));
}

function cloneEvents(events) {
  return events.map(event => ({ ...event }));
}

function eventMatchesFilter(event, options) {
  if (options.ruleId != null && event.ruleId !== options.ruleId) return false;
  if (options.action != null && event.action !== options.action) return false;
  if (options.method != null && event.method !== options.method) return false;
  if (options.urlContains != null && !String(event.url || '').includes(options.urlContains)) return false;
  if (options.since != null && Number(event.timestamp || 0) < options.since) return false;
  return true;
}

function redactHeaderMap(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    isSensitiveHeaderName(name) && value !== null ? '[redacted]' : value
  ]));
}

function isSensitiveHeaderName(name) {
  return ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'].includes(String(name).toLowerCase());
}
