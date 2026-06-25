export function createDevtoolsHandlers({
  assertTabId,
  assertTabAllowed,
  attachDebugger,
  cdp,
  consoleEventsByTab,
  networkEventsByTab
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

  return {
    consoleRead,
    networkRead
  };
}
