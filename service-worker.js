const DEBUG = false;
const HOME_URLS_KEY = "homeUrls";
const MRU_KEY = "mruByWindow";
const SUPPRESSED_PINS_KEY = "suppressedPins";
const PERSISTENT_HOMES_KEY = "persistentHomesBySite";
const SET_HOME_MENU_ID = "set-pinned-tab-home";
const MAX_MRU_TABS = 100;
const AUTOMATION_MARKER_MS = 5000;

// Serialize state changes so rapid tab events cannot overwrite one another.
let stateQueue = Promise.resolve();
const automaticActivations = new Map();
const automaticCloseWindows = new Map();

function debug(...args) {
  if (DEBUG) console.log("[Arc-Style Pinned Tabs]", ...args);
}

function reportFailure(context, error) {
  debug(context, error instanceof Error ? error.message : error);
}

function ensureContextMenu() {
  const properties = {
    title: "Set current URL as pin home",
    contexts: ["tab"],
  };

  chrome.contextMenus.update(SET_HOME_MENU_ID, properties, () => {
    if (!chrome.runtime.lastError) return;

    chrome.contextMenus.create(
      { id: SET_HOME_MENU_ID, ...properties },
      () => {
        if (chrome.runtime.lastError) {
          reportFailure("could not create tab context menu", chrome.runtime.lastError);
        }
      },
    );
  });
}

ensureContextMenu();

function changeState(mutator) {
  const operation = stateQueue.then(async () => {
    const state = await chrome.storage.session.get({
      [HOME_URLS_KEY]: {},
      [MRU_KEY]: {},
      [SUPPRESSED_PINS_KEY]: {},
    });

    await mutator(state);

    await chrome.storage.session.set({
      [HOME_URLS_KEY]: state[HOME_URLS_KEY],
      [MRU_KEY]: state[MRU_KEY],
      [SUPPRESSED_PINS_KEY]: state[SUPPRESSED_PINS_KEY],
    });
  });

  stateQueue = operation.catch(() => {});
  return operation;
}

async function readState() {
  await stateQueue;
  return chrome.storage.session.get({
    [HOME_URLS_KEY]: {},
    [MRU_KEY]: {},
    [SUPPRESSED_PINS_KEY]: {},
  });
}

function siteKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function changePersistentHomes(mutator) {
  const operation = stateQueue.then(async () => {
    const data = await chrome.storage.local.get({ [PERSISTENT_HOMES_KEY]: {} });
    await mutator(data[PERSISTENT_HOMES_KEY]);
    await chrome.storage.local.set({
      [PERSISTENT_HOMES_KEY]: data[PERSISTENT_HOMES_KEY],
    });
  });

  stateQueue = operation.catch(() => {});
  return operation;
}

async function rememberPersistentHome(url, homeUrl) {
  const key = siteKey(url);
  if (!key) return;

  await changePersistentHomes((homes) => {
    homes[key] = homeUrl;
  });
  debug("persistent home URL saved", key, homeUrl);
}

function activationKey(windowId, tabId) {
  return `${windowId}:${tabId}`;
}

function consumeAutomaticActivation(windowId, tabId) {
  const now = Date.now();
  const key = activationKey(windowId, tabId);
  const tabMarker = automaticActivations.get(key) ?? 0;
  const closeMarker = automaticCloseWindows.get(String(windowId)) ?? 0;

  automaticActivations.delete(key);
  automaticCloseWindows.delete(String(windowId));
  return tabMarker >= now || closeMarker >= now;
}

async function activateAutomatically(windowId, tabId) {
  const key = activationKey(windowId, tabId);
  automaticActivations.set(key, Date.now() + AUTOMATION_MARKER_MS);

  try {
    return await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    automaticActivations.delete(key);
    throw error;
  }
}

async function initializeState() {
  const tabs = await chrome.tabs.query({});
  const persistentData = await chrome.storage.local.get({
    [PERSISTENT_HOMES_KEY]: {},
  });
  const persistentHomes = persistentData[PERSISTENT_HOMES_KEY];
  const newPersistentHomes = new Map();
  const validTabIds = new Set(tabs.map((tab) => String(tab.id)));
  const pinnedTabs = new Map(
    tabs
      .filter((tab) => tab.pinned && tab.id !== undefined && tab.url)
      .map((tab) => [String(tab.id), tab.url]),
  );

  await changeState((state) => {
    const homeUrls = state[HOME_URLS_KEY];
    const mruByWindow = state[MRU_KEY];
    const suppressedPins = state[SUPPRESSED_PINS_KEY];

    for (const tabId of Object.keys(homeUrls)) {
      if (!pinnedTabs.has(tabId)) delete homeUrls[tabId];
    }

    for (const [tabId, url] of pinnedTabs) {
      if (!homeUrls[tabId]) {
        const key = siteKey(url);
        const persistentHome = key ? persistentHomes[key] : undefined;
        homeUrls[tabId] = persistentHome ?? url;
        debug("existing pin initialized", Number(tabId), homeUrls[tabId]);

        if (key && !persistentHome) newPersistentHomes.set(key, url);
      }
    }

    for (const tabId of Object.keys(suppressedPins)) {
      if (!pinnedTabs.has(tabId)) delete suppressedPins[tabId];
    }

    for (const windowId of Object.keys(mruByWindow)) {
      mruByWindow[windowId] = mruByWindow[windowId].filter((tabId) =>
        validTabIds.has(String(tabId)),
      );
    }

    for (const tab of tabs) {
      if (!tab.active || tab.id === undefined || tab.windowId === undefined) continue;

      const windowId = String(tab.windowId);
      const history = mruByWindow[windowId] ?? [];
      mruByWindow[windowId] = [
        tab.id,
        ...history.filter((tabId) => tabId !== tab.id),
      ].slice(0, MAX_MRU_TABS);
    }
  });

  if (newPersistentHomes.size > 0) {
    await changePersistentHomes((homes) => {
      for (const [key, url] of newPersistentHomes) homes[key] = url;
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeState().catch((error) => reportFailure("initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  initializeState().catch((error) => reportFailure("startup initialization failed", error));
});

// Also initialize when a suspended service worker wakes without either lifecycle event.
initializeState().catch((error) => reportFailure("worker initialization failed", error));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned === true) {
    if (!tab.url) return;

    changeState((state) => {
      state[HOME_URLS_KEY][String(tabId)] = tab.url;
      delete state[SUPPRESSED_PINS_KEY][String(tabId)];
      debug("tab pinned; home URL captured", tabId, tab.url);
    })
      .then(() => rememberPersistentHome(tab.url, tab.url))
      .catch((error) => reportFailure("could not save pinned tab", error));
  }

  if (changeInfo.pinned === false) {
    changeState((state) => {
      delete state[HOME_URLS_KEY][String(tabId)];
      delete state[SUPPRESSED_PINS_KEY][String(tabId)];
      debug("tab unpinned; home URL removed", tabId);
    }).catch((error) => reportFailure("could not remove pinned tab", error));
  }
});

chrome.contextMenus.onClicked.addListener((info, clickedTab) => {
  if (info.menuItemId !== SET_HOME_MENU_ID || clickedTab?.id === undefined) return;

  chrome.tabs
    .get(clickedTab.id)
    .then((tab) => {
      if (!tab.pinned || !tab.url) {
        debug("set-home ignored for an unpinned or inaccessible tab", tab.id);
        return;
      }

      return changeState((state) => {
        state[HOME_URLS_KEY][String(tab.id)] = tab.url;
        debug("home URL manually updated", tab.id, tab.url);
      }).then(() => rememberPersistentHome(tab.url, tab.url));
    })
    .catch((error) => reportFailure("could not manually update home URL", error));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const wasAutomatic = consumeAutomaticActivation(windowId, tabId);

  changeState((state) => {
    const key = String(windowId);
    const history = state[MRU_KEY][key] ?? [];
    state[MRU_KEY][key] = [
      tabId,
      ...history.filter((entry) => entry !== tabId),
    ].slice(0, MAX_MRU_TABS);

    if (!wasAutomatic && state[SUPPRESSED_PINS_KEY][String(tabId)]) {
      delete state[SUPPRESSED_PINS_KEY][String(tabId)];
      debug("pin explicitly activated; automatic handoff restored", tabId);
    }

    debug("tab activated; MRU updated", windowId, state[MRU_KEY][key]);
  }).catch((error) => reportFailure("could not update MRU", error));
});

chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  changeState((state) => {
    delete state[HOME_URLS_KEY][String(tabId)];
    delete state[SUPPRESSED_PINS_KEY][String(tabId)];

    const key = String(windowId);
    if (state[MRU_KEY][key]) {
      state[MRU_KEY][key] = state[MRU_KEY][key].filter(
        (entry) => entry !== tabId,
      );
    }
  }).catch((error) => reportFailure("could not clean up closed tab", error));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  changeState((state) => {
    const oldKey = String(removedTabId);
    const newKey = String(addedTabId);

    if (state[HOME_URLS_KEY][oldKey]) {
      state[HOME_URLS_KEY][newKey] = state[HOME_URLS_KEY][oldKey];
      delete state[HOME_URLS_KEY][oldKey];
    }

    if (state[SUPPRESSED_PINS_KEY][oldKey]) {
      state[SUPPRESSED_PINS_KEY][newKey] = true;
      delete state[SUPPRESSED_PINS_KEY][oldKey];
    }

    for (const history of Object.values(state[MRU_KEY])) {
      const index = history.indexOf(removedTabId);
      if (index !== -1) history[index] = addedTabId;
    }
  }).catch((error) => reportFailure("could not transfer replaced tab", error));
});

chrome.windows.onRemoved.addListener((windowId) => {
  changeState((state) => {
    delete state[MRU_KEY][String(windowId)];
  }).catch((error) => reportFailure("could not clean up closed window", error));
});

function candidateIds(activeTab, allTabs, history, excludedIds = new Set()) {
  const validIds = new Set(
    allTabs
      .filter(
        (tab) =>
          tab.id !== undefined &&
          tab.id !== activeTab.id &&
          !excludedIds.has(tab.id),
      )
      .map((tab) => tab.id),
  );
  const result = [];

  for (const tabId of history) {
    if (validIds.has(tabId) && !result.includes(tabId)) result.push(tabId);
  }

  // If MRU has no usable entry, prefer a nearby tab in strip order.
  const currentIndex = allTabs.findIndex((tab) => tab.id === activeTab.id);
  const nearbyTabs = [
    ...allTabs.slice(currentIndex + 1),
    ...allTabs.slice(0, Math.max(0, currentIndex)).reverse(),
  ];

  for (const tab of nearbyTabs) {
    if (tab.id !== undefined && validIds.has(tab.id) && !result.includes(tab.id)) {
      result.push(tab.id);
    }
  }

  return result;
}

async function activateAnotherTab(
  activeTab,
  history,
  excludedIds = new Set(),
  knownTabs = null,
) {
  const allTabs =
    knownTabs ?? (await chrome.tabs.query({ windowId: activeTab.windowId }));
  const candidates = candidateIds(activeTab, allTabs, history, excludedIds);

  for (let index = 0; index < candidates.length; index += 1) {
    const tabId = candidates[index];
    try {
      await activateAutomatically(activeTab.windowId, tabId);
      if (index > 0 || !history.includes(tabId)) {
        debug("fallback tab selected", tabId);
      }
      return tabId;
    } catch (error) {
      reportFailure(`candidate tab ${tabId} disappeared`, error);
    }
  }

  return null;
}

function waitForTabUrl(tabId, expectedUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let timeoutId;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeoutId);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (
        updatedTabId === tabId &&
        (changeInfo.url === expectedUrl || tab.url === expectedUrl)
      ) {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(finish, timeoutMs);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.url === expectedUrl) finish();
      })
      .catch(finish);
  });
}

async function resetPinnedTab(tab, homeUrl, canDiscard) {
  // tabs.update() resolves before a navigation necessarily commits. Wait for the
  // URL event so an immediate discard cannot resurrect the old deep URL.
  const urlChanged = waitForTabUrl(tab.id, homeUrl);
  await chrome.tabs.update(tab.id, { url: homeUrl });
  await urlChanged;
  debug("pinned tab reset", tab.id, homeUrl);

  if (!canDiscard) return;

  try {
    await chrome.tabs.discard(tab.id);
    debug("discard succeeded", tab.id);
  } catch (error) {
    reportFailure(`discard failed for tab ${tab.id}`, error);
  }
}

async function handleCommand() {
  debug("Command+W received");

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab?.id) return;

  const state = await readState();
  const tabKey = String(activeTab.id);
  const windowKey = String(activeTab.windowId);
  const suppressedPins = new Set(
    Object.keys(state[SUPPRESSED_PINS_KEY]).map(Number),
  );

  if (!activeTab.pinned) {
    const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    const hasSuppressedPin = allTabs.some((tab) =>
      suppressedPins.has(tab.id),
    );
    let nextTabId = null;

    if (hasSuppressedPin) {
      nextTabId = await activateAnotherTab(
        activeTab,
        state[MRU_KEY][windowKey] ?? [],
        suppressedPins,
        allTabs,
      );
    }

    if (nextTabId === null) {
      automaticCloseWindows.set(
        windowKey,
        Date.now() + AUTOMATION_MARKER_MS,
      );
    }

    await chrome.tabs.remove(activeTab.id);
    debug("normal tab closed", activeTab.id);
    return;
  }

  const homeUrl = state[HOME_URLS_KEY][tabKey] ?? activeTab.url;

  if (!homeUrl) {
    debug("pinned tab has no accessible home URL", activeTab.id);
    return;
  }

  if (!state[HOME_URLS_KEY][tabKey]) {
    await changeState((latestState) => {
      latestState[HOME_URLS_KEY][tabKey] = homeUrl;
    });
  }

  await changeState((latestState) => {
    latestState[SUPPRESSED_PINS_KEY][tabKey] = true;
  });
  suppressedPins.add(activeTab.id);
  debug("pin suppressed from automatic handoff", activeTab.id);

  const previousTabId = await activateAnotherTab(
    activeTab,
    state[MRU_KEY][windowKey] ?? [],
    suppressedPins,
  );

  await resetPinnedTab(activeTab, homeUrl, previousTabId !== null);
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "close-or-reset-tab") return;

  handleCommand().catch((error) => reportFailure("command failed", error));
});
