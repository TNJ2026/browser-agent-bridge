const CSP_BYPASS_DYNAMIC_RULE_ID = 10001;
const DEFAULT_CSP_BYPASS_TTL_MS = 3 * 60 * 1000;

export const CSP_BYPASS_ALARM = 'clear-temporary-csp-bypass';

export function createCspHandlers({ chromeApi = chrome, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let cspBypassTimer = null;
  let activeCspBypass = null;

  async function initCspBypass() {
    const result = await chromeApi.storage.local.get('bypassCSP');
    let bypass = result.bypassCSP;
    if (bypass === undefined) {
      bypass = true;
      await chromeApi.storage.local.set({ bypassCSP: true });
    }
    await disableStaticCspRuleset();
    await clearTemporaryCspBypass();
  }

  async function disableStaticCspRuleset() {
    const rulesetId = 'ruleset_1';
    await chromeApi.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [rulesetId]
    }).catch(() => {});
  }

  async function extensionGetCspBypass() {
    const result = await chromeApi.storage.local.get('bypassCSP');
    const activeResult = await chromeApi.storage.local.get('cspBypassActive');
    return {
      enabled: result.bypassCSP === true,
      mode: 'temporary-origin',
      active: activeCspBypass || activeResult.cspBypassActive || null
    };
  }

  async function maybeEnableTemporaryCspBypass(tabId, params = {}) {
    const tab = await chromeApi.tabs.get(tabId);
    return maybeEnableTemporaryCspBypassForUrl(tab.url || '', params);
  }

  async function maybeEnableTemporaryCspBypassForUrl(urlString, params = {}) {
    const result = await chromeApi.storage.local.get('bypassCSP');
    if (result.bypassCSP !== true || params.bypassCSP === false) return null;

    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const ttlMs = normalizeCspBypassTtl(params.cspBypassTtlMs);
    const expiresAt = Date.now() + ttlMs;
    await chromeApi.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CSP_BYPASS_DYNAMIC_RULE_ID],
      addRules: [{
        id: CSP_BYPASS_DYNAMIC_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: cspBypassResponseHeaders()
        },
        condition: {
          urlFilter: cspBypassUrlFilter(url.origin),
          resourceTypes: cspBypassResourceTypes()
        }
      }]
    });

    activeCspBypass = {
      origin: url.origin,
      ruleId: CSP_BYPASS_DYNAMIC_RULE_ID,
      expiresAt,
      ttlMs
    };
    await chromeApi.storage.local.set({ cspBypassActive: activeCspBypass });
    clearTimer(cspBypassTimer);
    cspBypassTimer = setTimer(() => {
      clearTemporaryCspBypass().catch(err => console.error('Error clearing temporary CSP bypass:', err));
    }, ttlMs);
    await chromeApi.alarms.create(CSP_BYPASS_ALARM, { when: expiresAt });
    return activeCspBypass;
  }

  async function clearTemporaryCspBypass() {
    clearTimer(cspBypassTimer);
    cspBypassTimer = null;
    activeCspBypass = null;
    await chromeApi.storage.local.remove('cspBypassActive').catch(() => {});
    await chromeApi.alarms.clear(CSP_BYPASS_ALARM).catch(() => {});
    await chromeApi.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CSP_BYPASS_DYNAMIC_RULE_ID]
    }).catch(err => console.error('Error removing temporary CSP bypass rule:', err));
  }

  return {
    initCspBypass,
    extensionGetCspBypass,
    maybeEnableTemporaryCspBypass,
    maybeEnableTemporaryCspBypassForUrl,
    clearTemporaryCspBypass
  };
}

function cspBypassResponseHeaders() {
  return [
    { header: 'content-security-policy', operation: 'remove' },
    { header: 'content-security-policy-report-only', operation: 'remove' },
    { header: 'x-webkit-csp', operation: 'remove' },
    { header: 'x-content-security-policy', operation: 'remove' }
  ];
}

function cspBypassResourceTypes() {
  return [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other'
  ];
}

function cspBypassUrlFilter(origin) {
  return `|${origin}/*`;
}

function normalizeCspBypassTtl(value) {
  if (!Number.isFinite(value)) return DEFAULT_CSP_BYPASS_TTL_MS;
  return Math.max(10 * 1000, Math.min(Math.trunc(value), 10 * 60 * 1000));
}
