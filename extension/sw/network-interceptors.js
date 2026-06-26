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

  function events(tabId, limit = 100) {
    const allEvents = interceptorEventsByTab.get(tabId) || [];
    return { tabId, events: cloneEvents(allEvents.slice(-limit)) };
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

function redactHeaderMap(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    isSensitiveHeaderName(name) && value !== null ? '[redacted]' : value
  ]));
}

function isSensitiveHeaderName(name) {
  return ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'].includes(String(name).toLowerCase());
}
