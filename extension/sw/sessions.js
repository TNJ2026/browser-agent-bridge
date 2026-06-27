export const SESSION_STORAGE_KEY = 'browserAgentBridgeSessions';
export const AGENT_TAB_GROUPS_STORAGE_KEY = 'browserAgentBridgeAgentTabGroups';

export function createSessionHandlers({
  assertString,
  assertTabId,
  assertUrlAllowed,
  assertTabAllowed,
  normalizeTab,
  errorMessage,
  maybeEnableTemporaryCspBypassForUrl,
  detachDebugger = async () => {},
  chromeApi = chrome
}) {
  async function tabsList(params) {
    const tabs = await chromeApi.tabs.query(params.query || {});
    return {
      tabs: tabs.map(tab => ({
        id: tab.id,
        windowId: tab.windowId,
        groupId: tab.groupId,
        active: tab.active,
        highlighted: tab.highlighted,
        pinned: tab.pinned,
        title: tab.title,
        url: tab.url,
        status: tab.status,
        favIconUrl: tab.favIconUrl
      }))
    };
  }

  async function tabsCreate(params) {
    assertString(params.url, 'url');
    await assertUrlAllowed(params.url, 'tabs.create');
    await maybeEnableTemporaryCspBypassForUrl(params.url, params);
    const tab = await chromeApi.tabs.create({
      url: params.url,
      active: params.active !== false,
      ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
    });
    if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  
    try {
      if (!chromeApi.tabGroups || !chromeApi.tabs.group) {
        throw new Error('Chrome tab groups API is unavailable');
      }
      const groups = await chromeApi.tabGroups.query({ title: '🤖 Agent', windowId: tab.windowId });
      const managedGroups = await loadAgentTabGroups();
      const group = groups.find(item => managedGroups.has(item.id));
      if (group) {
        await chromeApi.tabs.group({ tabIds: [tab.id], groupId: group.id });
      } else {
        const groupId = await chromeApi.tabs.group({ tabIds: [tab.id] });
        await chromeApi.tabGroups.update(groupId, { title: '🤖 Agent', color: 'green' });
        await rememberAgentTabGroup(groupId);
      }
    } catch (e) {
      await chromeApi.tabs.remove(tab.id).catch(() => {});
      throw new Error(`Failed to create Agent-managed tab: ${errorMessage(e)}`);
    }

    return { tab: normalizeTab(await chromeApi.tabs.get(tab.id)) };
  }

  async function tabsActivate(params) {
    const tabId = assertTabId(params.tabId);
    const tab = await chromeApi.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') await chromeApi.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab: normalizeTab(tab) };
  }

  async function tabsClose(params) {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
    await chromeApi.tabs.remove(tabIds);
    return { closed: tabIds };
  }

  async function tabsGroup(params) {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.map(assertTabId) : [assertTabId(params.tabId)];
    const options = { tabIds };
    if (typeof params.groupId === 'number') {
      options.groupId = params.groupId;
    }
    const groupId = await chromeApi.tabs.group(options);
    if (params.title || params.color) {
      await chromeApi.tabGroups.update(groupId, {
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.color ? { color: params.color } : {})
      });
    }
    await rememberAgentTabGroup(groupId).catch(() => {});
    return { groupId };
  }

  async function sessionStart(params) {
    let name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Agent';
    if (!name.startsWith('🤖')) {
      name = `🤖 ${name}`;
    }
    const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
    if (url !== 'about:blank') await assertUrlAllowed(url, 'session.start');
    if (url !== 'about:blank') await maybeEnableTemporaryCspBypassForUrl(url, params);
    const tab = await chromeApi.tabs.create({
      url,
      active: params.active !== false,
      ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {})
    });
    if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
  
    let groupId = null;
    try {
      if (!chromeApi.tabGroups || !chromeApi.tabs.group) {
        throw new Error('Chrome tab groups API is unavailable');
      }
      groupId = await chromeApi.tabs.group({ tabIds: [tab.id] });
      await chromeApi.tabGroups.update(groupId, {
        title: name,
        color: params.color || 'green'
      }).catch(() => {});
      await rememberAgentTabGroup(groupId);
    } catch (e) {
      await chromeApi.tabs.remove(tab.id).catch(() => {});
      throw new Error(`Failed to create Agent session tab group: ${errorMessage(e)}`);
    }

    const session = {
      id: crypto.randomUUID(),
      name,
      groupId,
      mainTabId: tab.id,
      tabIds: [tab.id],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const sessions = await loadSessions();
    sessions[session.id] = session;
    await saveSessions(sessions);
    return { session, tab: normalizeTab(await chromeApi.tabs.get(tab.id)) };
  }

  async function sessionList() {
    const sessions = [];
    for (const session of Object.values(await loadSessions())) {
      if (await isSessionManaged(session)) sessions.push(session);
    }
    return { sessions };
  }

  async function sessionGet(params) {
    const session = await requireSession(params.sessionId);
    const tabs = [];
    for (const tabId of session.tabIds || []) {
      try {
        tabs.push(normalizeTab(await chromeApi.tabs.get(tabId)));
      } catch {}
    }
    return { session, tabs };
  }

  function uniqueTabIds(tabIds) {
    return Array.from(new Set(tabIds.filter(Number.isInteger)));
  }

  async function sessionCreateTab(params) {
    const session = await requireSession(params.sessionId);
    let windowId = undefined;
    if (typeof session.groupId === 'number' && chromeApi.tabGroups) {
      try {
        const group = await chromeApi.tabGroups.get(session.groupId);
        if (group) windowId = group.windowId;
      } catch (e) {
        console.warn('Failed to get session tab group:', e);
      }
    }
    const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
    if (url !== 'about:blank') await assertUrlAllowed(url, 'session.createTab');
    if (url !== 'about:blank') await maybeEnableTemporaryCspBypassForUrl(url, params);
    const tab = await chromeApi.tabs.create({
      url,
      active: params.active !== false,
      ...(windowId !== undefined ? { windowId } : {})
    });
    if (typeof tab.id !== 'number') throw new Error('Created tab has no id');
    try {
      if (typeof session.groupId !== 'number' || !chromeApi.tabs.group) {
        throw new Error('Session has no Agent-managed tab group');
      }
      await chromeApi.tabs.group({ tabIds: [tab.id], groupId: session.groupId });
    } catch (e) {
      await chromeApi.tabs.remove(tab.id).catch(() => {});
      throw new Error(`Failed to add created tab to session group: ${errorMessage(e)}`);
    }
    const sessions = await loadSessions();
    const storedSession = sessions[session.id];
    storedSession.tabIds = uniqueTabIds([...(storedSession.tabIds || []), tab.id]);
    storedSession.updatedAt = new Date().toISOString();
    await saveSessions(sessions);
    return { session: storedSession, tab: normalizeTab(await chromeApi.tabs.get(tab.id)) };
  }

  async function sessionAddTab(params) {
    const session = await requireSession(params.sessionId);
    const tabId = assertTabId(params.tabId);
    await assertTabAllowed(tabId, 'session.addTab');
    const tab = await chromeApi.tabs.get(tabId);
    if (typeof session.groupId === 'number' && chromeApi.tabGroups) {
      try {
        const group = await chromeApi.tabGroups.get(session.groupId);
        if (group && tab.windowId !== group.windowId) {
          throw new Error(`Tab ${tabId} is in a different window from session ${session.id}`);
        }
      } catch (e) {
        console.warn('Failed to check session tab group window:', e);
      }
    }
    if (typeof session.groupId === 'number' && chromeApi.tabs.group) {
      await chromeApi.tabs.group({ tabIds: [tabId], groupId: session.groupId }).catch(e => {
        console.warn('Failed to add tab to session group:', e);
      });
    }
    const sessions = await loadSessions();
    const storedSession = sessions[session.id];
    storedSession.tabIds = uniqueTabIds([...(storedSession.tabIds || []), tabId]);
    storedSession.updatedAt = new Date().toISOString();
    await saveSessions(sessions);
    return { session: storedSession, tab: normalizeTab(await chromeApi.tabs.get(tabId)) };
  }

  async function sessionCloseTab(params) {
    const session = await requireSession(params.sessionId);
    const tabId = assertTabId(params.tabId);
    if (!Array.isArray(session.tabIds) || !session.tabIds.includes(tabId)) {
      throw new Error(`Tab ${tabId} is not part of session ${session.id}`);
    }
    const sessions = await loadSessions();
    const storedSession = sessions[session.id];
    storedSession.tabIds = (storedSession.tabIds || []).filter(id => id !== tabId);
    storedSession.updatedAt = new Date().toISOString();
    if (storedSession.mainTabId === tabId) {
      storedSession.mainTabId = storedSession.tabIds[0] || null;
    }
    await saveSessions(sessions);
    await chromeApi.tabs.remove(tabId);
    return { session: storedSession, closed: tabId };
  }

  async function sessionStop(params) {
    const session = await requireSession(params.sessionId);
    if (params.closeTabs === true && Array.isArray(session.tabIds) && session.tabIds.length > 0) {
      // Closing the tabs auto-detaches their debuggers.
      await chromeApi.tabs.remove(session.tabIds).catch(() => {});
    } else if (Array.isArray(session.tabIds)) {
      // Tabs stay open, so detach the debugger to drop the "DevTools is
      // debugging this browser" banner now that the agent is done with them.
      await Promise.all(session.tabIds.map(tabId => detachDebugger(tabId).catch(() => {})));
      if (chromeApi.tabs.ungroup) await chromeApi.tabs.ungroup(session.tabIds).catch(() => {});
    }
    const sessions = await loadSessions();
    delete sessions[session.id];
    await saveSessions(sessions);
    return { stopped: session.id };
  }

  async function loadSessions() {
    const result = await chromeApi.storage.local.get(SESSION_STORAGE_KEY);
    return result[SESSION_STORAGE_KEY] && typeof result[SESSION_STORAGE_KEY] === 'object' ? result[SESSION_STORAGE_KEY] : {};
  }

  async function saveSessions(sessions) {
    await chromeApi.storage.local.set({ [SESSION_STORAGE_KEY]: sessions });
  }

  async function requireSession(sessionId) {
    assertString(sessionId, 'sessionId');
    const sessions = await loadSessions();
    const session = sessions[sessionId];
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  function sessionGroupIds(sessions) {
    return new Set(
      Object.values(sessions)
        .map(session => session && session.groupId)
        .filter(groupId => typeof groupId === 'number')
    );
  }

  async function loadAgentTabGroups() {
    const result = await chromeApi.storage.local.get(AGENT_TAB_GROUPS_STORAGE_KEY);
    const groupIds = result[AGENT_TAB_GROUPS_STORAGE_KEY];
    return new Set(Array.isArray(groupIds) ? groupIds.filter(groupId => typeof groupId === 'number') : []);
  }

  async function rememberAgentTabGroup(groupId) {
    if (typeof groupId !== 'number' || groupId < 0) return;
    const groupIds = await loadAgentTabGroups();
    groupIds.add(groupId);
    await chromeApi.storage.local.set({ [AGENT_TAB_GROUPS_STORAGE_KEY]: Array.from(groupIds) });
  }

  async function isAgentManagedGroupId(groupId, sessions = null) {
    if (typeof groupId !== 'number' || groupId < 0) return false;
    const knownGroupIds = sessionGroupIds(sessions || await loadSessions());
    if (knownGroupIds.has(groupId)) return true;
    return (await loadAgentTabGroups()).has(groupId);
  }

  async function areAgentManagedTabs(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return false;
    const sessions = await loadSessions();
    for (const tabId of tabIds) {
      if (typeof tabId !== 'number') return false;
      const tab = await chromeApi.tabs.get(tabId).catch(() => null);
      const isManaged = tab ? await isAgentManagedGroupId(tab.groupId, sessions) : false;
      if (!isManaged) return false;
    }
    return true;
  }

  async function assertSessionManaged(sessionId, action) {
    const session = await requireSession(sessionId);
    if (await isSessionManaged(session)) return;
    throw new Error(`Access denied: ${action} session is not scoped to an Agent-managed tab group`);
  }

  async function isSessionManaged(session) {
    if (!session || typeof session !== 'object') return false;
    if (typeof session.groupId === 'number') return isAgentManagedGroupId(session.groupId);
    return Array.isArray(session.tabIds) && session.tabIds.length > 0 && await areAgentManagedTabs(session.tabIds);
  }


  async function onTabRemoved(tabId) {
    const sessions = await loadSessions();
    let changed = false;
    for (const session of Object.values(sessions)) {
      if (!Array.isArray(session.tabIds) || !session.tabIds.includes(tabId)) continue;
      session.tabIds = session.tabIds.filter(id => id !== tabId);
      if (session.mainTabId === tabId) session.mainTabId = session.tabIds[0] || null;
      session.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await saveSessions(sessions);
  }

  return {
    tabsList,
    tabsCreate,
    tabsActivate,
    tabsClose,
    tabsGroup,
    sessionStart,
    sessionList,
    sessionGet,
    sessionCreateTab,
    sessionAddTab,
    sessionCloseTab,
    sessionStop,
    loadSessions,
    saveSessions,
    requireSession,
    isAgentManagedGroupId,
    areAgentManagedTabs,
    assertSessionManaged,
    isSessionManaged,
    onTabRemoved
  };
}
