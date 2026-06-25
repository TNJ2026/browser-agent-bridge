export function createDevtoolsHandlers({
  assertTabId,
  assertTabAllowed,
  attachDebugger,
  cdp,
  consoleEventsByTab,
  networkEventsByTab,
  fetchInterceptorsByTab
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

  async function networkSetBlockedUrls(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.setBlockedUrls');
    const urls = Array.isArray(params.urls) ? params.urls : [];
    await attachDebugger(tabId);
    await cdp(tabId, 'Network.enable').catch(() => {});
    await cdp(tabId, 'Network.setBlockedURLs', { urls });
    return { ok: true, urls };
  }

  async function networkSetInterceptors(params) {
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'network.setInterceptors');
    const rules = Array.isArray(params.rules) ? params.rules : [];
    await attachDebugger(tabId);
    if (rules.length > 0) {
      fetchInterceptorsByTab.set(tabId, rules);
      await cdp(tabId, 'Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }]
      });
    } else {
      fetchInterceptorsByTab.delete(tabId);
      await cdp(tabId, 'Fetch.disable').catch(() => {});
    }
    return { ok: true, rulesCount: rules.length };
  }

  return {
    consoleRead,
    networkRead,
    networkSetBlockedUrls,
    networkSetInterceptors
  };
}
