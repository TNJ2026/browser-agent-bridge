// Single source of truth for "does this RPC method act on a specific tab?".
//
// Consumed by BOTH security gates in service-worker.js, which deliberately ask
// different questions about the same set of methods:
//   - assertRpcTabIsolation: a hard gate — a tab-targeted method MUST target an
//     Agent-managed tab, else the call is rejected.
//   - isAgentTabGroupOperation: a prompt-skip hint — a tab-targeted method on an
//     Agent-managed tab may skip the approval prompt (cookies.get is the
//     exception: tab-targeted but still always prompts).
// Keeping the classification here means the two gates can never drift apart.
//
// NOTE: every method matched here must carry `params.tabId`; the isolation gate
// calls assertTabId(params.tabId) on a match. Adding a tab-less method under one
// of these namespaces would make that gate throw.
export function isTabTargetedMethod(method, params = {}) {
  if (method === 'network.interceptors.status') {
    return params.tabId != null;
  }
  return (
    method.startsWith('page.') ||
    method.startsWith('expect.page.') ||
    method.startsWith('dom.') ||
    method.startsWith('locator.') ||
    method.startsWith('expect.locator.') ||
    method.startsWith('computer.') ||
    method.startsWith('keyboard.') ||
    method.startsWith('network.') ||
    method.startsWith('console.') ||
    method === 'indicator.set' ||
    method === 'cookies.get'
  );
}
