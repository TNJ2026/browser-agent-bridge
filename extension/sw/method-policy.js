// Pure classification of RPC methods for the two approval gates in
// service-worker.js. Kept out of the (untested) service-worker monolith so the
// security-relevant mappings can be pinned by tests:
//   - optionalPermissionsForMethod: which Chrome optional permissions a method
//     needs (enforced by assertOptionalPermissions before dispatch).
//   - getMethodCategory: the approval category a method prompts under (null = not
//     a sensitive method, no prompt). A wrong/missing mapping means a method is
//     under-prompted or runs without the permission it needs.
// Neither function touches chrome.* or async state — both are pure.

export function optionalPermissionsForMethod(method, params = {}) {
  if (method === 'cookies.get') return ['tabs'];
  if (method === 'tabs.create') return ['tabs', 'tabGroups'];
  if (method === 'tabs.group') return ['tabs', 'tabGroups'];
  if (method.startsWith('tabs.')) return ['tabs'];
  if (method.startsWith('session.')) return ['tabs', 'tabGroups'];
  if (method === 'downloads.list' || method === 'downloads.waitFor' || method === 'downloads.download') return ['downloads'];
  if (method === 'recording.export' && params.download === true) return ['downloads'];
  if ((method === 'trace.export' || method === 'trace.exportHtml') && params.download === true) return ['downloads'];
  if (
    method.startsWith('page.') ||
    method.startsWith('dom.') ||
    method.startsWith('locator.') ||
    method.startsWith('computer.') ||
    method === 'console.read' ||
    method === 'network.read' ||
    method === 'network.getResponseBody' ||
    method === 'network.setBlockedUrls' ||
    method === 'network.setInterceptors' ||
    method === 'network.routeFromHAR' ||
    method === 'network.interceptors.clear' ||
    method === 'network.interceptors.events' ||
    method === 'network.interceptors.clearEvents' ||
    method === 'network.interceptors.status' ||
    method === 'recording.start'
  ) {
    return ['tabs'];
  }
  return [];
}

export function getMethodCategory(method, params = {}) {
  // Cookie reads expose httpOnly session tokens — a dedicated category that is
  // never auto-allowed in-boundary (see isAgentTabGroupOperation), so it always
  // prompts for approval.
  if (method === 'cookies.get') return 'cookies';
  if (method === 'tabs.list' || method === 'session.list' || method === 'session.get') {
    return 'read_tabs';
  }
  if (method === 'tabs.close' || method === 'session.closeTab' || method === 'session.stop') {
    return 'tab_control';
  }
  if (method === 'downloads.list' || method === 'downloads.waitFor' || method === 'downloads.download') {
    return 'read_downloads';
  }
  if (
    method === 'page.executeJavaScript' ||
    method === 'page.waitForFunction' ||
    method === 'page.addInitScript' ||
    method === 'page.removeInitScript'
  ) {
    return 'page_script';
  }
  if (method === 'page.screenshot' || method === 'page.pdf' || method === 'page.domSnapshot' || method === 'locator.screenshot') {
    return 'page_screenshot';
  }
  if (
    method === 'dom.type' ||
    method === 'locator.fill' ||
    method === 'locator.focus' ||
    method === 'locator.press' ||
    method === 'locator.pressSequentially' ||
    method === 'computer.type' ||
    method === 'computer.key' ||
    method === 'keyboard.type' ||
    method === 'keyboard.compose' ||
    method === 'keyboard.press' ||
    method === 'keyboard.down' ||
    method === 'keyboard.up'
  ) {
    return 'page_input';
  }
  if (
    method === 'dom.click' ||
    method === 'dom.dragTo' ||
    method === 'dom.dispatchDragDrop' ||
    method === 'locator.click' ||
    method === 'locator.clickRef' ||
    method === 'locator.dragTo' ||
    method === 'locator.dispatchDragDrop' ||
    method === 'locator.check' ||
    method === 'locator.uncheck' ||
    method === 'locator.selectOption' ||
    method === 'locator.setInputFiles' ||
    method === 'dom.select' ||
    method === 'dom.setInputFiles' ||
    method === 'page.setExtraHTTPHeaders' ||
    method === 'page.setUserAgent' ||
    method === 'page.acceptDialog' ||
    method === 'page.dismissDialog' ||
    method === 'computer.click' ||
    method === 'computer.drag'
  ) {
    return 'page_action';
  }
  if (method === 'network.setBlockedUrls' || method === 'network.setInterceptors' || method === 'network.routeFromHAR' || method === 'network.interceptors.clear') {
    return 'page_action';
  }
  if (
    method === 'console.read' ||
    method === 'network.read' ||
    method === 'network.getResponseBody' ||
    method === 'network.interceptors.status' ||
    method === 'network.interceptors.events' ||
    method === 'network.interceptors.clearEvents'
  ) {
    return 'page_logs';
  }
  if (
    method === 'recording.status' ||
    method === 'recording.stop' ||
    method === 'recording.export' ||
    method === 'recording.clear'
  ) {
    return 'recording_data';
  }
  if (
    method === 'trace.start' ||
    method === 'trace.status' ||
    method === 'trace.stop' ||
    method === 'trace.export' ||
    method === 'trace.exportHtml' ||
    method === 'trace.clear'
  ) {
    return 'trace_data';
  }
  if (method === 'policy.set') {
    return 'policy_admin';
  }
  return null;
}
