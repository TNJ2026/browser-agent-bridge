const POLICY_STORAGE_KEY = 'browserAgentBridgePolicy';
const DEFAULT_POLICY = {
  blockedUrlPatterns: [
    'chrome://*',
    'chrome-extension://*',
    'chromewebstore.google.com/*'
  ],
  allowedUrlPatterns: [],
  blockedMethods: [],
  allowedMethods: []
};

export function createPolicyHandlers({ chromeApi = chrome }) {
  async function loadPolicy() {
    const result = await chromeApi.storage.local.get(POLICY_STORAGE_KEY);
    const stored = result[POLICY_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_POLICY };
    return {
      blockedUrlPatterns: normalizePatternList(stored.blockedUrlPatterns, DEFAULT_POLICY.blockedUrlPatterns),
      allowedUrlPatterns: normalizePatternList(stored.allowedUrlPatterns),
      blockedMethods: normalizePatternList(stored.blockedMethods, DEFAULT_POLICY.blockedMethods),
      allowedMethods: normalizePatternList(stored.allowedMethods)
    };
  }

  async function assertMethodAllowed(method) {
    const alwaysAllowed = new Set(['extension.info', 'native.status', 'policy.get', 'policy.checkUrl', 'permission.check']);
    if (alwaysAllowed.has(method)) return;
    const policy = await loadPolicy();
    if (!isMethodAllowedByPolicy(method, policy)) {
      const pattern = firstMatchingPattern(method, policy.blockedMethods);
      throw new Error(`Method blocked by policy: ${method}${pattern ? ` (matched ${pattern})` : ''}`);
    }
  }

  async function assertUrlAllowed(url, action) {
    if (!url || url === 'about:blank') return;
    const policy = await loadPolicy();
    if (!isUrlAllowedByPolicy(url, policy)) {
      const pattern = firstMatchingPattern(url, policy.blockedUrlPatterns);
      throw new Error(`${action} blocked by policy for ${url}${pattern ? ` (matched ${pattern})` : ''}`);
    }
  }

  async function policyGet() {
    return await loadPolicy();
  }

  async function policySet(params) {
    const policy = {
      blockedUrlPatterns: normalizePatternList(params.blockedUrlPatterns),
      allowedUrlPatterns: normalizePatternList(params.allowedUrlPatterns),
      blockedMethods: normalizePatternList(params.blockedMethods),
      allowedMethods: normalizePatternList(params.allowedMethods)
    };
    await chromeApi.storage.local.set({ [POLICY_STORAGE_KEY]: policy });
    return { policy };
  }

  async function policyCheckUrl(params) {
    if (typeof params.url !== 'string' && typeof params.method !== 'string') {
      throw new Error('policy.checkUrl requires url or method');
    }
    const policy = await loadPolicy();
    return {
      url: params.url,
      method: params.method,
      allowed: (typeof params.url === 'string' ? isUrlAllowedByPolicy(params.url, policy) : true)
        && (typeof params.method === 'string' ? isMethodAllowedByPolicy(params.method, policy) : true),
      matchedBlockedPattern: typeof params.url === 'string' ? firstMatchingPattern(params.url, policy.blockedUrlPatterns) : null,
      matchedAllowedPattern: typeof params.url === 'string' ? firstMatchingPattern(params.url, policy.allowedUrlPatterns) : null,
      matchedBlockedMethod: typeof params.method === 'string' ? firstMatchingPattern(params.method, policy.blockedMethods) : null,
      matchedAllowedMethod: typeof params.method === 'string' ? firstMatchingPattern(params.method, policy.allowedMethods) : null
    };
  }

  return {
    loadPolicy,
    assertMethodAllowed,
    assertUrlAllowed,
    policyGet,
    policySet,
    policyCheckUrl,
    isUrlAllowedByPolicy,
    isMethodAllowedByPolicy,
    firstMatchingPattern
  };
}

function isUrlAllowedByPolicy(url, policy) {
  const allowed = firstMatchingPattern(url, policy.allowedUrlPatterns);
  if (allowed) return true;
  return !firstMatchingPattern(url, policy.blockedUrlPatterns);
}

function isMethodAllowedByPolicy(method, policy) {
  const allowed = firstMatchingPattern(method, policy.allowedMethods);
  if (allowed) return true;
  return !firstMatchingPattern(method, policy.blockedMethods);
}

function firstMatchingPattern(url, patterns) {
  for (const pattern of patterns || []) {
    if (urlPatternMatches(url, pattern)) return pattern;
  }
  return null;
}

function urlPatternMatches(url, pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function normalizePatternList(value, fallback = []) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [...fallback];
}
