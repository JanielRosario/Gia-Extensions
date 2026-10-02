const DEFAULT_SETTINGS = {
  webhookUrl: "",
  sendMode: "multipart",
  deliveryMode: "webApp",
  remoteConfigUrl: "",
  remoteAuthToken: "",
  remoteConfig: null,
  remoteConfigSyncedAt: ""
};

const ALARM_NAME = "sync-remote-config";
const QTE_APP_URL = "https://quote-to-email.giatools.com/dashboard";
const QTE_APP_ORIGIN = "https://quote-to-email.giatools.com";
const QTE_DASHBOARD_URL_PATTERN = "https://quote-to-email.giatools.com/dashboard*";
const QTE_PENDING_PDFS_KEY = "qtePendingPdfs";
const QTE_PENDING_PDF_ALARM_NAME = "qte-pending-pdf-timeout";
const QTE_PENDING_PDF_TIMEOUT_MS = 15 * 60 * 1000;
const QTE_MAX_PENDING_PDFS = 5;
const BADGE_RESET_MS = 4500;
const MAX_PDF_CANDIDATES = 25;
const DOWNLOAD_CAPTURE_TTL_MS = 90000;
const DOWNLOAD_CAPTURE_KEY = "downloadCaptureSession";
const NETWORK_CAPTURE_TTL_MS = 120000;
const AUTO_CAPTURE_TTL_MS = 24 * 60 * 60 * 1000;
const REPLAY_REQUEST_TTL_MS = 120000;
const FORM_SUBMIT_CAPTURE_TTL_MS = 120000;
const MAX_REPLAY_BODY_BYTES = 5 * 1024 * 1024;
const policyCenterReplayRequests = new Map();
const policyCenterFormSubmits = new Map();
let qtePendingPdfsQueue = Promise.resolve();
const NETWORK_CAPTURE_STATE_KEY = "networkPdfCaptureState";
const NETWORK_CAPTURE_LOG_KEY = "networkPdfCaptureLog";
const LATEST_PDF_METADATA_KEY = "latestPdfMetadata";
const LATEST_PDF_METADATA_BY_TAB_KEY = "latestPdfMetadataByTab";
const PDF_CACHE_DB_NAME = "pdfWebhookCache";
const PDF_CACHE_DB_VERSION = 1;
const PDF_CACHE_STORE_NAME = "pdfs";
const LATEST_PDF_CACHE_ID = "latest";
const TAB_PDF_CACHE_ID_PREFIX = "tab:";
const GWPC_TRIGGER_SCRIPT_PATH = "src/gwpc-download-trigger.js";
const MAX_DIAGNOSTIC_LOG_ENTRIES = 120;
const POLICYCENTER_HOSTS = new Set([
  "policycenter.farmersinsurance.com",
  "policycenter-2.farmersinsurance.com",
  "policycenter-3.farmersinsurance.com"
]);
const POLICYCENTER_URL_FILTERS = [
  "https://policycenter.farmersinsurance.com/*",
  "https://policycenter-2.farmersinsurance.com/*",
  "https://policycenter-3.farmersinsurance.com/*"
];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    handlePolicyCenterBeforeRequest(details).catch(() => {});
  },
  {
    urls: POLICYCENTER_URL_FILTERS
  },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    handlePolicyCenterBeforeSendHeaders(details).catch(() => {});
  },
  {
    urls: POLICYCENTER_URL_FILTERS
  },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 30 });
  installGwpcTriggerInAllPolicyCenterTabs("extension installed").catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 30 });
  installGwpcTriggerInAllPolicyCenterTabs("browser startup").catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncRemoteConfig().catch(() => {});
  }

  if (alarm.name === QTE_PENDING_PDF_ALARM_NAME) {
    expireQtePendingPdf().catch(() => {});
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    handlePolicyCenterHeadersReceived(details).catch(() => {});
  },
  {
    urls: POLICYCENTER_URL_FILTERS
  },
  ["responseHeaders", "extraHeaders"]
);

chrome.downloads.onCreated.addListener((downloadItem) => {
  handleDownloadCreated(downloadItem).catch(() => {});
});

chrome.windows.onCreated.addListener((window) => {
  handleWindowCreated(window).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (Number.isInteger(tab.id) && isPolicyCenterUrl(tab.pendingUrl || tab.url || "")) {
    ensureGwpcDownloadTriggerInstalled(tab.id, "PolicyCenter tab created").catch(() => {});
  }
  handleTabCreated(tab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isPolicyCenterUrl(changeInfo.url || tab?.url || tab?.pendingUrl || "")) {
    ensureGwpcDownloadTriggerInstalled(tabId, "PolicyCenter tab updated").catch(() => {});
  }
  handleWatchedTabUpdated(tabId, changeInfo, tab).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleWatchedTabRemoved(tabId).catch(() => {});
  clearLatestPdfForTabIds([tabId]).catch(() => {});
  handleQteTabRemoved(tabId).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((error) => {
    showActionError(tab?.id, error).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "Unexpected extension error."
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
    case "SEND_CURRENT_PAGE_PDF":
      return sendCurrentPagePdf();
    case "SEND_CURRENT_PDF":
      return sendBrowserPdf();
    case "SEND_BROWSER_PDF":
      return sendBrowserPdf();
    case "SEND_LATEST_PDF":
      return sendLatestPdf(message);
    case "CLEAR_LATEST_PDF":
      return clearLatestPdf(message);
    case "START_DOWNLOAD_CAPTURE":
      return startDownloadCapture();
    case "START_NETWORK_PDF_CAPTURE":
      return startNetworkPdfCapture();
    case "STOP_NETWORK_PDF_CAPTURE":
      return stopActiveNetworkPdfCapture({ reason: "stopped manually" });
    case "GET_DIAGNOSTICS":
      return getDiagnostics();
    case "GWPC_DOWNLOAD_BUTTON_PREPARE":
      return handleGwpcDownloadButtonPrepare(message, sender);
    case "GWPC_DOWNLOAD_BUTTON_CLICKED":
      return handleGwpcDownloadButtonClicked(message, sender);
    case "GWPC_FORM_SUBMIT_CAPTURED":
      return handleGwpcFormSubmitCaptured(message, sender);
    case "AEGIS_QUOTE_IFRAME_DETECTED":
      return handleAegisQuoteIframeDetected(message, sender);
    case "QTE_READY":
      return handleQteReady(message, sender);
    case "QTE_PENDING_PDF_DELIVERED":
      return handleQtePendingPdfDelivered(message, sender);
    case "QTE_PENDING_PDF_FAILED":
      return handleQtePendingPdfFailed(message, sender);
    case "CAPTURED_PDF_FROM_PAGE":
      return sendCapturedPdfFromPage(message.file || {}, sender);
    case "PDF_CANDIDATE_FROM_PAGE":
      return sendPdfCandidateFromPage(message.candidate || {}, sender);
    case "SEND_UPLOADED_PDF":
      return sendUploadedPdf(message.file || {});
    case "GET_SETTINGS":
      return { ok: true, settings: await getStoredSettings() };
    case "SAVE_SETTINGS":
      return saveSettings(message.settings || {});
    case "SYNC_REMOTE_CONFIG":
      return syncRemoteConfig();
    default:
      throw new Error("Unknown request.");
  }
}

async function handleActionClick(tab) {
  await setActionBadge(tab?.id, "...", "#475467", "Sending PDF...");
  await showPdfCaptureLoadingIndicator(tab).catch(() => {});

  try {
    const tabUrl = tab?.url || "";
    let result = null;

    if (isAltaPresentationUrl(tabUrl)) {
      const latestPdf = await cacheAltaQuoteFromOpenTab(tab);

      if (!latestPdf) {
        throw new Error("Could not capture the current Alta quote PDF.");
      }

      result = await sendLatestPdf({ tabId: tab.id });
    } else if (isAegisUrl(tabUrl)) {
      const latestPdf = await cacheAegisQuoteFromOpenTab(tab);

      if (!latestPdf) {
        throw new Error("Could not capture the current Aegis quote PDF.");
      }

      result = await sendLatestPdf({ tabId: tab.id });
    } else if (isBambooUrl(tabUrl)) {
      const latestPdf = await cacheBambooQuoteFromOpenTab(tab);

      if (!latestPdf) {
        throw new Error("Could not capture the current Bamboo quote PDF.");
      }

      result = await sendLatestPdf({ tabId: tab.id });
    }

    if (!result) {
      const latestPdf = Number.isInteger(tab?.id)
        ? await getLatestPdfMetadata(tab.id)
        : null;

      result = latestPdf
        ? await sendLatestPdf({ tabId: tab.id })
        : await sendBrowserPdf(tab);
    }

    if (!result.webAppOpened) {
      await setActionBadge(tab?.id, "OK", "#0f766e", result.message || "PDF sent.");
    }
  } catch (error) {
    if ((error?.message || "").includes("Add a webhook URL")) {
      await setActionBadge(tab?.id, "SET", "#b54708", "Add a webhook URL in settings.");
      await chrome.runtime.openOptionsPage();
      return;
    }

    await showActionError(tab?.id, error);
  } finally {
    await hidePdfCaptureLoadingIndicator(tab).catch(() => {});
  }
}

async function getStoredSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  return {
    ...DEFAULT_SETTINGS,
    ...stored
  };
}

async function getEffectiveSettings() {
  const stored = await getStoredSettings();
  const remote = normalizeRemoteConfig(stored.remoteConfig);

  return {
    ...stored,
    enabled: remote.enabled ?? true,
    webhookUrl: remote.webhookUrl || stored.webhookUrl,
    sendMode: remote.sendMode || normalizeSendMode(stored.sendMode),
    deliveryMode: remote.deliveryMode || normalizeDeliveryMode(stored.deliveryMode)
  };
}

async function saveSettings(settings) {
  const current = await getStoredSettings();
  const normalized = {
    webhookUrl: normalizeUrl(settings.webhookUrl, "Webhook URL", true),
    sendMode: normalizeSendMode(settings.sendMode),
    deliveryMode: normalizeDeliveryMode(settings.deliveryMode),
    remoteConfigUrl: normalizeUrl(settings.remoteConfigUrl, "Remote config URL", true),
    remoteAuthToken: typeof settings.remoteAuthToken === "string" ? settings.remoteAuthToken : ""
  };

  if (!normalized.remoteConfigUrl || normalized.remoteConfigUrl !== current.remoteConfigUrl) {
    normalized.remoteConfig = null;
    normalized.remoteConfigSyncedAt = "";
  }

  await chrome.storage.sync.set(normalized);

  return {
    ok: true,
    settings: await getStoredSettings()
  };
}

async function getDiagnostics() {
  await expireNetworkCaptureIfNeeded();
  const storage = getDiagnosticStorage();
  const stored = await storage.get({
    [NETWORK_CAPTURE_STATE_KEY]: null,
    [NETWORK_CAPTURE_LOG_KEY]: []
  });

  return {
    ok: true,
    state: stored[NETWORK_CAPTURE_STATE_KEY],
    latestPdf: await getLatestPdfMetadata(),
    log: stored[NETWORK_CAPTURE_LOG_KEY] || []
  };
}

async function getLatestPdfMetadata(tabId = null) {
  const stored = await chrome.storage.local.get({
    [LATEST_PDF_METADATA_KEY]: null,
    [LATEST_PDF_METADATA_BY_TAB_KEY]: {}
  });

  if (Number.isInteger(tabId)) {
    return stored[LATEST_PDF_METADATA_BY_TAB_KEY]?.[String(tabId)] || null;
  }

  return stored[LATEST_PDF_METADATA_KEY];
}

async function waitForLatestPdfMetadata(tabId, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metadata = await getLatestPdfMetadata(tabId);

    if (metadata) {
      return metadata;
    }

    await delay(250);
  }

  return null;
}

async function getLatestPdfCache(options = {}) {
  const cacheId = options.cacheId || (Number.isInteger(options.tabId) ? getTabPdfCacheId(options.tabId) : LATEST_PDF_CACHE_ID);
  const storedMetadata = Number.isInteger(options.tabId)
    ? await getLatestPdfMetadata(options.tabId)
    : options.cacheId
      ? null
      : await getLatestPdfMetadata();

  if (!storedMetadata && !options.cacheId) {
    return null;
  }

  const db = await openPdfCacheDb();
  const record = await idbRequestToPromise(
    db.transaction(PDF_CACHE_STORE_NAME, "readonly")
      .objectStore(PDF_CACHE_STORE_NAME)
      .get(cacheId)
  );

  if (!record?.base64) {
    return null;
  }

  return {
    base64: record.base64,
    metadata: record.metadata || storedMetadata
  };
}

async function saveLatestPdfCache(pdf, options = {}) {
  if (!pdf?.base64 || !isPdfBase64(pdf.base64)) {
    throw new Error("PDF cache rejected a file that did not look like a valid PDF.");
  }

  const tabIds = normalizeTabIds(options.tabIds || options.tabId || pdf.metadata?.tabIds || pdf.metadata?.tabId);
  const primaryTabId = tabIds[0] ?? null;
  const primaryCacheId = Number.isInteger(primaryTabId) ? getTabPdfCacheId(primaryTabId) : LATEST_PDF_CACHE_ID;
  const metadata = {
    ...(pdf.metadata || {}),
    fileName: pdf.fileName,
    fileSize: base64ToByteLength(pdf.base64),
    contentType: "application/pdf",
    capturedAt: pdf.metadata?.capturedAt || new Date().toISOString(),
    cacheId: primaryCacheId,
    tabId: primaryTabId,
    tabIds
  };
  const db = await openPdfCacheDb();
  const tx = db.transaction(PDF_CACHE_STORE_NAME, "readwrite");
  const store = tx.objectStore(PDF_CACHE_STORE_NAME);
  const savedAt = new Date().toISOString();

  store.put({
    id: LATEST_PDF_CACHE_ID,
    base64: pdf.base64,
    metadata,
    savedAt
  });

  for (const tabId of tabIds) {
    const tabMetadata = {
      ...metadata,
      cacheId: getTabPdfCacheId(tabId),
      tabId
    };

    store.put({
      id: tabMetadata.cacheId,
      base64: pdf.base64,
      metadata: tabMetadata,
      savedAt
    });
  }

  await idbTransactionDone(tx);
  const stored = await chrome.storage.local.get({
    [LATEST_PDF_METADATA_BY_TAB_KEY]: {}
  });
  const metadataByTab = {
    ...(stored[LATEST_PDF_METADATA_BY_TAB_KEY] || {})
  };

  for (const tabId of tabIds) {
    metadataByTab[String(tabId)] = {
      ...metadata,
      cacheId: getTabPdfCacheId(tabId),
      tabId
    };
  }

  await chrome.storage.local.set({
    [LATEST_PDF_METADATA_KEY]: metadata,
    [LATEST_PDF_METADATA_BY_TAB_KEY]: metadataByTab
  });

  return metadata;
}

async function clearLatestPdf(message = {}) {
  const tab = await getActiveTab().catch(() => null);
  const explicitTabIds = normalizeTabIds(message.tabIds || message.tabId);
  const tabIds = explicitTabIds.length
    ? explicitTabIds
    : Number.isInteger(tab?.id)
      ? [tab.id]
      : [];

  if (!tabIds.length) {
    await clearGlobalLatestPdfCache();
  } else {
    await clearLatestPdfForTabIds(tabIds);
  }

  await logDiagnostic("latest PDF cleared", "Cached latest PDF was cleared by user.", {
    tabIds
  });

  return {
    ok: true,
    message: "Cached latest PDF cleared."
  };
}

async function clearGlobalLatestPdfCache() {
  const db = await openPdfCacheDb();
  const tx = db.transaction(PDF_CACHE_STORE_NAME, "readwrite");

  tx.objectStore(PDF_CACHE_STORE_NAME).delete(LATEST_PDF_CACHE_ID);
  await idbTransactionDone(tx);
  await chrome.storage.local.remove(LATEST_PDF_METADATA_KEY);
}

async function clearLatestPdfForTabIds(tabIds) {
  const normalizedTabIds = normalizeTabIds(tabIds);

  if (!normalizedTabIds.length) {
    return;
  }

  const db = await openPdfCacheDb();
  const tx = db.transaction(PDF_CACHE_STORE_NAME, "readwrite");
  const store = tx.objectStore(PDF_CACHE_STORE_NAME);

  for (const tabId of normalizedTabIds) {
    store.delete(getTabPdfCacheId(tabId));
  }

  await idbTransactionDone(tx);

  const stored = await chrome.storage.local.get({
    [LATEST_PDF_METADATA_KEY]: null,
    [LATEST_PDF_METADATA_BY_TAB_KEY]: {}
  });
  const metadataByTab = {
    ...(stored[LATEST_PDF_METADATA_BY_TAB_KEY] || {})
  };

  for (const tabId of normalizedTabIds) {
    delete metadataByTab[String(tabId)];
  }

  const latest = stored[LATEST_PDF_METADATA_KEY];
  const latestTabIds = normalizeTabIds(latest?.tabIds || latest?.tabId);
  const shouldClearGlobal = latestTabIds.some((tabId) => normalizedTabIds.includes(tabId));

  if (shouldClearGlobal) {
    await clearGlobalLatestPdfCache();
  }

  await chrome.storage.local.set({
    [LATEST_PDF_METADATA_BY_TAB_KEY]: metadataByTab
  });
}

async function resetDiagnosticLog() {
  await getDiagnosticStorage().set({
    [NETWORK_CAPTURE_LOG_KEY]: []
  });
}

async function logDiagnostic(step, message, data = null) {
  const storage = getDiagnosticStorage();
  const stored = await storage.get({
    [NETWORK_CAPTURE_LOG_KEY]: []
  });
  const log = stored[NETWORK_CAPTURE_LOG_KEY] || [];
  const entry = {
    time: new Date().toISOString(),
    step,
    message
  };

  if (data) {
    entry.data = data;
  }

  log.push(entry);

  await storage.set({
    [NETWORK_CAPTURE_LOG_KEY]: log.slice(-MAX_DIAGNOSTIC_LOG_ENTRIES)
  });
}

async function getNetworkCaptureState() {
  const stored = await getDiagnosticStorage().get({
    [NETWORK_CAPTURE_STATE_KEY]: null
  });

  return stored[NETWORK_CAPTURE_STATE_KEY];
}

async function setNetworkCaptureState(state) {
  await getDiagnosticStorage().set({
    [NETWORK_CAPTURE_STATE_KEY]: state
  });
}

async function updateNetworkCaptureState(partial) {
  const current = await getNetworkCaptureState();
  const next = {
    ...(current || {}),
    ...partial,
    lastEventAt: new Date().toISOString()
  };

  await setNetworkCaptureState(next);
  return next;
}

function getDiagnosticStorage() {
  return chrome.storage.local;
}

async function installGwpcTriggerInAllPolicyCenterTabs(reason) {
  const tabs = await chrome.tabs.query({
    url: POLICYCENTER_URL_FILTERS
  });

  await Promise.all(tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => ensureGwpcDownloadTriggerInstalled(tab.id, reason, { silent: true })));

  if (tabs.length) {
    await logDiagnostic("GWPC trigger installed", "GWPC Download trigger refreshed in existing PolicyCenter tabs.", {
      reason,
      tabCount: tabs.length
    });
  }
}

async function ensureGwpcDownloadTriggerInstalled(tabId, reason, options = {}) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  try {
    try {
      await chrome.scripting.executeScript({
        target: {
          tabId,
          allFrames: true
        },
        files: [GWPC_TRIGGER_SCRIPT_PATH]
      });
    } catch {
      await chrome.scripting.executeScript({
        target: {
          tabId
        },
        files: [GWPC_TRIGGER_SCRIPT_PATH]
      });
    }

    if (!options.silent) {
      await logDiagnostic("GWPC trigger installed", "GWPC Download trigger installed/refreshed in PolicyCenter tab.", {
        reason,
        tabId
      });
    }

    return true;
  } catch (error) {
    if (!options.silent) {
      await logDiagnostic("exact error message if failed", error.message || "Could not install GWPC Download trigger.", {
        reason,
        tabId
      });
    }

    return false;
  }
}

async function getPopupState() {
  await syncRemoteConfig({ silent: true });

  const tab = await getActiveTab();
  const settings = await getEffectiveSettings();
  const tabSupport = getPrintableTabSupport(tab);

  if (isPolicyCenterUrl(tab.url)) {
    await ensureGwpcDownloadTriggerInstalled(tab.id, "state requested on PolicyCenter tab");
  } else {
    await maybeCacheCurrentVisiblePdf(tab);
  }

  const diagnostics = await getDiagnostics();
  const latestPdf = await getLatestPdfMetadata(tab.id);
  const hasWebhook = Boolean(settings.webhookUrl);
  const canSendBrowserPdf = isDeliveryConfigured(settings) && settings.enabled !== false;
  const canUpload = canSendBrowserPdf;
  const canPrint = false;

  return {
    ok: true,
    tab: serializeTab(tab),
    isPdf: true,
    pdfUrl: tab.url || "",
    hasWebhook,
    canSend: canSendBrowserPdf,
    canSendBrowserPdf,
    canUpload,
    canPrint,
    canSendLatestPdf: canSendBrowserPdf && Boolean(latestPdf),
    canSendCurrentPdf: canSendBrowserPdf,
    latestPdf,
    disabledReason: getDisabledReason({
      tabSupport,
      hasWebhook,
      settings
    }),
    uploadDisabledReason: getUploadDisabledReason({
      hasWebhook,
      settings
    }),
    browserPdfDisabledReason: getUploadDisabledReason({
      hasWebhook,
      settings
    }),
    printDisabledReason: "Print Current Page is disabled in this build.",
    settings: {
      sendMode: settings.sendMode,
      deliveryMode: settings.deliveryMode,
      enabled: settings.enabled
    },
    networkCapture: diagnostics.state,
    diagnostics
  };
}

async function sendCurrentPagePdf(tabOverride = null) {
  throw new Error("Print Current Page is disabled in this build.");
}

async function sendBrowserPdf(tabOverride = null) {
  await syncRemoteConfig({ silent: true });

  const tab = tabOverride?.id ? tabOverride : await getActiveTab();
  const settings = await getEffectiveSettings();

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  const browserPdf = await findBrowserPdf(tab);
  const metadata = await saveLatestPdfCache({
    ...browserPdf,
    metadata: {
      ...browserPdf.metadata,
      sourceMode: "Universal Manual",
      capturedAt: new Date().toISOString()
    }
  }, {
    tabId: tab.id
  });

  await logDiagnostic("latest PDF cached", "Current tab PDF cached before manual send.", {
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    sourceUrl: metadata.sourceUrl || "",
    sourceMode: metadata.sourceMode
  });

  const delivery = await deliverPdf(settings, {
    ...browserPdf,
    metadata
  }, tab.id);
  await logDiagnostic("webhook sent yes/no", "Current PDF manual delivery succeeded.", {
    webhookSent: delivery.webhookSent,
    webAppOpened: delivery.webAppOpened,
    sendMode: settings.sendMode,
    deliveryMode: settings.deliveryMode,
    fileName: browserPdf.fileName,
    byteLength: browserPdf.metadata?.fileSize || base64ToByteLength(browserPdf.base64)
  });

  return {
    ok: true,
    message: delivery.message,
    webAppOpened: delivery.webAppOpened,
    latestPdf: metadata
  };
}

async function sendLatestPdf(message = {}) {
  await syncRemoteConfig({ silent: true });

  const tab = await getActiveTab().catch(() => null);
  const settings = await getEffectiveSettings();

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  const sourceTabId = Number.isInteger(message.tabId) ? message.tabId : tab?.id;
  const cached = await getLatestPdfCache({
    cacheId: message.cacheId || "",
    tabId: sourceTabId
  });

  if (!cached?.base64 || !cached?.metadata) {
    await logDiagnostic("exact error message if failed", "Send requested, but no cached PDF body was found.");
    throw new Error("No latest PDF is cached yet.");
  }

  const pdf = {
    base64: cached.base64,
    fileName: cached.metadata.fileName || "document.pdf",
    metadata: {
      ...cached.metadata,
      sentAt: new Date().toISOString()
    }
  };

  if (!isPdfBase64(pdf.base64)) {
    await logDiagnostic("exact error message if failed", "Cached latest PDF did not look like a valid PDF.");
    throw new Error("Cached latest PDF is not valid. Clear it and load the PDF again.");
  }

  const delivery = await deliverPdf(settings, pdf, sourceTabId);
  await logDiagnostic("webhook sent yes/no", "Latest cached PDF manual delivery succeeded.", {
    webhookSent: delivery.webhookSent,
    webAppOpened: delivery.webAppOpened,
    sendMode: settings.sendMode,
    deliveryMode: settings.deliveryMode,
    fileName: pdf.fileName,
    byteLength: pdf.metadata.fileSize || base64ToByteLength(pdf.base64),
    sourceMode: pdf.metadata.sourceMode || ""
  });

  return {
    ok: true,
    message: delivery.message,
    webAppOpened: delivery.webAppOpened,
    latestPdf: cached.metadata
  };
}

async function maybeCacheCurrentVisiblePdf(tab) {
  const url = tab?.url || "";

  if (!tab?.id || isProtectedBrowserUrl(url)) {
    return;
  }

  if (!urlLooksLikePdfFile(url) && !url.startsWith("data:application/pdf")) {
    return;
  }

  try {
    const pdf = await findBrowserPdf(tab);
    const metadata = await saveLatestPdfCache({
      ...pdf,
      metadata: {
        ...pdf.metadata,
        sourceMode: "Universal Manual",
        capturedAt: new Date().toISOString()
      }
    }, {
      tabId: tab.id
    });

    await logDiagnostic("latest PDF cached", "Current visible PDF cached for manual send.", {
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      sourceUrl: metadata.sourceUrl || "",
      sourceMode: metadata.sourceMode
    });
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not cache current visible PDF.", {
      url: redactLongUrl(url)
    });
  }
}

async function handleAegisQuoteIframeDetected(message, sender) {
  const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;

  try {
    const metadata = await cacheAegisQuotePdfFromUrl({
      quoteUrl: message.quoteUrl || "",
      frameUrl: message.frameUrl || "",
      pageTitle: message.pageTitle || sender?.tab?.title || "Quote",
      tabId,
      triggerSource: message.triggerSource || "content-script"
    });

    return {
      ok: true,
      latestPdf: metadata
    };
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not cache Aegis quote PDF.", {
      source: "aegis-quote-iframe",
      url: redactLongUrl(message.quoteUrl || ""),
      tabId
    });
    await showActionError(tabId, error);

    return {
      ok: false,
      error: error.message || "Could not cache Aegis quote PDF."
    };
  }
}

async function cacheAegisQuoteFromOpenTab(tab) {
  if (!Number.isInteger(tab?.id)) {
    return null;
  }

  let candidates = await collectAegisQuoteIframeCandidates(tab.id);

  if (!candidates.length) {
    const clickResult = await clickAegisPrintQuoteButton(tab.id);

    if (clickResult?.ok) {
      candidates = await waitForAegisQuoteIframeCandidates(tab.id);
    }
  }

  if (!candidates.length) {
    await logDiagnostic("Aegis quote iframe detected", "Toolbar click scanned Aegis tab, but no quote PDF iframe was found.", {
      found: false,
      tabId: tab.id,
      url: redactLongUrl(tab.url || "")
    });
    return null;
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await cacheAegisQuotePdfFromUrl({
        quoteUrl: candidate.url,
        frameUrl: candidate.frameUrl || tab.url || "",
        pageTitle: candidate.title || tab.title || "Quote",
        tabId: tab.id,
        triggerSource: candidate.source || "toolbar-click-scan"
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

async function cacheAltaQuoteFromOpenTab(tab) {
  if (!Number.isInteger(tab?.id)) {
    return null;
  }

  await clearLatestPdfForTabIds([tab.id]);

  let capture = null;
  let printCapture = null;
  const timings = {
    startedAt: Date.now()
  };
  const rendererStartedAt = Date.now();
  const rendererReadyPromise = ensureAltaRendererLibraries(tab.id).then(() => {
    timings.rendererReadyMs = Date.now() - rendererStartedAt;
  });

  try {
    const printStartedAt = Date.now();
    const printResults = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      world: "MAIN",
      func: captureAltaPrintHtmlInPage,
      args: [8000]
    });

    printCapture = printResults?.[0]?.result || null;
    timings.printCaptureMs = Date.now() - printStartedAt;
  } catch (error) {
    await logDiagnostic("Alta print HTML capture", error.message || "Could not capture Alta print HTML.", {
      source: "alta-print-html",
      tabId: tab.id
    });
  }

  try {
    await rendererReadyPromise;

    const renderStartedAt = Date.now();
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      func: captureAltaQuotePdfInPage,
      args: [printCapture?.ok ? printCapture : null]
    });

    capture = results?.[0]?.result || null;
    timings.renderMs = Date.now() - renderStartedAt;
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not render Alta quote PDF.", {
      source: "alta-preview-render",
      tabId: tab.id
    });
  }

  if (!capture?.ok || !capture.base64) {
    await logDiagnostic("Alta quote PDF capture", capture?.error || "Could not render Alta visible quote preview.", {
      captured: false,
      tabId: tab.id,
      url: redactLongUrl(tab.url || "")
    });
    return null;
  }

  const fileName = sanitizeUploadedPdfFileName(capture.fileName || "Alta-presentation.pdf");
  const metadata = await saveLatestPdfCache({
    base64: capture.base64,
    fileName,
    metadata: {
      fileName,
      fileSize: capture.byteLength || base64ToByteLength(capture.base64),
      contentType: "application/pdf",
      quoteNumber: capture.quoteNumber || "",
      source: capture.source || "alta-visible-preview",
      sourceMode: "Alta Quote PDF",
      sourceUrl: capture.sourceUrl || tab.url || "",
      discoveredBy: capture.discoveredBy || "alta-preview-render",
      foundAt: new Date().toISOString(),
      capturedAt: new Date().toISOString()
    }
  }, {
    tabId: tab.id
  });

  await logDiagnostic("response body captured yes/no", capture.message || "Alta quote PDF rendered.", {
    source: capture.discoveredBy || "alta-preview-render",
      bodyCaptured: true,
      byteLength: metadata.fileSize,
      fileName: metadata.fileName,
      pageCount: capture.pageCount || null,
      timings: {
        ...timings,
        totalMs: Date.now() - timings.startedAt
      }
    });

  return metadata;
}

async function ensureAltaRendererLibraries(tabId) {
  const ready = await chrome.scripting.executeScript({
    target: {
      tabId
    },
    func: () => Boolean(window.html2canvas && window.jspdf?.jsPDF)
  });

  if (ready?.[0]?.result) {
    return;
  }

  await chrome.scripting.executeScript({
    target: {
      tabId
    },
    files: [
      "vendor/html2canvas.min.js",
      "vendor/jspdf.umd.min.js"
    ]
  });
}

async function cacheBambooQuoteFromOpenTab(tab) {
  if (!Number.isInteger(tab?.id)) {
    return null;
  }

  let capture = null;

  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      world: "MAIN",
      func: captureBambooQuotePdfInPage,
      args: [20000]
    });

    capture = results?.[0]?.result || null;
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not run Bamboo quote PDF capture.", {
      source: "bamboo-toolbar-capture",
      tabId: tab.id
    });
  }

  if (!capture?.ok || !capture.base64) {
    await logDiagnostic("Bamboo quote PDF capture", capture?.error || "Toolbar click could not capture Bamboo quote PDF.", {
      captured: false,
      tabId: tab.id,
      url: redactLongUrl(tab.url || "")
    });
    return null;
  }

  const fileName = sanitizeUploadedPdfFileName(capture.fileName || "Bamboo-quote.pdf");
  const metadata = await saveLatestPdfCache({
    base64: capture.base64,
    fileName,
    metadata: {
      fileName,
      fileSize: capture.byteLength || base64ToByteLength(capture.base64),
      contentType: "application/pdf",
      source: "bamboo-quote-summary",
      sourceMode: "Bamboo Quote PDF",
      sourceUrl: capture.sourceUrl || tab.url || "",
      discoveredBy: "bamboo-toolbar-capture",
      foundAt: new Date().toISOString(),
      capturedAt: new Date().toISOString()
    }
  }, {
    tabId: tab.id
  });

  await logDiagnostic("response body captured yes/no", "Bamboo quote PDF response body captured before download.", {
    source: "bamboo-toolbar-capture",
    bodyCaptured: true,
    byteLength: metadata.fileSize,
    fileName: metadata.fileName
  });

  return metadata;
}

async function clickAegisPrintQuoteButton(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true
      },
      func: clickAegisPrintQuoteButtonInPage
    });

    return results.find((entry) => entry?.result?.ok)?.result || null;
  } catch {
    return null;
  }
}

async function waitForAegisQuoteIframeCandidates(tabId, timeoutMs = 8000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const candidates = await collectAegisQuoteIframeCandidates(tabId);

    if (candidates.length) {
      return candidates;
    }

    await delay(250);
  }

  return [];
}

async function collectAegisQuoteIframeCandidates(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true
      },
      func: collectAegisQuoteIframeUrlsInPage
    });
    const candidates = [];
    const seen = new Set();

    for (const result of results || []) {
      for (const candidate of result?.result?.candidates || []) {
        const url = normalizeAegisQuotePdfUrl(candidate.url || "");

        if (!url || seen.has(url)) {
          continue;
        }

        seen.add(url);
        candidates.push({
          ...candidate,
          url
        });
      }
    }

    return candidates;
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not scan Aegis tab for quote PDF iframe.", {
      source: "aegis-toolbar-scan",
      tabId
    });
    return [];
  }
}

async function cacheAegisQuotePdfFromUrl({ quoteUrl, frameUrl = "", pageTitle = "Quote", tabId = null, triggerSource = "" }) {
  const normalizedUrl = normalizeAegisQuotePdfUrl(quoteUrl || "");

  if (!normalizedUrl) {
    await logDiagnostic("Aegis quote PDF ignored", "Aegis quote iframe was detected, but the URL was not an allowed quote PDF endpoint.", {
      url: redactLongUrl(quoteUrl || ""),
      tabId
    });
    throw new Error("Not an allowed Aegis quote PDF URL.");
  }

  await logDiagnostic("Aegis quote iframe detected", "Aegis quote PDF iframe detected; attempting to cache original PDF.", {
    url: redactLongUrl(normalizedUrl),
    frameUrl: redactLongUrl(frameUrl),
    triggerSource,
    tabId
  });

  let pdf = null;
  let backgroundError = null;

  try {
    pdf = await readAegisQuotePdfFromExtensionFetch(normalizedUrl, {
      frameUrl,
      pageTitle,
      triggerSource
    });
  } catch (error) {
    backgroundError = error;
    await logDiagnostic("exact error message if failed", error.message || "Extension fetch could not cache Aegis quote PDF; trying page-context fetch.", {
      source: "aegis-extension-fetch",
      url: redactLongUrl(normalizedUrl),
      tabId
    });
  }

  if (!pdf && Number.isInteger(tabId)) {
    pdf = await readAegisQuotePdfFromPage(tabId, normalizedUrl, {
      frameUrl,
      pageTitle,
      triggerSource
    });
  }

  if (!pdf) {
    throw backgroundError || new Error("Could not read Aegis quote PDF.");
  }

  const metadata = await saveLatestPdfCache({
    ...pdf,
    metadata: {
      ...pdf.metadata,
      capturedAt: new Date().toISOString()
    }
  }, {
    tabId
  });

  await logDiagnostic("response body captured yes/no", "Aegis quote PDF response body captured from iframe URL.", {
    source: pdf.metadata?.discoveredBy || "aegis-quote-iframe",
    bodyCaptured: true,
    byteLength: metadata.fileSize,
    fileName: metadata.fileName
  });
  await logDiagnostic("latest PDF cached", "Latest Aegis quote PDF cached locally. No webhook send was performed.", {
    cached: true,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    sourceUrl: metadata.sourceUrl || "",
    sourceMode: metadata.sourceMode
  });
  await setActionBadge(tabId, "Email", "#0f766e", "Latest Aegis quote PDF cached. Click the extension icon to send.", { persist: true });

  return metadata;
}

async function readAegisQuotePdfFromExtensionFetch(url, context = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include"
  });
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";

  await logDiagnostic("content-type / headers checked", "Checked Aegis quote PDF response headers.", {
    source: "aegis-extension-fetch",
    statusCode: response.status,
    contentType,
    contentDisposition
  });

  if (!response.ok) {
    throw new Error(`Aegis quote PDF returned HTTP ${response.status}.`);
  }

  if (!isPdfHeaderValues(contentType, contentDisposition)) {
    throw new Error("Aegis quote iframe response was not clearly identified as a PDF.");
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (!isPdfBytes(bytes)) {
    throw new Error("Aegis quote iframe response did not contain valid PDF bytes.");
  }

  const fileName = getAegisQuotePdfFileName({
    url,
    contentDisposition,
    title: context.pageTitle || "Quote"
  });

  return {
    base64: arrayBufferToBase64(buffer),
    fileName,
    metadata: {
      fileName,
      fileSize: bytes.byteLength,
      contentType: "application/pdf",
      source: "aegis-quote-iframe",
      sourceMode: "Aegis Quote PDF",
      sourceUrl: url,
      discoveredBy: "aegis-extension-fetch",
      discoveredFrom: context.frameUrl || "",
      foundAt: new Date().toISOString()
    }
  };
}

async function readAegisQuotePdfFromPage(tabId, url, context = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true
      },
      func: readAegisQuotePdfInPage,
      args: [url]
    });
    const success = results.find((entry) => entry?.result?.ok && entry.result.base64)?.result;

    if (!success) {
      const error = results.find((entry) => entry?.result?.error)?.result?.error || "Aegis page-context fetch did not return a PDF.";
      throw new Error(error);
    }

    await logDiagnostic("content-type / headers checked", "Checked Aegis page-context PDF response headers.", {
      source: "aegis-page-fetch",
      statusCode: success.statusCode || 0,
      contentType: success.contentType || "",
      contentDisposition: success.contentDisposition || ""
    });

    const fileName = getAegisQuotePdfFileName({
      url,
      contentDisposition: success.contentDisposition || "",
      title: context.pageTitle || "Quote"
    });

    return {
      base64: success.base64,
      fileName,
      metadata: {
        fileName,
        fileSize: success.byteLength || base64ToByteLength(success.base64),
        contentType: "application/pdf",
        source: "aegis-quote-iframe",
        sourceMode: "Aegis Quote PDF",
        sourceUrl: success.finalUrl || url,
        discoveredBy: "aegis-page-fetch",
        discoveredFrom: context.frameUrl || "",
        foundAt: new Date().toISOString()
      }
    };
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Aegis page-context fetch failed.", {
      source: "aegis-page-fetch",
      url: redactLongUrl(url),
      tabId
    });
    return null;
  }
}

async function startDownloadCapture() {
  await syncRemoteConfig({ silent: true });

  const tab = await getActiveTab();
  const settings = await getEffectiveSettings();

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  if (isProtectedBrowserUrl(tab.url)) {
    throw new Error("Browser, extension, and settings pages cannot be watched for downloads.");
  }

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: true
      },
      func: installDownloadCapture,
      args: [DOWNLOAD_CAPTURE_TTL_MS]
    });
  } catch {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      func: installDownloadCapture,
      args: [DOWNLOAD_CAPTURE_TTL_MS]
    });
  }

  const session = {
    tabId: tab.id,
    expiresAt: Date.now() + DOWNLOAD_CAPTURE_TTL_MS,
    startedAt: new Date().toISOString()
  };

  await getSessionStorage().set({
    [DOWNLOAD_CAPTURE_KEY]: session
  });

  await setActionBadge(tab.id, "ARM", "#0f766e", "Capture armed. Click the site's PDF download button.");

  return {
    ok: true,
    message: "Capture armed. Click the site's PDF download button now."
  };
}

function getPolicyCenterSenderInfo(message, sender) {
  const tab = sender?.tab;
  const tabUrl = tab?.url || message.pageUrl || "";

  if (!tab?.id || !isPolicyCenterUrl(tabUrl)) {
    return {
      ok: false,
      tab,
      tabUrl
    };
  }

  return {
    ok: true,
    tab,
    tabUrl
  };
}

async function handleGwpcDownloadButtonPrepare(message, sender) {
  const info = getPolicyCenterSenderInfo(message, sender);

  if (!info.ok) {
    await logDiagnostic("exact error message if failed", "GWPC prepare trigger ignored because the sender was not a PolicyCenter tab.", {
      tabId: info.tab?.id || null,
      url: redactLongUrl(info.tabUrl)
    });

    return {
      ok: false,
      error: "GWPC PDF prepare is limited to PolicyCenter tabs."
    };
  }

  const { tab, tabUrl } = info;
  const state = await getNetworkCaptureState();

  if (!state?.active || !isWatchedNetworkTab(state, tab.id)) {
    await startNetworkPdfCapture({
      tabOverride: {
        id: tab.id,
        url: tabUrl,
        title: tab.title || message.pageTitle || ""
      },
      triggeredByDownloadButton: true,
      restartExisting: false
    });
  }

  await updateNetworkCaptureState({
    preparedForDownloadClick: true,
    triggerAttemptId: message.triggerAttemptId || "",
    triggerPhase: message.triggerPhase || "prepare",
    triggerButtonId: message.buttonId || "",
    triggerButtonText: message.buttonText || "",
    triggerButtonAction: message.buttonAction || "",
    triggerPreparedAt: new Date().toISOString(),
    status: "watching"
  });
  await logDiagnostic("GWPC trigger prepared", "GWPC Download button was seen; watcher prepared before click.", {
    tabId: tab.id,
    phase: message.triggerPhase || "",
    attemptId: message.triggerAttemptId || "",
    buttonId: message.buttonId || "",
    buttonText: message.buttonText || ""
  });
  await setActionBadge(tab.id, "PDF?", "#0f766e", "GWPC PDF trigger ready.", { persist: true });

  return {
    ok: true,
    watching: true,
    message: "GWPC PDF watcher prepared before Download click."
  };
}

async function handleGwpcFormSubmitCaptured(message, sender) {
  cleanupExpiredReplayRequests();

  const info = getPolicyCenterSenderInfo(message, sender);

  if (!info.ok) {
    return {
      ok: false,
      error: "GWPC form capture is limited to PolicyCenter tabs."
    };
  }

  const state = await getNetworkCaptureState();

  if (!state?.active || !isWatchedNetworkTab(state, info.tab.id)) {
    return {
      ok: true,
      ignored: true,
      message: "No active GWPC PDF watcher for this form submit."
    };
  }

  const captured = normalizeCapturedPolicyCenterForm(message.form || {}, info.tab, message);

  if (!captured) {
    return {
      ok: true,
      ignored: true,
      message: "Form submit was not replayable."
    };
  }

  policyCenterFormSubmits.set(captured.id, captured);
  policyCenterFormSubmits.set(`tab:${captured.tabId}`, captured);

  await logDiagnostic("form submit captured", "PolicyCenter form submit captured as fallback replay source.", {
    tabId: captured.tabId,
    url: redactLongUrl(captured.url),
    method: captured.method,
    enctype: captured.enctype,
    source: captured.source,
    fieldCount: captured.fieldCount,
    bodyByteLength: captured.bodyByteLength,
    hasFile: captured.hasFile,
    attemptId: captured.triggerAttemptId || "",
    fieldNames: (captured.fieldNames || []).slice(0, 25)
  });

  return {
    ok: true,
    captured: true
  };
}

async function handleGwpcDownloadButtonClicked(message, sender) {
  const info = getPolicyCenterSenderInfo(message, sender);

  if (!info.ok) {
    await logDiagnostic("exact error message if failed", "GWPC download trigger ignored because the sender was not a PolicyCenter tab.", {
      tabId: info.tab?.id || null,
      url: redactLongUrl(info.tabUrl)
    });

    return {
      ok: false,
      error: "GWPC download trigger is limited to PolicyCenter tabs."
    };
  }

  const { tab, tabUrl } = info;
  const state = await getNetworkCaptureState();
  const alreadyWatchingThisTab = state?.active && isWatchedNetworkTab(state, tab.id);

  if (!alreadyWatchingThisTab) {
    await startNetworkPdfCapture({
      tabOverride: {
        id: tab.id,
        url: tabUrl,
        title: tab.title || message.pageTitle || ""
      },
      triggeredByDownloadButton: true,
      restartExisting: true
    });
  }

  await clearLatestPdfForTabIds([tab.id]);

  await logDiagnostic("latest PDF cleared", "Previous cached PDF for this GWPC tab was cleared before watching the next Download click.", {
    tabId: tab.id
  });

  await updateNetworkCaptureState({
    expectedPdfFromDownloadClick: true,
    triggerButtonId: message.buttonId || "",
    triggerButtonText: message.buttonText || "",
    triggerButtonAction: message.buttonAction || "",
    triggerAttemptId: message.triggerAttemptId || "",
    triggerPhase: message.triggerPhase || "click",
    triggerWasPrepared: Boolean(alreadyWatchingThisTab || state?.preparedForDownloadClick),
    interceptedClick: Boolean(message.interceptedClick),
    triggerClickedAt: new Date().toISOString(),
    status: "watching"
  });
  await logDiagnostic("GWPC download clicked", "GWPC Download button click detected; watching the next PolicyCenter PDF response.", {
    tabId: tab.id,
    url: redactLongUrl(tabUrl),
    phase: message.triggerPhase || "",
    attemptId: message.triggerAttemptId || "",
    interceptedClick: Boolean(message.interceptedClick),
    alreadyWatching: Boolean(alreadyWatchingThisTab),
    buttonId: message.buttonId || "",
    buttonText: message.buttonText || "",
    buttonAction: message.buttonAction || ""
  });
  await setActionBadge(tab.id, "PDF?", "#0f766e", "GWPC PDF trigger armed.", { persist: true });

  return {
    ok: true,
    watching: true,
    message: "GWPC Download button detected. Watching the next PolicyCenter PDF response."
  };
}

async function startNetworkPdfCapture(options = {}) {
  await syncRemoteConfig({ silent: true });

  const tab = options.tabOverride?.id ? options.tabOverride : await getActiveTab();
  const settings = await getEffectiveSettings();
  const existingState = await getNetworkCaptureState();
  const autoPolicyCenterCapture = Boolean(options.autoPolicyCenterCapture);
  const startedBySendBrowserPdf = Boolean(options.startedBySendBrowserPdf);
  const triggeredByDownloadButton = Boolean(options.triggeredByDownloadButton);
  const timeoutMs = autoPolicyCenterCapture ? AUTO_CAPTURE_TTL_MS : NETWORK_CAPTURE_TTL_MS;

  if (existingState?.active) {
    if (isWatchedNetworkTab(existingState, tab.id) && !options.restartExisting) {
      return {
        ok: true,
        watching: true,
        message: autoPolicyCenterCapture ? "GWPC PDF watch is already armed." : "Network watcher is already armed."
      };
    }

    await stopActiveNetworkPdfCapture({
      reason: "restarted watcher"
    });
  }

  if (!autoPolicyCenterCapture) {
    await resetDiagnosticLog();
  }

  await logDiagnostic("active tab ID", "Selected active tab for GWPC network watcher.", {
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || ""
  });

  if (settings.enabled === false) {
    await logDiagnostic("exact error message if failed", "Sending is disabled by remote config.");
    throw new Error("Sending is disabled by remote config.");
  }

  if (!isPolicyCenterUrl(tab.url)) {
    const message = "Network watcher is limited to the active GWPC/PolicyCenter tab.";
    await logDiagnostic("exact error message if failed", message, {
      url: tab.url || ""
    });
    throw new Error(message);
  }

  await stopNetworkPdfCapture(tab.id, { reason: "restarted watcher" });

  const startedAt = new Date().toISOString();
  const expiresAtMs = Date.now() + timeoutMs;

  policyCenterReplayRequests.clear();
  policyCenterFormSubmits.clear();

  const state = {
    active: true,
    status: "watching",
    mode: triggeredByDownloadButton
      ? "gwpc-download-trigger"
      : autoPolicyCenterCapture
        ? "gwpc-auto"
        : "manual-watch",
    tabId: tab.id,
    tabUrl: tab.url || "",
    tabTitle: tab.title || "",
    attachedTabIds: [tab.id],
    startedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    lastEventAt: startedAt,
    requestCount: 0,
    pdfDetected: false,
    responseBodyCaptured: false,
    webhookSent: false,
    expectedPdfFromDownloadClick: triggeredByDownloadButton,
    triggeredBy: triggeredByDownloadButton ? "gwpc-download-button" : "",
    lastError: ""
  };

  await setNetworkCaptureState(state);
  await logDiagnostic("watcher armed", "PolicyCenter PDF watcher armed.", {
    tabId: tab.id,
    timeoutSeconds: timeoutMs / 1000,
    autoPolicyCenterCapture,
    startedBySendBrowserPdf,
    triggeredByDownloadButton
  });

  await setActionBadge(
    tab.id,
    triggeredByDownloadButton ? "PDF?" : "NET",
    "#0f766e",
    triggeredByDownloadButton
      ? "GWPC Download click detected. Watching next PDF response."
      : autoPolicyCenterCapture
        ? "GWPC PDF watch armed."
        : "Network PDF watch armed.",
    { persist: true }
  );

  return {
    ok: true,
    watching: true,
    message: triggeredByDownloadButton
      ? "GWPC Download click detected. Watching the next PolicyCenter PDF response."
      : autoPolicyCenterCapture
        ? "GWPC PDF watch is armed."
        : "Network watcher is armed. Trigger/open/download the GWPC PDF now."
  };
}

async function stopNetworkPdfCapture(tabId, options = {}) {
  const reason = options.reason || "stopped";

  if (!options.keepState) {
    const status = reason === "timeout reached"
      ? "timeout"
      : reason === "stopped manually"
        ? "stopped"
        : "stopped";

    await updateNetworkCaptureState({
      active: false,
      status,
      lastError: status === "timeout" ? "Timeout reached before a PDF response was captured." : ""
    });

    if (reason === "timeout reached") {
      await logDiagnostic("timeout reached", "Network watcher timed out before a PDF was sent.", {
        tabId
      });
      await setActionBadge(tabId, "TIME", "#b42318", "Network PDF capture timed out.");
    } else if (reason === "stopped manually") {
      await logDiagnostic("stopped manually", "Network watcher stopped by user.", {
        tabId
      });
      await clearActionBadge(tabId);
    }
  }
}

async function stopActiveNetworkPdfCapture(options = {}) {
  const state = await getNetworkCaptureState();
  const reason = options.reason || "stopped manually";

  if (!state?.active) {
    await logDiagnostic("stopped manually", "Stop requested, but no active network watcher was stored.");
    return {
      ok: true,
      message: "No active network watcher."
    };
  }

  const tabIds = new Set([
    state.tabId,
    ...(state.attachedTabIds || [])
  ]);

  for (const tabId of tabIds) {
    await stopNetworkPdfCapture(tabId, {
      reason,
      keepState: true
    });
  }

  await updateNetworkCaptureState({
    active: false,
    status: reason === "timeout reached" ? "timeout" : "stopped",
    lastError: reason === "timeout reached" ? "Timeout reached before a PDF response was captured." : ""
  });
  policyCenterReplayRequests.clear();
  policyCenterFormSubmits.clear();

  if (reason === "timeout reached") {
    await logDiagnostic("timeout reached", "Network watcher timed out before a PDF was sent.", {
      tabIds: [...tabIds]
    });
  } else if (reason === "stopped manually") {
    await logDiagnostic("stopped manually", "Network watcher stopped by user.", {
      tabIds: [...tabIds]
    });
  } else {
    await logDiagnostic("exact error message if failed", "Network watcher stopped before PDF capture completed.", {
      reason,
      tabIds: [...tabIds]
    });
  }

  return {
    ok: true,
    message: "Network watcher stopped."
  };
}

async function handlePolicyCenterBeforeRequest(details) {
  cleanupExpiredReplayRequests();

  const state = await getNetworkCaptureState();

  if (!shouldTrackPolicyCenterRequest(state, details)) {
    return;
  }

  await ensurePolicyCenterRequestTabTracked(state, details);

  const bodyInfo = extractReplayRequestBody(details);
  const existing = policyCenterReplayRequests.get(details.requestId) || {};
  const replayRequest = {
    ...existing,
    requestId: details.requestId,
    url: details.url || existing.url || "",
    method: (details.method || existing.method || "GET").toUpperCase(),
    tabId: details.tabId,
    type: details.type || existing.type || "",
    createdAtMs: Date.now(),
    ...bodyInfo
  };

  policyCenterReplayRequests.set(details.requestId, replayRequest);

  await logDiagnostic("request body captured yes/no", "PolicyCenter request observed before it was sent.", {
    requestId: details.requestId,
    url: redactLongUrl(details.url || ""),
    method: details.method || "",
    type: details.type || "",
    tabId: details.tabId,
    bodyNeeded: bodyInfo.bodyNeeded,
    bodyCaptured: bodyInfo.bodyCaptured,
    bodyByteLength: bodyInfo.bodyByteLength,
    bodySource: bodyInfo.bodySource,
    bodyCaptureError: bodyInfo.bodyCaptureError || ""
  });
}

async function handlePolicyCenterBeforeSendHeaders(details) {
  cleanupExpiredReplayRequests();

  const state = await getNetworkCaptureState();

  if (!shouldTrackPolicyCenterRequest(state, details)) {
    return;
  }

  await ensurePolicyCenterRequestTabTracked(state, details);

  const existing = policyCenterReplayRequests.get(details.requestId) || {};
  const replayHeaders = getReplayableRequestHeaders(details.requestHeaders || []);
  const replayRequest = {
    ...existing,
    requestId: details.requestId,
    url: details.url || existing.url || "",
    method: (details.method || existing.method || "GET").toUpperCase(),
    tabId: details.tabId,
    type: details.type || existing.type || "",
    createdAtMs: existing.createdAtMs || Date.now(),
    replayHeaders
  };

  policyCenterReplayRequests.set(details.requestId, replayRequest);

  await logDiagnostic("request headers captured", "Replay-safe PolicyCenter request headers captured.", {
    requestId: details.requestId,
    url: redactLongUrl(details.url || ""),
    method: details.method || "",
    tabId: details.tabId,
    headerNames: Object.keys(replayHeaders)
  });
}

async function handlePolicyCenterHeadersReceived(details) {
  const state = await getNetworkCaptureState();

  if (!state?.active) {
    return;
  }

  await expireNetworkCaptureIfNeeded();

  const updatedState = await getNetworkCaptureState();
  if (!updatedState?.active) {
    return;
  }

  if (!shouldTrackPolicyCenterRequest(updatedState, details)) {
    return;
  }

  await ensurePolicyCenterRequestTabTracked(updatedState, details);

  const headers = normalizeWebRequestHeaders(details.responseHeaders || []);
  const contentType = `${headers["content-type"] || ""}`;
  const contentDisposition = `${headers["content-disposition"] || ""}`;
  const isPdf = isPdfHeaderValues(contentType, contentDisposition);

  await updateNetworkCaptureState({
    requestCount: (updatedState.requestCount || 0) + 1,
    lastResponseUrl: details.url || "",
    lastContentType: contentType,
    lastContentDisposition: contentDisposition,
    pdfDetected: isPdf || Boolean(updatedState.pdfDetected)
  });

  await logDiagnostic("webRequest response seen", "PolicyCenter webRequest response observed.", {
    url: redactLongUrl(details.url || ""),
    method: details.method || "",
    statusCode: details.statusCode || 0,
    type: details.type || "",
    tabId: details.tabId,
    contentType,
    contentDisposition,
    pdfDetected: isPdf
  });
  await logDiagnostic("content-type / headers checked", "Checked webRequest response headers for PDF signals.", {
    source: "webRequest",
    contentType,
    contentDisposition
  });
  await logDiagnostic("PDF detected yes/no", isPdf ? "PDF response detected by webRequest headers." : "webRequest response is not a PDF.", {
    source: "webRequest",
    pdfDetected: isPdf
  });

  if (isPdf) {
    const replayRequest = await waitForPolicyCenterReplaySource(updatedState, details);
    const cacheTabIds = getNetworkCapturePdfTabIds(updatedState, details.tabId);

    await clearLatestPdfForTabIds(cacheTabIds);
    await logDiagnostic("latest PDF cleared", "Previous cached PDF for the watched tab(s) was cleared before saving the newly opened PDF.", {
      tabIds: cacheTabIds
    });

    if (!replayRequest) {
      await updateNetworkCaptureState({
        responseBodyCaptured: false,
        lastError: "PDF headers were detected, but no replayable request or form submit was captured in time."
      });
      await logDiagnostic("response body captured yes/no", "PDF body was not captured because no matching request or form submit was available for replay.", {
        source: "webRequest-replay",
        bodyCaptured: false,
        requestId: details.requestId
      });
      return;
    }

    try {
      const pdf = await replayPolicyCenterPdfRequest(replayRequest, {
        responseUrl: details.url || "",
        contentType,
        contentDisposition,
        pageTabId: updatedState.tabId || details.tabId
      });
      const metadata = await saveLatestPdfCache({
        ...pdf,
        metadata: {
          ...pdf.metadata,
          sourceMode: "GWPC Download Trigger",
          capturedAt: new Date().toISOString()
        }
      }, {
        tabIds: cacheTabIds
      });

      await updateNetworkCaptureState({
        active: false,
        status: "cached",
        responseBodyCaptured: true,
        pdfDetected: true,
        latestPdfFileName: metadata.fileName,
        latestPdfSize: metadata.fileSize,
        latestPdfCapturedAt: metadata.capturedAt,
        lastError: ""
      });
      await logDiagnostic("response body captured yes/no", "PolicyCenter PDF response body captured by replaying the clicked download request.", {
        source: "webRequest-replay",
        bodyCaptured: true,
        byteLength: metadata.fileSize,
        fileName: metadata.fileName
      });
      await logDiagnostic("latest PDF cached", "Latest GWPC PDF cached locally. No webhook send was performed.", {
        cached: true,
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        sourceUrl: metadata.sourceUrl || "",
        sourceMode: metadata.sourceMode
      });
      await setActionBadge(details.tabId, "Email", "#0f766e", "Latest GWPC PDF cached. Click the extension icon to send.", { persist: true });
      policyCenterReplayRequests.clear();
    } catch (error) {
      await updateNetworkCaptureState({
        responseBodyCaptured: false,
        lastError: error.message || "Could not replay the PolicyCenter PDF request."
      });
      await logDiagnostic("exact error message if failed", error.message || "Could not replay the PolicyCenter PDF request.", {
        source: "webRequest-replay",
        requestId: details.requestId,
        url: redactLongUrl(details.url || "")
      });
    }
  }
}

async function waitForPolicyCenterReplaySource(state, details) {
  const deadline = Date.now() + 1000;

  while (Date.now() <= deadline) {
    const replayRequest = getPolicyCenterReplaySource(state, details);

    if (replayRequest) {
      return replayRequest;
    }

    await sleep(50);
  }

  return null;
}

function getPolicyCenterReplaySource(state, details) {
  const replayRequest = policyCenterReplayRequests.get(details.requestId);

  if (replayRequest && isReplayRequestBodyReady(replayRequest)) {
    return replayRequest;
  }

  const capturedForm = getCapturedPolicyCenterFormSubmit(state, details);

  if (!capturedForm) {
    return null;
  }

  if (!capturedForm.bodyCaptured) {
    return {
      requestId: capturedForm.id,
      url: capturedForm.url,
      method: capturedForm.method,
      tabId: capturedForm.tabId,
      type: "captured-form-submit",
      createdAtMs: capturedForm.createdAtMs,
      bodyNeeded: true,
      bodyCaptured: false,
      bodyBase64: "",
      bodyByteLength: capturedForm.bodyByteLength || 0,
      bodySource: capturedForm.source,
      bodyCaptureError: capturedForm.bodyCaptureError || "Captured form submit was not replayable.",
      replayHeaders: getCapturedFormReplayHeaders(capturedForm)
    };
  }

  return {
    requestId: capturedForm.id,
    url: capturedForm.url,
    method: capturedForm.method,
    tabId: capturedForm.tabId,
    type: "captured-form-submit",
    createdAtMs: capturedForm.createdAtMs,
    bodyNeeded: true,
    bodyCaptured: true,
    bodyBase64: capturedForm.bodyBase64,
    bodyByteLength: capturedForm.bodyByteLength,
    bodySource: capturedForm.source,
    replayHeaders: getCapturedFormReplayHeaders(capturedForm),
    inferredContentType: "application/x-www-form-urlencoded;charset=UTF-8"
  };
}

function isReplayRequestBodyReady(request) {
  const method = `${request.method || "GET"}`.toUpperCase();

  if (method === "GET" || method === "HEAD") {
    return true;
  }

  return Boolean(request.bodyCaptured || request.bodyBase64 || request.bodySource === "empty");
}

function getCapturedPolicyCenterFormSubmit(state, details) {
  cleanupExpiredReplayRequests();

  const tabIds = getNetworkCapturePdfTabIds(state, details.tabId);
  const candidates = [];

  for (const tabId of tabIds) {
    const capture = policyCenterFormSubmits.get(`tab:${tabId}`);

    if (capture) {
      candidates.push(capture);
    }
  }

  for (const capture of policyCenterFormSubmits.values()) {
    if (tabIds.includes(capture.tabId)) {
      candidates.push(capture);
    }
  }

  return candidates
    .filter((capture, index, all) => all.findIndex((item) => item.id === capture.id) === index)
    .filter((capture) => isLikelySamePolicyCenterEndpoint(capture.url, details.url))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] || null;
}

function getCapturedFormReplayHeaders(capturedForm) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
  };
}

function isLikelySamePolicyCenterEndpoint(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);

    return leftUrl.hostname === rightUrl.hostname
      && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function shouldTrackPolicyCenterRequest(state, details) {
  if (!state?.active || !details?.url || !isPolicyCenterUrl(details.url)) {
    return false;
  }

  if (!Number.isInteger(details.tabId) || details.tabId < 0) {
    return false;
  }

  return isWatchedNetworkTab(state, details.tabId)
    || state.expectedPdfFromDownloadClick === true
    || state.mode === "gwpc-download-trigger"
    || state.mode === "manual-watch";
}

async function ensurePolicyCenterRequestTabTracked(state, details) {
  if (!state?.active || !Number.isInteger(details.tabId) || details.tabId < 0) {
    return;
  }

  if (isWatchedNetworkTab(state, details.tabId)) {
    return;
  }

  await addWatchedNetworkTab(
    details.tabId,
    details.url || "",
    "",
    "PolicyCenter PDF request appeared in a new tab after the GWPC Download click."
  );
}

function extractReplayRequestBody(details) {
  const method = (details.method || "GET").toUpperCase();
  const bodyNeeded = method !== "GET" && method !== "HEAD";

  if (!bodyNeeded) {
    return {
      bodyNeeded,
      bodyCaptured: true,
      bodyBase64: "",
      bodyByteLength: 0,
      bodySource: "none"
    };
  }

  const requestBody = details.requestBody || {};

  if (requestBody.error) {
    return {
      bodyNeeded,
      bodyCaptured: false,
      bodyBase64: "",
      bodyByteLength: 0,
      bodySource: "error",
      bodyCaptureError: requestBody.error
    };
  }

  if (requestBody.raw?.length) {
    const buffers = [];
    let byteLength = 0;

    for (const part of requestBody.raw) {
      if (!part.bytes) {
        return {
          bodyNeeded,
          bodyCaptured: false,
          bodyBase64: "",
          bodyByteLength: byteLength,
          bodySource: "raw",
          bodyCaptureError: "Request body included a file-backed part that cannot be replayed."
        };
      }

      const bytes = new Uint8Array(part.bytes);
      byteLength += bytes.byteLength;

      if (byteLength > MAX_REPLAY_BODY_BYTES) {
        return {
          bodyNeeded,
          bodyCaptured: false,
          bodyBase64: "",
          bodyByteLength: byteLength,
          bodySource: "raw",
          bodyCaptureError: "Request body was larger than the replay safety limit."
        };
      }

      buffers.push(bytes);
    }

    return {
      bodyNeeded,
      bodyCaptured: true,
      bodyBase64: uint8ArrayToBase64(concatUint8Arrays(buffers, byteLength)),
      bodyByteLength: byteLength,
      bodySource: "raw"
    };
  }

  if (requestBody.formData && typeof requestBody.formData === "object") {
    const params = new URLSearchParams();

    for (const [key, values] of Object.entries(requestBody.formData)) {
      const list = Array.isArray(values) ? values : [values];

      list.forEach((value) => params.append(key, `${value ?? ""}`));
    }

    const bytes = new TextEncoder().encode(params.toString());

    if (bytes.byteLength > MAX_REPLAY_BODY_BYTES) {
      return {
        bodyNeeded,
        bodyCaptured: false,
        bodyBase64: "",
        bodyByteLength: bytes.byteLength,
        bodySource: "formData",
        bodyCaptureError: "Form body was larger than the replay safety limit."
      };
    }

    return {
      bodyNeeded,
      bodyCaptured: true,
      bodyBase64: uint8ArrayToBase64(bytes),
      bodyByteLength: bytes.byteLength,
      bodySource: "formData",
      inferredContentType: "application/x-www-form-urlencoded;charset=UTF-8"
    };
  }

  return {
    bodyNeeded,
    bodyCaptured: true,
    bodyBase64: "",
    bodyByteLength: 0,
    bodySource: "empty"
  };
}

function normalizeCapturedPolicyCenterForm(form, tab, message) {
  if (!form?.url || !isPolicyCenterUrl(form.url) || !Number.isInteger(tab?.id)) {
    return null;
  }

  const method = `${form.method || "GET"}`.toUpperCase();

  if (method === "GET" || method === "HEAD") {
    return null;
  }

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const hasFile = fields.some((field) => field?.isFile);

  if (hasFile) {
    return {
      id: makeCapturedFormId(tab.id),
      tabId: tab.id,
      url: form.url,
      method,
      enctype: form.enctype || "",
      source: form.source || "form-submit",
      fieldCount: Number(form.fieldCount) || fields.length,
      hasFile: true,
      bodyCaptured: false,
      bodyCaptureError: "Captured form includes a file input and cannot be replayed safely.",
      createdAtMs: Date.now(),
      triggerAttemptId: message.triggerAttemptId || ""
    };
  }

  const params = new URLSearchParams();
  const fieldNames = [];

  for (const field of fields) {
    if (!field?.name || field.isFile) {
      continue;
    }

    params.append(field.name, `${field.value ?? ""}`);
    fieldNames.push(field.name);
  }

  const bytes = new TextEncoder().encode(params.toString());

  if (bytes.byteLength > MAX_REPLAY_BODY_BYTES) {
    return {
      id: makeCapturedFormId(tab.id),
      tabId: tab.id,
      url: form.url,
      method,
      enctype: form.enctype || "",
      source: form.source || "form-submit",
      fieldCount: Number(form.fieldCount) || fields.length,
      fieldNames,
      hasFile: false,
      bodyCaptured: false,
      bodyByteLength: bytes.byteLength,
      bodyCaptureError: "Captured form body was larger than the replay safety limit.",
      createdAtMs: Date.now(),
      triggerAttemptId: message.triggerAttemptId || ""
    };
  }

  return {
    id: makeCapturedFormId(tab.id),
    tabId: tab.id,
    url: form.url,
    method,
    enctype: form.enctype || "application/x-www-form-urlencoded",
    source: form.source || "form-submit",
    target: form.target || "",
    formId: form.id || "",
    formName: form.name || "",
    fieldCount: Number(form.fieldCount) || fields.length,
    fieldNames,
    hasFile: false,
    bodyCaptured: true,
    bodyBase64: uint8ArrayToBase64(bytes),
    bodyByteLength: bytes.byteLength,
    createdAtMs: Date.now(),
    triggerAttemptId: message.triggerAttemptId || "",
    capturedAt: form.capturedAt || new Date().toISOString()
  };
}

function makeCapturedFormId(tabId) {
  return `tab:${tabId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function getReplayableRequestHeaders(requestHeaders) {
  const headers = {};
  const blocked = new Set([
    "accept-encoding",
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "proxy-authorization",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "user-agent"
  ]);

  for (const header of requestHeaders || []) {
    const name = `${header.name || ""}`.toLowerCase();
    const value = `${header.value ?? ""}`;

    if (!name || blocked.has(name) || name.startsWith("proxy-") || name.startsWith("sec-ch-")) {
      continue;
    }

    headers[name] = value;
  }

  return headers;
}

async function replayPolicyCenterPdfRequest(request, originalResponse) {
  if (!request?.url || !isPolicyCenterUrl(request.url)) {
    throw new Error("The captured request is not a PolicyCenter URL.");
  }

  const method = (request.method || "GET").toUpperCase();

  if (method === "HEAD") {
    throw new Error("The captured PDF request used HEAD and cannot return a PDF body.");
  }

  if (request.bodyNeeded && !request.bodyCaptured) {
    throw new Error(request.bodyCaptureError || "The PDF request body was not captured for replay.");
  }

  const headers = {
    ...(request.replayHeaders || {})
  };
  const init = {
    method,
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers
  };

  if (method !== "GET" && request.bodyBase64) {
    init.body = base64ToUint8Array(request.bodyBase64);

    if (!headers["content-type"] && request.inferredContentType) {
      headers["content-type"] = request.inferredContentType;
    }
  }

  await logDiagnostic("PDF replay attempted", "Replaying the clicked PolicyCenter request to read the original PDF bytes.", {
    requestId: request.requestId,
    url: redactLongUrl(request.url),
    method,
    bodyByteLength: request.bodyByteLength || 0,
    headerNames: Object.keys(headers)
  });

  try {
    const response = await fetch(request.url, init);
    const result = await readReplayFetchResponse(response, "webRequest-replay");

    return buildPolicyCenterPdfFromReplayResult(result, request, originalResponse);
  } catch (error) {
    await logDiagnostic("exact error message if failed", "Extension replay failed; trying page-context replay.", {
      source: "webRequest-replay",
      error: error.message || "Unknown replay error.",
      pageTabId: originalResponse.pageTabId || null
    });

    return replayPolicyCenterPdfRequestInPage(request, originalResponse);
  }
}

async function readReplayFetchResponse(response, source) {
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const replayLooksPdf = isPdfHeaderValues(contentType, contentDisposition);

  await logDiagnostic("content-type / headers checked", "Checked replay response headers for PDF signals.", {
    source,
    statusCode: response.status,
    contentType,
    contentDisposition,
    pdfDetected: replayLooksPdf
  });

  if (!response.ok) {
    throw new Error(`PolicyCenter replay returned HTTP ${response.status}.`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (!isPdfBytes(bytes)) {
    throw new Error("PolicyCenter replay did not return PDF bytes.");
  }

  return {
    base64: arrayBufferToBase64(buffer),
    byteLength: bytes.byteLength,
    finalUrl: response.url || "",
    contentType,
    contentDisposition
  };
}

async function replayPolicyCenterPdfRequestInPage(request, originalResponse) {
  if (!Number.isInteger(originalResponse.pageTabId)) {
    throw new Error("Page-context replay was not available because no GWPC page tab was tracked.");
  }

  const payload = {
    url: request.url,
    method: (request.method || "GET").toUpperCase(),
    headers: request.replayHeaders || {},
    bodyBase64: request.bodyBase64 || "",
    inferredContentType: request.inferredContentType || ""
  };
  const results = await chrome.scripting.executeScript({
    target: {
      tabId: originalResponse.pageTabId
    },
    world: "MAIN",
    func: replayPolicyCenterPdfInPage,
    args: [payload]
  });
  const result = results.find((entry) => entry?.result)?.result;

  if (!result?.ok) {
    throw new Error(result?.error || "Page-context replay did not return a PDF.");
  }

  await logDiagnostic("content-type / headers checked", "Checked page-context replay response headers for PDF signals.", {
    source: "page-context-replay",
    statusCode: result.statusCode || 0,
    contentType: result.contentType || "",
    contentDisposition: result.contentDisposition || "",
    pdfDetected: true
  });

  return buildPolicyCenterPdfFromReplayResult(result, request, originalResponse);
}

function buildPolicyCenterPdfFromReplayResult(result, request, originalResponse) {
  const fileName = getNetworkPdfFileName({
    url: result.finalUrl || originalResponse.responseUrl || request.url,
    headers: {
      "content-disposition": result.contentDisposition || originalResponse.contentDisposition || "",
      "content-type": result.contentType || originalResponse.contentType || "application/pdf"
    }
  });

  return {
    base64: result.base64,
    fileName,
    metadata: {
      fileName,
      fileSize: result.byteLength || base64ToByteLength(result.base64 || ""),
      contentType: "application/pdf",
      source: "policycenter-replay-pdf",
      sourceUrl: originalResponse.responseUrl || request.url,
      replayUrl: result.finalUrl || request.url,
      originalMethod: (request.method || "GET").toUpperCase(),
      originalRequestType: request.type || "",
      discoveredBy: "gwpc-download-button",
      foundAt: new Date().toISOString()
    }
  };
}

async function replayPolicyCenterPdfInPage(payload) {
  try {
    const headers = {
      ...(payload.headers || {})
    };
    const init = {
      method: payload.method || "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers
    };

    if (init.method !== "GET" && payload.bodyBase64) {
      init.body = base64ToBytes(payload.bodyBase64);

      if (!headers["content-type"] && payload.inferredContentType) {
        headers["content-type"] = payload.inferredContentType;
      }
    }

    const response = await fetch(payload.url, init);
    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";

    if (!response.ok) {
      return {
        ok: false,
        error: `PolicyCenter page-context replay returned HTTP ${response.status}.`
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      return {
        ok: false,
        error: "PolicyCenter page-context replay did not return PDF bytes."
      };
    }

    return {
      ok: true,
      base64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
      finalUrl: response.url || payload.url,
      statusCode: response.status,
      contentType,
      contentDisposition
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "PolicyCenter page-context replay failed."
    };
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }
}

function cleanupExpiredReplayRequests() {
  const now = Date.now();

  for (const [requestId, request] of policyCenterReplayRequests.entries()) {
    if (!request?.createdAtMs || now - request.createdAtMs > REPLAY_REQUEST_TTL_MS) {
      policyCenterReplayRequests.delete(requestId);
    }
  }

  for (const [captureId, capture] of policyCenterFormSubmits.entries()) {
    if (!capture?.createdAtMs || now - capture.createdAtMs > FORM_SUBMIT_CAPTURE_TTL_MS) {
      policyCenterFormSubmits.delete(captureId);
    }
  }
}

async function handleDownloadCreated(downloadItem) {
  const filename = downloadItem.filename || "";
  const url = downloadItem.finalUrl || downloadItem.url || "";
  const mime = downloadItem.mime || "";
  const pdfDetected = mime.toLowerCase().includes("application/pdf")
    || filename.toLowerCase().endsWith(".pdf")
    || url.toLowerCase().includes(".pdf");

  if (!pdfDetected) {
    return;
  }

  await logDiagnostic("download created", "PDF download was created; attempting latest-PDF cache only.", {
    filename,
    url: redactLongUrl(url),
    mime,
    danger: downloadItem.danger || "",
    tabId: Number.isInteger(downloadItem.tabId) ? downloadItem.tabId : null,
    pdfDetected
  });

  if (!/^https?:/i.test(url)) {
    await logDiagnostic("latest PDF cached", "PDF download was detected, but its URL cannot be fetched by the extension.", {
      cached: false,
      url: redactLongUrl(url)
    });
    return;
  }

  try {
    const pdf = await tryReadPdfFromUrl(url, {
      title: filename || "download.pdf",
      source: "download",
      discoveredFrom: "chrome.downloads"
    });

    if (!pdf) {
      await logDiagnostic("latest PDF cached", "PDF download URL could not be read back for caching.", {
        cached: false,
        url: redactLongUrl(url)
      });
      return;
    }

    const metadata = await saveLatestPdfCache({
      ...pdf,
      metadata: {
        ...pdf.metadata,
        sourceMode: "Universal Manual",
        capturedAt: new Date().toISOString()
      }
    }, {
      tabId: Number.isInteger(downloadItem.tabId) ? downloadItem.tabId : null
    });

    await logDiagnostic("latest PDF cached", "Downloaded PDF cached locally. No webhook send was performed.", {
      cached: true,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      sourceUrl: metadata.sourceUrl || "",
      sourceMode: metadata.sourceMode
    });
  } catch (error) {
    await logDiagnostic("exact error message if failed", error.message || "Could not cache detected PDF download.", {
      url: redactLongUrl(url)
    });
  }
}

async function handlePolicyCenterAutoTabCreated(tab) {
  const url = tab.pendingUrl || tab.url || "";

  if (Number.isInteger(tab.id) && isPolicyCenterUrl(url)) {
    await ensurePolicyCenterAutoCapture(tab.id, url, tab.title || "");
  }
}

async function handlePolicyCenterAutoTabUpdated(tabId, changeInfo, tab) {
  const url = changeInfo.url || tab?.url || tab?.pendingUrl || "";

  if (!Number.isInteger(tabId) || !isPolicyCenterUrl(url)) {
    return;
  }

  if (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url) {
    await ensurePolicyCenterAutoCapture(tabId, url, tab?.title || "");
  }
}

async function ensurePolicyCenterAutoCapture(tabId, url, title) {
  const state = await getNetworkCaptureState();

  if (state?.active && isWatchedNetworkTab(state, tabId)) {
    await updateNetworkCaptureState({
      mode: state.mode || "gwpc-auto",
      tabUrl: url || state.tabUrl,
      tabTitle: title || state.tabTitle,
      status: "watching",
      expiresAtMs: Date.now() + AUTO_CAPTURE_TTL_MS,
      expiresAt: new Date(Date.now() + AUTO_CAPTURE_TTL_MS).toISOString()
    });
    return;
  }

  if (state?.active && !isWatchedNetworkTab(state, tabId)) {
    await addWatchedNetworkTab(tabId, url, title, "PolicyCenter tab detected for automatic PDF caching.");
    return;
  }

  await startNetworkPdfCapture({
    tabOverride: {
      id: tabId,
      url,
      title
    },
    autoPolicyCenterCapture: true
  }).catch(async (error) => {
    await logDiagnostic("exact error message if failed", error.message || "Could not arm GWPC auto-capture.", {
      tabId,
      url: redactLongUrl(url || "")
    });
  });
}

async function handleWindowCreated(window) {
  const state = await getNetworkCaptureState();

  if (!state?.active) {
    return;
  }

  await logDiagnostic("new window detected", "Browser window created while watcher was active.", {
    windowId: window.id,
    type: window.type || "",
    state: window.state || ""
  });
}

async function handleTabCreated(tab) {
  const state = await getNetworkCaptureState();

  if (!state?.active) {
    return;
  }

  await expireNetworkCaptureIfNeeded();

  const updatedState = await getNetworkCaptureState();
  if (!updatedState?.active) {
    return;
  }

  const url = tab.pendingUrl || tab.url || "";
  await logDiagnostic("new tab detected", "Browser tab created while watcher was active.", {
    tabId: tab.id,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    url: redactLongUrl(url),
    title: tab.title || ""
  });

  if (Number.isInteger(tab.id) && isPolicyCenterUrl(url)) {
    await addWatchedNetworkTab(tab.id, url, tab.title || "", "New PolicyCenter tab created during watcher mode.");
  }
}

async function addWatchedNetworkTab(tabId, url, title, message) {
  const state = await getNetworkCaptureState();

  if (!state?.active || !Number.isInteger(tabId)) {
    return;
  }

  const attachedTabIds = [...new Set([
    state.tabId,
    ...(state.attachedTabIds || []),
    tabId
  ])].filter(Number.isInteger);

  await updateNetworkCaptureState({
    attachedTabIds,
    tabUrl: state.tabId === tabId ? (url || state.tabUrl) : state.tabUrl,
    tabTitle: state.tabId === tabId ? (title || state.tabTitle) : state.tabTitle,
    status: "watching"
  });
  await logDiagnostic("new PolicyCenter tab created", message, {
    tabId,
    url: redactLongUrl(url || ""),
    title: title || ""
  });
  await setActionBadge(tabId, "NET", "#0f766e", "Network PDF header watch armed.", { persist: true }).catch(() => {});
}

async function handleWatchedTabUpdated(tabId, changeInfo, tab) {
  const state = await getNetworkCaptureState();

  if (!state?.active) {
    return;
  }

  await expireNetworkCaptureIfNeeded();

  const updatedState = await getNetworkCaptureState();
  if (!updatedState?.active) {
    return;
  }

  const tabUrl = changeInfo.url || tab?.url || "";

  if (!isWatchedNetworkTab(updatedState, tabId)) {
    if (tabUrl && isPolicyCenterUrl(tabUrl)) {
      await addWatchedNetworkTab(tabId, tabUrl, tab?.title || "", "PolicyCenter tab appeared while watcher was active.");
    }
    return;
  }

  if (changeInfo.status === "loading" || changeInfo.url) {
    await logDiagnostic("page reload detected", "Watched GWPC tab started loading/reloading; watcher remains armed.", {
      tabId,
      status: changeInfo.status || "",
      url: tabUrl
    });
  }

  if (tab?.url || tab?.title) {
    await updateNetworkCaptureState({
      tabUrl: tab.url || state.tabUrl,
      tabTitle: tab.title || state.tabTitle,
      status: "watching"
    });
  }
}

async function handleWatchedTabRemoved(tabId) {
  const state = await getNetworkCaptureState();

  if (!state?.active || !isWatchedNetworkTab(state, tabId)) {
    return;
  }

  if (state.tabId !== tabId) {
    await logDiagnostic("new PolicyCenter tab created", "Attached PolicyCenter tab was closed while watcher remained active.", {
      tabId
    });
    await stopNetworkPdfCapture(tabId, {
      reason: "tab closed",
      keepState: true
    });
    await updateNetworkCaptureState({
      attachedTabIds: (state.attachedTabIds || []).filter((id) => id !== tabId),
      status: "watching"
    });
    return;
  }

  await logDiagnostic("exact error message if failed", "Watched GWPC tab was closed before PDF capture completed.", {
    tabId
  });
  await stopActiveNetworkPdfCapture({ reason: "tab closed" });
}

async function expireNetworkCaptureIfNeeded() {
  const state = await getNetworkCaptureState();

  if (!state?.active || !state.expiresAtMs || Date.now() <= state.expiresAtMs) {
    return;
  }

  await stopActiveNetworkPdfCapture({ reason: "timeout reached" });
}

async function sendCapturedPdfFromPage(file, sender) {
  const session = await getActiveDownloadCaptureSession(sender);
  const settings = await getEffectiveSettings();

  if (!session) {
    throw new Error("Download capture is not armed for this tab.");
  }

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  const capturedPdf = normalizeCapturedBrowserPdf(file);

  const delivery = await deliverPdf(settings, capturedPdf, sender.tab?.id);
  await clearDownloadCaptureSession();

  if (!delivery.webAppOpened) {
    await setActionBadge(sender.tab.id, "OK", "#0f766e", delivery.message);
  }

  return {
    ok: true,
    message: delivery.message,
    webAppOpened: delivery.webAppOpened
  };
}

async function sendPdfCandidateFromPage(candidate, sender) {
  const session = await getActiveDownloadCaptureSession(sender);
  const settings = await getEffectiveSettings();

  if (!session) {
    throw new Error("Download capture is not armed for this tab.");
  }

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  const pdf = await tryReadPdfFromUrl(candidate.url, {
    title: sender.tab?.title,
    source: candidate.source || "captured-download",
    discoveredFrom: sender.tab?.url || ""
  });

  if (!pdf) {
    throw new Error("The captured download link did not return a readable PDF.");
  }

  const delivery = await deliverPdf(settings, pdf, sender.tab?.id);
  await clearDownloadCaptureSession();

  if (!delivery.webAppOpened) {
    await setActionBadge(sender.tab.id, "OK", "#0f766e", delivery.message);
  }

  return {
    ok: true,
    message: delivery.message,
    webAppOpened: delivery.webAppOpened
  };
}

async function sendUploadedPdf(file) {
  await syncRemoteConfig({ silent: true });

  const settings = await getEffectiveSettings();

  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  validateDeliverySettings(settings);

  const uploadedPdf = normalizeUploadedPdf(file);

  const delivery = await deliverPdf(settings, uploadedPdf);

  return {
    ok: true,
    message: delivery.message,
    webAppOpened: delivery.webAppOpened
  };
}

async function findBrowserPdf(tab) {
  const directPdf = await tryReadPdfFromUrl(tab.url, {
    title: tab.title,
    source: "tab-url"
  });

  if (directPdf) {
    return directPdf;
  }

  if (isBrowserPdfReaderUrl(tab.url || "")) {
    const sourceUrl = getBrowserPdfReaderSourceUrl(tab.url || "");
    const readerPdf = sourceUrl && sourceUrl !== tab.url
      ? await tryReadPdfFromUrl(sourceUrl, {
        title: tab.title,
        source: "pdf-viewer-src",
        discoveredFrom: tab.url
      })
      : null;

    if (readerPdf) {
      return readerPdf;
    }
  }

  const candidates = await discoverPdfCandidates(tab);
  const visibleCandidates = candidates.filter((candidate) => candidate.visible === true);
  const candidatesToTry = visibleCandidates.length ? visibleCandidates : candidates;

  for (const candidate of candidatesToTry.slice(0, MAX_PDF_CANDIDATES)) {
    const pdf = candidate.url.startsWith("blob:")
      ? await tryReadBlobPdfInPage(tab, candidate)
      : await tryReadPdfFromUrl(candidate.url, {
        title: tab.title,
        source: candidate.source,
        discoveredFrom: tab.url
      });

    if (pdf) {
      return pdf;
    }
  }

  throw new Error("Could not find an original PDF file in this browser tab. Open the direct PDF view or click the site's download button, then try again.");
}

async function discoverPdfCandidates(tab) {
  if (!tab?.id || isProtectedBrowserUrl(tab.url)) {
    return [];
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: true
      },
      func: collectPdfCandidatesInPage
    });
    const candidates = results.flatMap((result) => Array.isArray(result?.result?.candidates)
      ? result.result.candidates
      : []);
    const bestByUrl = new Map();

    for (const candidate of candidates) {
      if (!candidate?.url) {
        continue;
      }

      if (isAltaPresentationUrl(tab.url || "") && isAltaBlockedPdfCandidate(candidate)) {
        continue;
      }

      const normalized = {
        url: candidate.url,
        source: candidate.source || "page",
        tagName: candidate.tagName || "",
        visible: candidate.visible === true,
        inViewport: candidate.inViewport === true,
        visibleArea: Number(candidate.visibleArea) || 0
      };
      const existing = bestByUrl.get(candidate.url);

      if (!existing || comparePdfCandidates(normalized, existing) < 0) {
        bestByUrl.set(candidate.url, normalized);
      }
    }

    return Array.from(bestByUrl.values()).sort(comparePdfCandidates);
  } catch {
    return [];
  }
}

function comparePdfCandidates(left, right) {
  const leftRank = getPdfCandidateRank(left);
  const rightRank = getPdfCandidateRank(right);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if ((left.inViewport === true) !== (right.inViewport === true)) {
    return left.inViewport === true ? -1 : 1;
  }

  return (right.visibleArea || 0) - (left.visibleArea || 0);
}

function getPdfCandidateRank(candidate = {}) {
  if (candidate.source === "location") {
    return 0;
  }

  if (candidate.visible === true) {
    return /^(embed|iframe|object)$/i.test(candidate.tagName || "") ? 1 : 2;
  }

  return String(candidate.source || "").includes("performance") ? 4 : 3;
}

function isAltaPresentationUrl(url = "") {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "alta.farmers.com" && parsed.pathname === "/quote/presentation";
  } catch {
    return false;
  }
}

function isAltaBlockedPdfCandidate(candidate = {}) {
  const value = decodeURIComponentSafe([
    candidate.url || "",
    candidate.source || "",
    candidate.tagName || ""
  ].join(" ")).toLowerCase();

  return /360\s*value|360value|valuation|reconstruction/.test(value);
}

function isBrowserPdfReaderUrl(url = "") {
  if (url.startsWith("data:application/pdf")) {
    return true;
  }

  if (urlLooksLikePdfFile(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const viewerSource = parsed.searchParams.get("src") || "";

    return parsed.protocol === "chrome-extension:"
      && parsed.pathname.endsWith("/index.html")
      && (viewerSource.startsWith("file:") || urlLooksLikePdfFile(viewerSource));
  } catch {
    return false;
  }
}

function getBrowserPdfReaderSourceUrl(url = "") {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "chrome-extension:" && parsed.pathname.endsWith("/index.html")) {
      return parsed.searchParams.get("src") || "";
    }
  } catch {
    return "";
  }

  return "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryReadPdfFromUrl(url, context = {}) {
  if (!url) {
    return null;
  }

  if (url.startsWith("data:")) {
    return readPdfFromDataUrl(url, context);
  }

  if (url.startsWith("blob:")) {
    return null;
  }

  if (!/^(https?|file):/i.test(url)) {
    return null;
  }

  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include"
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";
    const fileNameFromUrl = getBrowserPdfFileName(url, context.title);
    const hasPdfSignal = isPdfHeaderValues(contentType, contentDisposition)
      || urlLooksLikePdfFile(url);

    if (!hasPdfSignal) {
      return null;
    }

    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (!isPdfBytes(bytes)) {
      return null;
    }

    return {
      base64: arrayBufferToBase64(buffer),
      fileName: fileNameFromUrl,
      metadata: {
        fileName: fileNameFromUrl,
        fileSize: bytes.byteLength,
        contentType: "application/pdf",
        source: "browser-pdf",
        sourceUrl: url,
        discoveredBy: context.source || "url",
        discoveredFrom: context.discoveredFrom || "",
        foundAt: new Date().toISOString()
      }
    };
  } catch {
    return null;
  }
}

function readPdfFromDataUrl(url, context = {}) {
  const match = url.match(/^data:application\/pdf(?:;[^,]*)?,(.*)$/i);

  if (!match) {
    return null;
  }

  const isBase64 = /^data:application\/pdf[^,]*;base64,/i.test(url);
  const rawData = match[1] || "";
  const base64 = isBase64 ? rawData : btoa(decodeURIComponent(rawData));

  if (!isPdfBase64(base64)) {
    return null;
  }

  return {
    base64,
    fileName: getBrowserPdfFileName("", context.title),
    metadata: {
      fileName: getBrowserPdfFileName("", context.title),
      fileSize: base64ToByteLength(base64),
      contentType: "application/pdf",
      source: "browser-pdf",
      sourceUrl: "data:application/pdf",
      discoveredBy: context.source || "data-url",
      discoveredFrom: context.discoveredFrom || "",
      foundAt: new Date().toISOString()
    }
  };
}

async function tryReadBlobPdfInPage(tab, candidate) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: true
      },
      func: readBlobPdfInPage,
      args: [candidate.url]
    });
    const result = results.find((entry) => entry?.result?.base64)?.result;

    if (!result?.base64 || !isPdfBase64(result.base64)) {
      return null;
    }

    const fileName = getBrowserPdfFileName(candidate.url, tab.title);

    return {
      base64: result.base64,
      fileName,
      metadata: {
        fileName,
        fileSize: result.fileSize || base64ToByteLength(result.base64),
        contentType: "application/pdf",
        source: "browser-pdf",
        sourceUrl: candidate.url,
        discoveredBy: candidate.source || "blob-url",
        discoveredFrom: tab.url || "",
        foundAt: new Date().toISOString()
      }
    };
  } catch {
    return null;
  }
}

async function sendPdfToWebhook(settings, pdf) {
  if (settings.sendMode === "jsonBase64") {
    await sendJsonBase64(settings.webhookUrl, pdf);
    return;
  }

  if (settings.sendMode === "rawPdf") {
    await sendRawPdf(settings.webhookUrl, pdf);
    return;
  }

  await sendMultipart(settings.webhookUrl, pdf);
}

async function deliverPdf(settings, pdf, sourceTabId = null) {
  const deliveryMode = normalizeDeliveryMode(settings.deliveryMode);
  const shouldOpenWebApp = deliveryMode === "webApp" || deliveryMode === "both";
  const shouldPostWebhook = deliveryMode === "webhook" || deliveryMode === "both";
  const result = {
    webAppOpened: false,
    webhookSent: false,
    message: ""
  };

  if (shouldOpenWebApp) {
    await sendPdfToQuoteToEmailApp(pdf, sourceTabId);
    result.webAppOpened = true;
  }

  if (shouldPostWebhook) {
    await sendPdfToWebhook(settings, pdf);
    result.webhookSent = true;
  }

  result.message = getDeliverySuccessMessage(settings, result);
  return result;
}

async function sendPdfToQuoteToEmailApp(pdf, sourceTabId = null) {
  const base64 = stripPdfDataUrlPrefix(pdf.base64 || "");

  if (!isPdfBase64(base64)) {
    throw new Error("PDF delivery rejected a file that did not look like a valid PDF.");
  }

  const filename = sanitizeUploadedPdfFileName(pdf.fileName || pdf.metadata?.fileName || "quote.pdf");
  const sourceId = Number.isInteger(sourceTabId) ? sourceTabId : null;

  await setQteBadges([sourceId], "...", "#475467", "Sending to Quote-to-Email…");

  const expiresAtMs = Date.now() + QTE_PENDING_PDF_TIMEOUT_MS;
  const entry = {
    handoffId: crypto.randomUUID(),
    targetTabId: null,
    sourceTabId: sourceId,
    filename,
    base64,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    metadata: {
      ...(pdf.metadata || {}),
      deliveredBy: "qte-extension-bridge"
    }
  };
  let tab = null;
  let dropped = [];

  try {
    // Pick the tab and append in one queued task, so a double-click cannot open two tabs.
    dropped = await updateQtePendingPdfs(async (list) => {
      tab = await findQteTargetTab(list);
      entry.targetTabId = tab.id;

      const next = [...list, entry];

      return {
        next: next.slice(-QTE_MAX_PENDING_PDFS),
        result: next.slice(0, -QTE_MAX_PENDING_PDFS)
      };
    });
  } catch (error) {
    if (!tab) {
      throw error;
    }

    const message = "Quote-to-Email handoff failed: browser storage is full. Wait for the open PDFs to finish, then try again.";

    await logDiagnostic("Quote-to-Email handoff failed", error?.message || message, {
      fileName: filename,
      byteLength: base64ToByteLength(base64)
    }).catch(() => {});
    await setQteBadges([sourceId], "ERR", "#b42318", message);
    throw new Error(message);
  }

  if (dropped.length) {
    await logDiagnostic("Quote-to-Email queue full", "Oldest pending Quote-to-Email PDFs were dropped.", {
      handoffIds: dropped.map((item) => item.handoffId),
      fileNames: dropped.map((item) => item.filename)
    });

    for (const item of dropped) {
      if (Number.isInteger(item.sourceTabId) && item.sourceTabId !== sourceId) {
        await clearActionBadge(item.sourceTabId).catch(() => {});
      }
    }
  }

  // Store first, then activate and ping, so a ready from the tab always finds the entry.
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // Tab may have closed; the expiry and tab-close rules clean up the entry.
  }

  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Window focus is best effort.
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "QTE_PING" });
  } catch {
    // A fresh tab has no bridge yet; its post-login ready burst covers it.
  }

  await logDiagnostic("Quote-to-Email app opened", "PDF queued for the Quote-to-Email tab.", {
    appUrl: QTE_APP_URL,
    appTabId: tab.id,
    handoffId: entry.handoffId,
    fileName: filename,
    byteLength: base64ToByteLength(base64),
    expiresAt: entry.expiresAt
  });
}

function updateQtePendingPdfs(task) {
  const run = qtePendingPdfsQueue.then(async () => {
    const stored = await chrome.storage.session.get(QTE_PENDING_PDFS_KEY);
    const list = Array.isArray(stored[QTE_PENDING_PDFS_KEY]) ? stored[QTE_PENDING_PDFS_KEY] : [];
    const { next, result } = await task(list);

    if (next) {
      await chrome.storage.session.set({ [QTE_PENDING_PDFS_KEY]: next });

      if (next.length) {
        await chrome.alarms.create(QTE_PENDING_PDF_ALARM_NAME, {
          when: Math.min(...next.map((item) => item.expiresAtMs))
        });
      } else {
        await chrome.alarms.clear(QTE_PENDING_PDF_ALARM_NAME);
      }
    }

    return result;
  });

  qtePendingPdfsQueue = run.catch(() => {});
  return run;
}

async function findQteTargetTab(pending) {
  const now = Date.now();
  const newest = pending.findLast((item) => item.expiresAtMs > now);

  if (newest) {
    const tab = await chrome.tabs.get(newest.targetTabId).catch(() => null);

    if (isQteIntakeUrl(tab?.pendingUrl || tab?.url)) {
      return tab;
    }
  }

  const tabs = (await chrome.tabs.query({ url: QTE_DASHBOARD_URL_PATTERN }))
    .filter((tab) => !tab.discarded)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || Number(Boolean(b.active)) - Number(Boolean(a.active)));

  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "QTE_PROBE" });

      if (reply?.ok) {
        return tab;
      }
    } catch {
      // No live bridge (tab opened before this version, or still loading).
    }
  }

  return chrome.tabs.create({
    url: QTE_APP_URL,
    active: true
  });
}

// Login page (the dashboard follows after sign-in) or the dashboard itself, where the intake hook runs.
function isQteIntakeUrl(url = "") {
  try {
    const { origin, pathname } = new URL(url);

    return origin === QTE_APP_ORIGIN && (pathname === "/" || pathname.startsWith("/dashboard"));
  } catch {
    return false;
  }
}

async function handleQteReady(message, sender) {
  const tabId = sender?.tab?.id;
  const exclude = Array.isArray(message.exclude) ? message.exclude : [];
  const pending = await updateQtePendingPdfs((list) => {
    const now = Date.now();

    return {
      result: list.find((item) => (
        item.targetTabId === tabId && item.expiresAtMs > now && !exclude.includes(item.handoffId)
      )) || null
    };
  });

  return {
    ok: true,
    pending
  };
}

async function handleQtePendingPdfDelivered(message, sender) {
  const entry = await updateQtePendingPdfs((list) => {
    const match = list.find((item) => item.handoffId === message.handoffId);

    // Also drop other waiting copies of the same PDF for this tab (e.g. an earlier FAILED send);
    // the app would only ack them as duplicates, or load them again after a reload.
    return match
      ? {
        next: list.filter((item) => item !== match && !(item.targetTabId === match.targetTabId && item.base64 === match.base64)),
        result: match
      }
      : { result: null };
  });

  await logDiagnostic("Quote-to-Email PDF delivered", "Quote-to-Email dashboard accepted the PDF.", {
    handoffId: message.handoffId || "",
    filename: message.filename || "",
    appUrl: redactLongUrl(message.appUrl || sender?.tab?.url || ""),
    tabId: sender?.tab?.id || null
  });
  await setQteBadges([entry?.sourceTabId, sender?.tab?.id], "OK", "#0f766e", "PDF delivered to Quote-to-Email.");

  return {
    ok: true
  };
}

async function handleQtePendingPdfFailed(message, sender) {
  const entry = await updateQtePendingPdfs((list) => ({
    result: list.find((item) => item.handoffId === message.handoffId) || null
  }));

  await logDiagnostic("Quote-to-Email PDF not accepted", "Quote-to-Email dashboard did not acknowledge the PDF.", {
    handoffId: message.handoffId || "",
    filename: message.filename || "",
    tabId: sender?.tab?.id || null
  });
  await setQteBadges(
    [entry?.sourceTabId, sender?.tab?.id],
    "ERR",
    "#b42318",
    "PDF not accepted by Quote-to-Email. Reload the Quote-to-Email tab to retry.",
    { persist: true }
  );

  return {
    ok: true
  };
}

async function expireQtePendingPdf() {
  const expired = await updateQtePendingPdfs((list) => {
    const now = Date.now();

    return {
      next: list.filter((item) => item.expiresAtMs > now),
      result: list.filter((item) => !(item.expiresAtMs > now))
    };
  });

  for (const entry of expired) {
    await logDiagnostic("Quote-to-Email PDF timeout", "Pending Quote-to-Email PDF handoff timed out and was discarded.", {
      handoffId: entry.handoffId || "",
      filename: entry.filename || "",
      expiresAt: entry.expiresAt || ""
    });
    await setQteBadges(
      [entry.sourceTabId],
      "ERR",
      "#b42318",
      "PDF expired before Quote-to-Email accepted it. Send it again.",
      { persist: true }
    );
  }
}

async function handleQteTabRemoved(tabId) {
  const removed = await updateQtePendingPdfs((list) => {
    const kept = list.filter((item) => item.targetTabId !== tabId);

    return kept.length === list.length
      ? { result: [] }
      : { next: kept, result: list.filter((item) => item.targetTabId === tabId) };
  });

  for (const entry of removed) {
    await logDiagnostic("Quote-to-Email tab closed", "Quote-to-Email tab closed before the PDF was delivered.", {
      handoffId: entry.handoffId || "",
      filename: entry.filename || "",
      tabId
    });

    if (Number.isInteger(entry.sourceTabId)) {
      await clearActionBadge(entry.sourceTabId).catch(() => {});
    }
  }
}

async function setQteBadges(tabIds, text, color, title, options = {}) {
  // Integers only: setActionBadge with a non-integer tab id sets the global badge.
  for (const tabId of new Set(tabIds.filter(Number.isInteger))) {
    await setActionBadge(tabId, text, color, title, options).catch(() => {});
  }
}

function stripPdfDataUrlPrefix(base64 = "") {
  return `${base64}`.replace(/^data:application\/pdf(?:;[^,]*)?;base64,/i, "").replace(/\s+/g, "");
}

async function setActionBadge(tabId, text, color, title, options = {}) {
  const badgeOptions = Number.isInteger(tabId) ? { tabId, text } : { text };
  const colorOptions = Number.isInteger(tabId) ? { tabId, color } : { color };
  const titleOptions = Number.isInteger(tabId) ? { tabId, title } : { title };

  await chrome.action.setBadgeText(badgeOptions);
  await chrome.action.setBadgeBackgroundColor(colorOptions);
  await chrome.action.setTitle(titleOptions);

  if (!options.persist && text !== "..." && text !== "NET" && text !== "ARM") {
    setTimeout(() => {
      clearActionBadge(tabId).catch(() => {});
    }, BADGE_RESET_MS);
  }
}

async function clearActionBadge(tabId) {
  const badgeOptions = Number.isInteger(tabId) ? { tabId, text: "" } : { text: "" };
  const titleOptions = Number.isInteger(tabId)
    ? { tabId, title: "PDF Webhook Sender" }
    : { title: "PDF Webhook Sender" };

  await chrome.action.setBadgeText(badgeOptions);
  await chrome.action.setTitle(titleOptions);
}

async function showActionError(tabId, error) {
  const message = error?.message || "Could not print and send this page.";

  console.error(message);
  await setActionBadge(tabId, "ERR", "#b42318", message);
}

async function showPdfCaptureLoadingIndicator(tab) {
  if (!Number.isInteger(tab?.id)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: {
      tabId: tab.id
    },
    func: showPdfCaptureLoadingIndicatorInPage
  });
}

async function hidePdfCaptureLoadingIndicator(tab) {
  if (!Number.isInteger(tab?.id)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: {
      tabId: tab.id
    },
    func: hidePdfCaptureLoadingIndicatorInPage
  });
}

function showPdfCaptureLoadingIndicatorInPage() {
  const id = "gia-pdf-webhook-loading";
  document.getElementById(id)?.remove();

  const container = document.createElement("div");
  const spinner = document.createElement("div");
  const label = document.createElement("span");

  container.id = id;
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  Object.assign(container.style, {
    alignItems: "center",
    background: "rgba(15, 23, 42, 0.94)",
    borderRadius: "999px",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.22)",
    color: "#ffffff",
    display: "flex",
    font: "600 13px Arial, sans-serif",
    gap: "10px",
    padding: "10px 14px",
    pointerEvents: "none",
    position: "fixed",
    right: "18px",
    top: "18px",
    zIndex: "2147483647"
  });

  Object.assign(spinner.style, {
    border: "3px solid rgba(255,255,255,0.35)",
    borderTopColor: "#ffffff",
    borderRadius: "50%",
    boxSizing: "border-box",
    height: "18px",
    width: "18px"
  });
  spinner.animate?.([
    { transform: "rotate(0deg)" },
    { transform: "rotate(360deg)" }
  ], {
    duration: 800,
    iterations: Infinity
  });

  label.textContent = "Preparing PDF...";
  container.append(spinner, label);
  (document.body || document.documentElement).append(container);
}

function hidePdfCaptureLoadingIndicatorInPage() {
  document.getElementById("gia-pdf-webhook-loading")?.remove();
}

async function sendMultipart(webhookUrl, pagePdf) {
  const formData = new FormData();
  const blob = base64ToBlob(pagePdf.base64, "application/pdf");

  formData.append("pdf", blob, pagePdf.fileName);
  formData.append("metadata", JSON.stringify(pagePdf.metadata));
  formData.append("source", pagePdf.metadata.source);

  if (pagePdf.metadata.generatedAt) {
    formData.append("generatedAt", pagePdf.metadata.generatedAt);
  }

  if (pagePdf.metadata.uploadedAt) {
    formData.append("uploadedAt", pagePdf.metadata.uploadedAt);
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}.`);
  }
}

async function sendRawPdf(webhookUrl, pagePdf) {
  const headers = {
    "Content-Type": "application/pdf",
    "X-PDF-Filename": encodeURIComponent(pagePdf.fileName),
    "X-PDF-Source": pagePdf.metadata.source || "pdf-webhook-extension"
  };

  if (pagePdf.metadata.pageUrl) {
    headers["X-Page-URL"] = pagePdf.metadata.pageUrl;
  }

  if (pagePdf.metadata.uploadedAt) {
    headers["X-PDF-Uploaded-At"] = pagePdf.metadata.uploadedAt;
  }

  if (pagePdf.metadata.generatedAt) {
    headers["X-PDF-Generated-At"] = pagePdf.metadata.generatedAt;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: base64ToBlob(pagePdf.base64, "application/pdf")
  });

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}.`);
  }
}

async function sendJsonBase64(webhookUrl, pagePdf) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      event: pagePdf.metadata.source === "uploaded-pdf" ? "uploaded_pdf_send" : "page_pdf_send",
      fileName: pagePdf.fileName,
      contentType: "application/pdf",
      pdfBase64: pagePdf.base64,
      metadata: pagePdf.metadata,
      browser: {
        userAgent: navigator.userAgent
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}.`);
  }
}

async function syncRemoteConfig(options = {}) {
  const settings = await getStoredSettings();

  if (!settings.remoteConfigUrl) {
    return {
      ok: true,
      message: "No remote config URL set."
    };
  }

  try {
    const headers = {};

    if (settings.remoteAuthToken) {
      headers.Authorization = `Bearer ${settings.remoteAuthToken}`;
    }

    const response = await fetch(settings.remoteConfigUrl, {
      cache: "no-store",
      headers
    });

    if (!response.ok) {
      throw new Error(`Remote config returned HTTP ${response.status}.`);
    }

    const config = normalizeRemoteConfig(await response.json());

    await chrome.storage.sync.set({
      remoteConfig: config,
      remoteConfigSyncedAt: new Date().toISOString()
    });

    return {
      ok: true,
      message: "Remote config synced."
    };
  } catch (error) {
    if (options.silent) {
      return {
        ok: false,
        message: error.message
      };
    }

    throw error;
  }
}

function normalizeRemoteConfig(config) {
  if (!config || typeof config !== "object") {
    return {};
  }

  const normalized = {};

  if (typeof config.webhookUrl === "string") {
    normalized.webhookUrl = normalizeUrl(config.webhookUrl, "Remote webhook URL", true);
  }

  if (typeof config.sendMode === "string") {
    normalized.sendMode = normalizeSendMode(config.sendMode);
  }

  if (typeof config.deliveryMode === "string") {
    normalized.deliveryMode = normalizeDeliveryMode(config.deliveryMode);
  }

  if (typeof config.enabled === "boolean") {
    normalized.enabled = config.enabled;
  }

  return normalized;
}

function normalizeUrl(value, label, allowBlank = false) {
  const trimmed = typeof value === "string" ? value.trim() : "";

  if (!trimmed && allowBlank) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error();
    }

    return parsed.toString();
  } catch {
    throw new Error(`${label} must be a valid http or https URL.`);
  }
}

function normalizeSendMode(value) {
  if (value === "jsonBase64") {
    return "jsonBase64";
  }

  if (value === "rawPdf") {
    return "rawPdf";
  }

  return "multipart";
}

function normalizeDeliveryMode(value) {
  if (value === "webhook") {
    return "webhook";
  }

  if (value === "both") {
    return "both";
  }

  return "webApp";
}

function deliveryNeedsWebhook(settings) {
  const deliveryMode = normalizeDeliveryMode(settings.deliveryMode);

  return deliveryMode === "webhook" || deliveryMode === "both";
}

function isDeliveryConfigured(settings) {
  if (settings.enabled === false) {
    return false;
  }

  if (deliveryNeedsWebhook(settings)) {
    return Boolean(settings.webhookUrl);
  }

  return true;
}

function validateDeliverySettings(settings) {
  if (settings.enabled === false) {
    throw new Error("Sending is disabled by remote config.");
  }

  if (deliveryNeedsWebhook(settings) && !settings.webhookUrl) {
    throw new Error("Add a webhook URL in settings.");
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab) {
    throw new Error("No active tab found.");
  }

  return tab;
}

function getPrintableTabSupport(tab) {
  const url = tab?.url || "";

  if (!tab?.id) {
    return {
      isSupported: false,
      reason: "No active tab found."
    };
  }

  if (!url) {
    return {
      isSupported: false,
      reason: "This tab does not expose a printable URL."
    };
  }

  if (url === "about:blank") {
    return {
      isSupported: true,
      reason: ""
    };
  }

  if (/^(chrome|edge|chrome-extension):\/\//i.test(url) || /^about:/i.test(url)) {
    return {
      isSupported: false,
      reason: "Browser, extension, and settings pages cannot be printed by this extension."
    };
  }

  if (!/^(https?|file|data|blob):/i.test(url)) {
    return {
      isSupported: false,
      reason: "This page type cannot be printed by this extension."
    };
  }

  return {
    isSupported: true,
    reason: ""
  };
}

function getDisabledReason({ tabSupport, hasWebhook, settings }) {
  if (settings.enabled === false) {
    return "Sending is disabled by remote admin config.";
  }

  if (deliveryNeedsWebhook(settings) && !hasWebhook) {
    return "Add a webhook URL in settings before sending.";
  }

  if (!tabSupport.isSupported) {
    return tabSupport.reason;
  }

  return "";
}

function getUploadDisabledReason({ hasWebhook, settings }) {
  if (settings.enabled === false) {
    return "Sending is disabled by remote admin config.";
  }

  if (deliveryNeedsWebhook(settings) && !hasWebhook) {
    return "Add a webhook URL in settings before sending.";
  }

  return "";
}

function getSendSuccessMessage(sendMode, source) {
  const prefix = source === "page" ? "Page PDF" : "Original browser PDF";

  if (sendMode === "jsonBase64") {
    return `${prefix} sent to webhook as JSON.`;
  }

  if (sendMode === "rawPdf") {
    return `${prefix} sent to webhook as raw PDF.`;
  }

  return `${prefix} uploaded to webhook.`;
}

function getDeliverySuccessMessage(settings, result) {
  if (result.webAppOpened && result.webhookSent) {
    return "PDF handed to Quote-to-Email and sent to webhook.";
  }

  if (result.webAppOpened) {
    return "PDF handed to Quote-to-Email; waiting for the dashboard to accept it.";
  }

  if (result.webhookSent) {
    return getSendSuccessMessage(settings.sendMode, "browser");
  }

  return "PDF delivery completed.";
}

function isPdfNetworkResponse(response) {
  const headers = normalizeHeaderMap(response.headers || {});
  const contentType = `${headers["content-type"] || response.mimeType || ""}`;
  const contentDisposition = `${headers["content-disposition"] || ""}`;

  return isPdfHeaderValues(contentType, contentDisposition);
}

function isPdfHeaderValues(contentType = "", contentDisposition = "") {
  const normalizedContentType = `${contentType}`.toLowerCase();
  const normalizedContentDisposition = `${contentDisposition}`.toLowerCase();

  return normalizedContentType.includes("application/pdf")
    || normalizedContentDisposition.includes(".pdf")
    || normalizedContentDisposition.includes("application/pdf");
}

function urlLooksLikePdfFile(url = "") {
  try {
    const parsed = new URL(url);
    const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");

    return fileName.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function normalizeAegisQuotePdfUrl(rawUrl = "") {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);

    if (parsed.hostname !== "prod.aegisinsurance.com") {
      return "";
    }

    if (parsed.pathname !== "/GameChanger/PolicyFrame/Quote/QuotePrintPdf") {
      return "";
    }

    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeHeaderMap(headers) {
  const normalized = {};

  for (const [key, value] of Object.entries(headers || {})) {
    normalized[key.toLowerCase()] = value;
  }

  return normalized;
}

function normalizeHeaderArray(headers) {
  const normalized = {};

  for (const header of headers || []) {
    const name = `${header?.name || ""}`.toLowerCase();

    if (name) {
      normalized[name] = `${header.value ?? ""}`;
    }
  }

  return normalized;
}

function normalizeWebRequestHeaders(headers) {
  return normalizeHeaderArray(headers);
}

function getNetworkPdfFileName(request) {
  const headers = normalizeHeaderMap(request.headers || {});
  const contentDisposition = `${headers["content-disposition"] || ""}`;
  const headerMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);

  if (headerMatch?.[1]) {
    return sanitizeUploadedPdfFileName(decodeURIComponentSafe(headerMatch[1].replace(/"/g, "")));
  }

  return getBrowserPdfFileName(request.url, "document.pdf");
}

function getAegisQuotePdfFileName({ url, contentDisposition = "", title = "" }) {
  const headerMatch = `${contentDisposition}`.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);

  if (headerMatch?.[1]) {
    return sanitizeUploadedPdfFileName(decodeURIComponentSafe(headerMatch[1].replace(/"/g, "")));
  }

  try {
    const parsed = new URL(url);
    const workId = parsed.searchParams.get("workId") || "";

    if (workId) {
      return sanitizeUploadedPdfFileName(`quote-${workId}.pdf`);
    }
  } catch {
    // Fall through to a title-based name.
  }

  return sanitizeUploadedPdfFileName(`${title || "quote"}.pdf`);
}

function collectAegisQuoteIframeUrlsInPage() {
  const candidates = [];
  const seen = new Set();
  const quotePath = "/GameChanger/PolicyFrame/Quote/QuotePrintPdf";

  function normalize(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return "";
    }

    try {
      const parsed = new URL(rawUrl, location.href);

      if (parsed.hostname !== "prod.aegisinsurance.com" || parsed.pathname !== quotePath) {
        return "";
      }

      parsed.hash = "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  document.querySelectorAll("iframe#pdfQuoteIframe").forEach((iframe) => {
    const url = normalize(iframe.getAttribute("src") || iframe.src || "");

    if (!url || seen.has(url)) {
      return;
    }

    seen.add(url);
    candidates.push({
      url,
      frameUrl: location.href,
      title: document.title || "",
      source: "toolbar-click-scan",
      iframeId: iframe.id || ""
    });
  });

  return {
    candidates
  };
}

function clickAegisPrintQuoteButtonInPage() {
  const controls = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']"));
  const button = controls.find((element) => {
    const label = [
      element.id || "",
      element.name || "",
      element.value || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.innerText || element.textContent || ""
    ].join(" ");

    return /\bprint\s+quote\b/i.test(label);
  });

  if (!button || button.disabled === true || button.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(button.className?.toString() || "")) {
    return {
      ok: false,
      error: "Print Quote button was not available."
    };
  }

  setTimeout(() => button.click(), 0);

  return {
    ok: true
  };
}

function captureAltaPrintHtmlInPage(timeoutMs = 8000) {
  const originalOpen = window.open;
  let restored = false;

  function restore() {
    if (restored) {
      return;
    }

    restored = true;
    window.open = originalOpen;
  }

  function findDownloadPrintButton() {
    return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']"))
      .find((element) => {
        const label = [
          element.id || "",
          element.name || "",
          element.value || "",
          element.getAttribute("aria-label") || "",
          element.getAttribute("title") || "",
          element.innerText || element.textContent || ""
        ].join(" ");

        return /\bdownload\s*\/\s*print\b/i.test(label);
      });
  }

  function getTitleFromHtml(html) {
    return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getFileNameFromTitle(title) {
    const clean = String(title || "")
      .replace(/[_-]+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.pdf$/i, "");
    const productWords = clean
      .split(" ")
      .filter(Boolean)
      .slice(1)
      .filter((word) => !/^\d{6,}$/.test(word));

    return productWords.length ? `Farmers ${productWords.join(" ")}.pdf` : "Farmers Quote.pdf";
  }

  function getQuoteNumberFromHtml(html) {
    const text = String(html || "").replace(/<[^>]+>/g, " ");

    return text.match(/Quote\s+(?:number|#)\s*(\d+)/i)?.[1]
      || text.match(/\b(\d{12,})\b/)?.[1]
      || "";
  }

  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let timer = null;
    let settleTimer = null;

    function finish(result) {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      restore();
      resolve(result);
    }

    function succeedIfReady() {
      const html = chunks.join("");

      if (html.length < 100 || !/(?:<html\b|<body\b|app-new-create-estimate|estimate_page_view)/i.test(html)) {
        return false;
      }

      const title = getTitleFromHtml(html);

      finish({
        ok: true,
        html,
        title,
        fileName: getFileNameFromTitle(title),
        quoteNumber: getQuoteNumberFromHtml(html),
        sourceUrl: location.href
      });
      return true;
    }

    function scheduleSettle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (!succeedIfReady()) {
          finish({
            ok: false,
            error: "Alta Download/Print did not produce printable HTML."
          });
        }
      }, 50);
    }

    window.open = function patchedOpen(url) {
      const popupDocument = {
        open() {
          chunks.length = 0;
          return popupDocument;
        },
        write(value) {
          chunks.push(String(value || ""));
          scheduleSettle();
        },
        writeln(value) {
          chunks.push(String(value || ""), "\n");
          scheduleSettle();
        },
        close() {
          scheduleSettle();
        }
      };

      return {
        document: popupDocument,
        location: {
          href: url || ""
        },
        closed: false,
        focus() {},
        print() {},
        close() {
          this.closed = true;
        },
        addEventListener(type, handler) {
          if (type === "load" && typeof handler === "function") {
            setTimeout(() => handler.call(this, { type: "load" }), 0);
          }
        },
        removeEventListener() {}
      };
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: "Timed out waiting for Alta printable HTML."
      });
    }, timeoutMs);

    const button = findDownloadPrintButton();

    if (!button || button.disabled === true || button.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(button.className?.toString() || "")) {
      finish({
        ok: false,
        error: "Download/Print button was not available."
      });
      return;
    }

    try {
      button.click();
    } catch (error) {
      finish({
        ok: false,
        error: error.message || "Could not click Alta Download/Print."
      });
    }
  });
}

async function captureAltaQuotePdfInPage(printCapture = null) {
  const htmlToCanvas = window.html2canvas;
  const JsPdf = window.jspdf?.jsPDF;
  const printableHtml = typeof printCapture?.html === "string" && printCapture.html.trim().length > 100
    ? printCapture.html
    : "";
  const pageWidthPt = 612;
  const pageHeightPt = 792;
  const scale = 1.35;
  const imageType = "JPEG";
  const imageQuality = 0.95;

  if (!htmlToCanvas || !JsPdf) {
    return {
      ok: false,
      error: "Alta PDF renderer libraries were not available."
    };
  }

  let printRenderError = "";

  if (printableHtml) {
    const printResult = await renderAltaPrintableHtml(printCapture);

    if (printResult.ok) {
      return printResult;
    }

    printRenderError = printResult.error || "";
  }

  const preview = document.querySelector("#estimate_page_view2");

  if (!preview) {
    return {
      ok: false,
      error: printRenderError || "Alta visible preview was not found."
    };
  }

  const ready = await waitForAltaPreviewReady(preview);

  if (!ready.ok) {
    return ready;
  }

  const sourcePages = Array.from(preview.querySelectorAll(".a4-page"));
  const pages = sourcePages.length ? sourcePages : [preview];
  const quoteNumber = getAltaQuoteNumberFromText(preview.innerText || preview.textContent || "");
  const renderRoot = document.createElement("div");
  const renderedPages = [];

  renderRoot.id = "pdf-webhook-alta-render-root";
  Object.assign(renderRoot.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: "auto",
    height: "auto",
    overflow: "visible",
    pointerEvents: "none",
    background: "#fff",
    zIndex: "-2147483647"
  });
  document.body.append(renderRoot);

  try {
    for (const page of pages) {
      const size = measurePage(page);
      const wrapper = preview.cloneNode(false);
      const clone = page.cloneNode(true);

      Object.assign(wrapper.style, {
        transform: "none",
        zoom: "1",
        overflow: "visible",
        width: `${size.width}px`,
        height: `${size.height}px`,
        maxHeight: "none",
        background: "#fff"
      });
      Object.assign(clone.style, {
        transform: "none",
        zoom: "1",
        margin: "0",
        position: "relative",
        left: "0",
        top: "0",
        width: `${size.width}px`,
        minWidth: `${size.width}px`,
        maxWidth: "none",
        height: `${size.height}px`,
        minHeight: `${size.height}px`,
        maxHeight: "none",
        overflow: "visible",
        boxShadow: "none",
        background: "#fff"
      });

      wrapper.append(clone);
      renderRoot.replaceChildren(wrapper);
      await waitForAltaRenderAssets(clone);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const renderSize = measurePage(clone);
      const width = Math.max(size.width, renderSize.width);
      const height = Math.max(size.height, renderSize.height);

      Object.assign(wrapper.style, {
        width: `${width}px`,
        height: `${height}px`
      });
      Object.assign(clone.style, {
        width: `${width}px`,
        minWidth: `${width}px`,
        height: `${height}px`,
        minHeight: `${height}px`
      });

      const canvas = await htmlToCanvas(clone, {
        backgroundColor: "#ffffff",
        scale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        width,
        height,
        windowWidth: width,
        windowHeight: height,
        scrollX: 0,
        scrollY: 0
      });

      renderedPages.push({
        dataUrl: canvas.toDataURL("image/jpeg", imageQuality),
        width: canvas.width,
        height: canvas.height
      });
    }

    if (!renderedPages.length) {
      return {
        ok: false,
        error: "Alta visible preview did not contain any pages."
      };
    }

    const firstHeightPt = getPageHeightPt(renderedPages[0]);
    const pdf = new JsPdf({
      orientation: "portrait",
      unit: "pt",
      format: [pageWidthPt, firstHeightPt],
      compress: true
    });

    renderedPages.forEach((page, index) => {
      const pageHeightPt = getPageHeightPt(page);

      if (index > 0) {
        pdf.addPage([pageWidthPt, pageHeightPt], "portrait");
      }

      pdf.addImage(page.dataUrl, imageType, 0, 0, pageWidthPt, pageHeightPt, undefined, "FAST");
    });

    const base64 = stripDataUrlPrefix(pdf.output("datauristring"));

    return {
      ok: true,
      base64,
      byteLength: base64ByteLength(base64),
      pageCount: renderedPages.length,
      fileName: quoteNumber ? `Alta-${quoteNumber}-presentation.pdf` : "Alta-presentation.pdf",
      quoteNumber,
      sourceUrl: location.href,
      source: "alta-visible-preview",
      discoveredBy: "alta-preview-render",
      message: "Alta quote PDF rendered from the visible preview."
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Could not render Alta visible preview PDF."
    };
  } finally {
    renderRoot.remove();
  }

  async function renderAltaPrintableHtml(capture) {
    const frame = document.createElement("iframe");

    Object.assign(frame.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: "970px",
      height: "1400px",
      border: "0",
      overflow: "visible",
      pointerEvents: "none",
      background: "#fff",
      zIndex: "-2147483647"
    });
    document.body.append(frame);

    try {
      await waitForAltaFrameLoad(frame, normalizeAltaPrintableHtml(capture.html));

      const frameDocument = frame.contentDocument;
      const root = frameDocument?.querySelector("#estimate_page_view")
        || frameDocument?.querySelector("app-new-create-estimate")
        || frameDocument?.body;

      if (!root) {
        return {
          ok: false,
          error: "Alta printable HTML did not contain a renderable document."
        };
      }

      await waitForAltaRenderAssets(root);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const size = measurePage(root);
      const width = Math.max(1, size.width);
      const height = Math.max(1, size.height);

      Object.assign(frame.style, {
        width: `${width}px`,
        height: `${height}px`
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const canvas = await htmlToCanvas(root, {
        backgroundColor: "#ffffff",
        scale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        width,
        height,
        windowWidth: width,
        windowHeight: height,
        scrollX: 0,
        scrollY: 0
      });
      const renderedPages = splitCanvasIntoLetterPages(canvas);

      if (!renderedPages.length) {
        return {
          ok: false,
          error: "Alta printable HTML did not render any pages."
        };
      }

      const pdf = new JsPdf({
        orientation: "portrait",
        unit: "pt",
        format: [pageWidthPt, pageHeightPt],
        compress: true
      });

      renderedPages.forEach((page, index) => {
        if (index > 0) {
          pdf.addPage([pageWidthPt, pageHeightPt], "portrait");
        }

        pdf.addImage(page.dataUrl, imageType, 0, 0, pageWidthPt, Math.min(pageHeightPt, getPageHeightPt(page)), undefined, "FAST");
      });

      const base64 = stripDataUrlPrefix(pdf.output("datauristring"));
      const quoteNumber = capture.quoteNumber || getAltaQuoteNumberFromText(root.innerText || root.textContent || capture.html || "");

      return {
        ok: true,
        base64,
        byteLength: base64ByteLength(base64),
        pageCount: renderedPages.length,
        fileName: capture.fileName || getAltaPrintableFileName(capture.title) || "Alta-presentation.pdf",
        quoteNumber,
        sourceUrl: capture.sourceUrl || location.href,
        source: "alta-print-html",
        discoveredBy: "alta-print-html",
        message: "Alta quote PDF rendered from Alta Download/Print HTML."
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || "Could not render Alta printable HTML PDF."
      };
    } finally {
      frame.remove();
    }
  }

  function normalizeAltaPrintableHtml(html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");

    parsed.querySelectorAll("script").forEach((script) => script.remove());

    const base = parsed.querySelector("base") || parsed.createElement("base");
    base.setAttribute("href", new URL(base.getAttribute("href") || "/quote/", location.origin).href);

    if (!base.parentElement) {
      (parsed.head || parsed.documentElement).prepend(base);
    }

    return `<!doctype html>${parsed.documentElement.outerHTML}`;
  }

  function splitCanvasIntoLetterPages(canvas) {
    const pageHeight = Math.max(1, Math.round(canvas.width * 11 / 8.5));
    const pages = [];

    for (let offset = 0; offset < canvas.height; offset += pageHeight) {
      const sliceHeight = Math.min(pageHeight, canvas.height - offset);
      const pageCanvas = document.createElement("canvas");
      const context = pageCanvas.getContext("2d");

      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;
      context.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
      pages.push({
        dataUrl: pageCanvas.toDataURL("image/jpeg", imageQuality),
        width: pageCanvas.width,
        height: pageCanvas.height
      });
    }

    return pages;
  }

  function getAltaPrintableFileName(title) {
    const clean = String(title || "")
      .replace(/[_-]+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.pdf$/i, "");
    const productWords = clean
      .split(" ")
      .filter(Boolean)
      .slice(1)
      .filter((word) => !/^\d{6,}$/.test(word));

    return productWords.length ? `Farmers ${productWords.join(" ")}.pdf` : "";
  }

  function getAltaQuoteNumberFromText(text) {
    return String(text || "").match(/Quote\s+(?:number|#)\s*(\d+)/i)?.[1]
      || String(text || "").match(/\b(\d{12,})\b/)?.[1]
      || "";
  }

  async function waitForAltaFrameLoad(frame, html) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }

        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 600);

      frame.addEventListener("load", finish, { once: true });
      frame.srcdoc = html;
    });
  }

  function measurePage(page) {
    const rect = page.getBoundingClientRect();
    const styleRoot = page.ownerDocument?.defaultView || window;
    const styles = styleRoot.getComputedStyle ? styleRoot.getComputedStyle(page) : getComputedStyle(page);
    const width = Math.max(
      1,
      Math.round(page.scrollWidth || 0),
      Math.round(page.offsetWidth || 0),
      Math.round(parseFloat(styles.width) || 0),
      Math.round(rect.width || 0),
      794
    );
    const height = Math.max(
      1,
      Math.round(page.scrollHeight || 0),
      Math.round(page.offsetHeight || 0),
      Math.round(parseFloat(styles.height) || 0),
      Math.round(parseFloat(styles.minHeight) || 0),
      Math.round(rect.height || 0),
      1123
    );

    return {
      width,
      height
    };
  }

  async function waitForAltaPreviewReady(element, timeoutMs = 15000) {
    const startedAt = Date.now();
    let previous = "";
    let stableCount = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const currentPages = Array.from(element.querySelectorAll(".a4-page"));
      const measuredPages = currentPages.length ? currentPages : [element];
      const pageSizes = measuredPages.map(measurePage);
      const busyCount = document.querySelectorAll?.("mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, [aria-busy='true']").length || 0;
      const pendingImages = Array.from(element.querySelectorAll?.("img") || []).filter((image) => !image.complete).length;
      const textLength = (element.innerText || element.textContent || "").trim().length;
      const totalHeight = pageSizes.reduce((sum, size) => sum + size.height, 0);
      const signature = JSON.stringify({
        count: measuredPages.length,
        sizes: pageSizes,
        textLength,
        pendingImages,
        busyCount
      });

      if (signature === previous) {
        stableCount += 1;
      } else {
        stableCount = 0;
        previous = signature;
      }

      if (stableCount >= 2 && busyCount === 0 && pendingImages === 0 && textLength > 100 && totalHeight > measuredPages.length * 700) {
        return {
          ok: true
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return {
      ok: false,
      error: "Alta visible preview did not finish rendering."
    };
  }

  async function waitForAltaRenderAssets(element) {
    const ownerDocument = element.ownerDocument || document;

    if (ownerDocument.fonts?.ready) {
      await Promise.race([
        ownerDocument.fonts.ready.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 400))
      ]);
    }

    const images = Array.from(element.querySelectorAll?.("img") || []).filter((image) => !image.complete);

    if (images.length) {
      await Promise.race([
        Promise.all(images.map((image) => new Promise((resolve) => {
          if (!image.addEventListener) {
            resolve();
            return;
          }

          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        }))),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    }
  }

  function getPageHeightPt(page) {
    return Math.max(1, Math.round(pageWidthPt * page.height / Math.max(1, page.width)));
  }

  function stripDataUrlPrefix(value) {
    return String(value || "").replace(/^data:application\/pdf(?:;[^,]*)?,/i, "");
  }

  function base64ByteLength(base64) {
    const clean = base64.replace(/\s+/g, "");
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;

    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
}

function captureBambooQuotePdfInPage(timeoutMs = 20000) {
  const pdfEndpointPattern = /\/generate-document-ext\b.*(?:\?|&)docType=SubmissionQuote\b/i;
  const globalRoot = typeof globalThis !== "undefined" ? globalThis : null;
  const root = (typeof window !== "undefined" && window)
    || globalRoot
    || (typeof self !== "undefined" && self)
    || {};
  const fetchOwner = root.fetch
    ? root
    : globalRoot?.fetch
      ? globalRoot
      : null;
  const originalFetch = fetchOwner?.fetch || null;
  const originalXhrOpen = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.open : null;
  const originalXhrSend = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.send : null;
  const originalAnchorClick = typeof HTMLAnchorElement !== "undefined"
    ? HTMLAnchorElement.prototype.click
    : null;
  let restored = false;

  function restore() {
    if (restored) {
      return;
    }

    restored = true;

    if (originalFetch) {
      fetchOwner.fetch = originalFetch;
    }

    if (originalXhrOpen && originalXhrSend) {
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
    }

    if (originalAnchorClick) {
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
  }

  function getRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }

    return input?.url || "";
  }

  function getQuoteNumber() {
    const match = (document.body?.innerText || "").match(/\bQ\d{6,}\b/i);
    return match?.[0] || "";
  }

  function normalizePdfJson(payload, sourceUrl = "") {
    const base64 = `${payload?.contents || ""}`.replace(/\s+/g, "");
    const mimeType = `${payload?.responseMimeType || ""}`.toLowerCase();

    if (!base64.startsWith("JVBER") || !mimeType.includes("application/pdf")) {
      return null;
    }

    const quoteNumber = getQuoteNumber();

    return {
      ok: true,
      base64,
      byteLength: Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0),
      fileName: quoteNumber ? `Quote - ${quoteNumber}.pdf` : "Bamboo-quote.pdf",
      sourceUrl
    };
  }

  function findPrintQuoteButton() {
    return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']"))
      .find((element) => {
        const label = [
          element.id || "",
          element.name || "",
          element.value || "",
          element.getAttribute("aria-label") || "",
          element.getAttribute("title") || "",
          element.innerText || element.textContent || ""
        ].join(" ");

        return /\bprint\s+quote\s+summary\b/i.test(label);
      });
  }

  return new Promise((resolve) => {
    let done = false;

    function finish(result) {
      if (done) {
        return;
      }

      done = true;
      setTimeout(() => {
        restore();
        resolve(result);
      }, result?.ok ? 800 : 0);
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: "Timed out waiting for Bamboo quote PDF response."
      });
    }, timeoutMs);

    function succeed(result) {
      clearTimeout(timer);
      finish(result);
    }

    if (!originalFetch && (!originalXhrOpen || !originalXhrSend)) {
      finish({
        ok: false,
        error: "Bamboo page request APIs were not available."
      });
      return;
    }

    if (originalFetch) {
      fetchOwner.fetch = async function patchedFetch(input, init) {
        const response = await originalFetch.apply(this, arguments);
        const url = getRequestUrl(input);

        if (pdfEndpointPattern.test(url)) {
          try {
            const result = normalizePdfJson(await response.clone().json(), response.url || url);

            if (result) {
              succeed(result);
            }
          } catch {
            // Let Bamboo keep its normal response handling.
          }
        }

        return response;
      };
    }

    if (originalXhrOpen && originalXhrSend) {
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__pdfWebhookBambooUrl = getRequestUrl(url);
        return originalXhrOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function patchedSend() {
        const requestUrl = this.__pdfWebhookBambooUrl || "";

        if (pdfEndpointPattern.test(requestUrl)) {
          this.addEventListener("load", () => {
            try {
              const payload = this.responseType === "json"
                ? this.response
                : JSON.parse(typeof this.response === "string" ? this.response : this.responseText || "{}");
              const result = normalizePdfJson(payload, this.responseURL || requestUrl);

              if (result) {
                succeed(result);
              }
            } catch {
              // Let Bamboo keep its normal response handling.
            }
          });
        }

        return originalXhrSend.apply(this, arguments);
      };
    }

    if (originalAnchorClick) {
      HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
        const href = `${this.href || ""}`;

        if (this.download || /^blob:|^data:application\/pdf/i.test(href)) {
          return;
        }

        return originalAnchorClick.apply(this, arguments);
      };
    }

    const button = findPrintQuoteButton();

    if (!button || button.disabled === true || button.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(button.className?.toString() || "")) {
      finish({
        ok: false,
        error: "Print Quote Summary button was not available."
      });
      return;
    }

    setTimeout(() => button.click(), 0);
  });
}

async function readAegisQuotePdfInPage(url) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include"
    });
    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";
    const normalizedContentType = contentType.toLowerCase();
    const normalizedContentDisposition = contentDisposition.toLowerCase();
    const hasPdfSignal = normalizedContentType.includes("application/pdf")
      || normalizedContentDisposition.includes(".pdf")
      || normalizedContentDisposition.includes("application/pdf");

    if (!response.ok) {
      return {
        ok: false,
        error: `Aegis page-context fetch returned HTTP ${response.status}.`,
        statusCode: response.status,
        contentType,
        contentDisposition
      };
    }

    if (!hasPdfSignal) {
      return {
        ok: false,
        error: "Aegis page-context response was not clearly identified as a PDF.",
        statusCode: response.status,
        contentType,
        contentDisposition
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      return {
        ok: false,
        error: "Aegis page-context response did not contain valid PDF bytes.",
        statusCode: response.status,
        contentType,
        contentDisposition
      };
    }

    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return {
      ok: true,
      base64: btoa(binary),
      byteLength: bytes.byteLength,
      finalUrl: response.url || url,
      statusCode: response.status,
      contentType,
      contentDisposition
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Aegis page-context fetch failed."
    };
  }
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectPdfCandidatesInPage() {
  const candidates = [];
  const seen = new Set();
  const pdfHintPattern = /\.pdf($|[?#])|\/pdf\/|format=pdf|contenttype=application\/pdf/i;

  function add(rawUrl, source, details = {}) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return;
    }

    const trimmed = rawUrl.trim();

    if (!trimmed || trimmed.startsWith("javascript:")) {
      return;
    }

    let resolved = trimmed;

    try {
      resolved = new URL(trimmed, document.baseURI).href;
    } catch {
      return;
    }

    const isPdfLike = resolved.startsWith("blob:")
      || resolved.startsWith("data:application/pdf")
      || pdfHintPattern.test(decodeURIComponentSafe(resolved));

    if (!isPdfLike || seen.has(resolved)) {
      return;
    }

    seen.add(resolved);
    candidates.push({
      url: resolved,
      source,
      ...details
    });
  }

  function decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function getVisibilityDetails(element) {
    const emptyDetails = {
      tagName: element?.tagName?.toLowerCase() || "",
      visible: false,
      inViewport: false,
      visibleArea: 0
    };

    if (!element?.getClientRects || !element?.ownerDocument?.defaultView) {
      return emptyDetails;
    }

    const view = element.ownerDocument.defaultView;
    const style = view.getComputedStyle(element);

    if (element.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
      return emptyDetails;
    }

    const viewportWidth = view.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = view.innerHeight || document.documentElement.clientHeight || 0;
    let visibleArea = 0;
    let inViewport = false;

    Array.from(element.getClientRects()).forEach((rect) => {
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);

      if (!area) {
        return;
      }

      visibleArea += area;

      const overlapWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const overlapHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));

      if (overlapWidth * overlapHeight > 0) {
        inViewport = true;
      }
    });

    return {
      tagName: emptyDetails.tagName,
      visible: visibleArea > 0,
      inViewport,
      visibleArea
    };
  }

  function collectFromRoot(root, label) {
    if (!root?.querySelectorAll) {
      return;
    }

    root.querySelectorAll("embed[src], iframe[src], object[data], a[href], source[src]").forEach((element) => {
      const details = getVisibilityDetails(element);

      add(element.getAttribute("src"), `${label}:src`, details);
      add(element.getAttribute("href"), `${label}:href`, details);
      add(element.getAttribute("data"), `${label}:data`, details);
    });

    root.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) {
        collectFromRoot(element.shadowRoot, `${label}:shadow`);
      }
    });
  }

  let isTopFrame = false;

  try {
    isTopFrame = window.top === window;
  } catch {
    isTopFrame = false;
  }

  add(location.href, isTopFrame ? "location" : "frame-location", {
    tagName: "document",
    visible: isTopFrame,
    inViewport: isTopFrame,
    visibleArea: isTopFrame ? Number.MAX_SAFE_INTEGER : 0
  });
  collectFromRoot(document, "dom");

  try {
    performance.getEntriesByType("resource").forEach((entry) => {
      add(entry.name, "performance-resource", {
        tagName: "resource",
        visible: false,
        inViewport: false,
        visibleArea: 0
      });
    });
  } catch {
    // Performance entries are best-effort only.
  }

  return {
    title: document.title || "",
    candidates
  };
}

function installDownloadCapture(ttlMs) {
  const stateKey = "__pdfWebhookDownloadCapture";
  const existing = window[stateKey];

  if (existing?.cleanup) {
    existing.cleanup();
  }

  const state = {
    captured: false,
    expiresAt: Date.now() + ttlMs,
    seen: new Set(),
    timers: []
  };

  function isExpired() {
    return Date.now() > state.expiresAt;
  }

  function cleanup() {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("submit", onSubmit, true);
    state.timers.forEach((timer) => clearTimeout(timer));
  }

  function schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    state.timers.push(timer);
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function isPdfLike(url) {
    const decoded = safeDecode(url || "").toLowerCase();

    return decoded.startsWith("blob:")
      || decoded.startsWith("data:application/pdf")
      || decoded.includes(".pdf")
      || decoded.includes("/pdf/")
      || decoded.includes("format=pdf")
      || decoded.includes("contenttype=application/pdf");
  }

  function resolveUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return "";
    }

    try {
      return new URL(rawUrl, document.baseURI).href;
    } catch {
      return "";
    }
  }

  function addCandidate(rawUrl, source) {
    const url = resolveUrl(rawUrl);

    if (!url || state.seen.has(url) || !isPdfLike(url)) {
      return;
    }

    state.seen.add(url);
    handleCandidate({ url, source });
  }

  function collectCandidatesFromElement(element, source) {
    if (!element?.getAttribute) {
      return;
    }

    ["href", "src", "data", "action"].forEach((attribute) => {
      addCandidate(element.getAttribute(attribute), `${source}:${attribute}`);
    });

    if (element.dataset) {
      Object.values(element.dataset).forEach((value) => addCandidate(value, `${source}:data-attr`));
    }
  }

  function scanDocument(source) {
    if (isExpired() || state.captured) {
      cleanup();
      return;
    }

    addCandidate(location.href, `${source}:location`);

    document.querySelectorAll("a[href], embed[src], iframe[src], object[data], source[src], form[action]").forEach((element) => {
      collectCandidatesFromElement(element, source);
    });

    try {
      performance.getEntriesByType("resource").forEach((entry) => {
        addCandidate(entry.name, `${source}:performance`);
      });
    } catch {
      // Performance entries are optional.
    }
  }

  async function handleCandidate(candidate) {
    if (state.captured || isExpired()) {
      cleanup();
      return;
    }

    if (candidate.url.startsWith("blob:") || candidate.url.startsWith("data:application/pdf")) {
      const file = await readPdfUrl(candidate.url, candidate.source);

      if (file) {
        state.captured = true;
        cleanup();
        await chrome.runtime.sendMessage({
          type: "CAPTURED_PDF_FROM_PAGE",
          file
        });
      }

      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "PDF_CANDIDATE_FROM_PAGE",
      candidate
    }).catch(() => {});

    if (response?.ok) {
      state.captured = true;
      cleanup();
    }
  }

  async function readPdfUrl(url, source) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
        return null;
      }

      let binary = "";
      const chunkSize = 0x8000;

      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
      }

      return {
        base64: btoa(binary),
        fileName: getFileNameFromUrl(url),
        fileSize: bytes.byteLength,
        sourceUrl: url,
        discoveredBy: source || "download-capture"
      };
    } catch {
      return null;
    }
  }

  function getFileNameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");

      if (fileName.toLowerCase().endsWith(".pdf")) {
        return fileName;
      }
    } catch {
      // Blob URLs generally do not expose a filename.
    }

    return `${(document.title || "document").replace(/[\\/:*?"<>|]+/g, "-").trim() || "document"}.pdf`;
  }

  function inspectEvent(event, source) {
    if (isExpired() || state.captured) {
      cleanup();
      return;
    }

    const path = event.composedPath ? event.composedPath() : [];

    path.forEach((target) => collectCandidatesFromElement(target, source));
    scanDocument(source);
    schedule(() => scanDocument(`${source}:after-250ms`), 250);
    schedule(() => scanDocument(`${source}:after-1000ms`), 1000);
    schedule(() => scanDocument(`${source}:after-3000ms`), 3000);
  }

  function onClick(event) {
    inspectEvent(event, "click");
  }

  function onSubmit(event) {
    inspectEvent(event, "submit");
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  schedule(cleanup, ttlMs);
  scanDocument("armed");

  window[stateKey] = {
    cleanup
  };

  return true;
}

async function readBlobPdfInPage(blobUrl) {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const header = String.fromCharCode(...bytes.slice(0, 5));

  if (header !== "%PDF-") {
    return null;
  }

  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return {
    base64: btoa(binary),
    fileSize: bytes.byteLength
  };
}

function getPdfFileName(tab) {
  const title = sanitizeFileName(tab.title || "");

  if (title) {
    return `${title}.pdf`;
  }

  try {
    const parsed = new URL(tab.url);
    const host = sanitizeFileName(parsed.hostname || "page");
    const date = new Date().toISOString().slice(0, 10);

    return `${host}-${date}.pdf`;
  } catch {
    return "page.pdf";
  }
}

function sanitizeFileName(fileName) {
  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function normalizeUploadedPdf(file) {
  const fileName = sanitizeUploadedPdfFileName(file.fileName || "document.pdf");
  const fileSize = Number.isFinite(Number(file.fileSize)) ? Number(file.fileSize) : 0;
  const base64 = typeof file.base64 === "string" ? file.base64.trim() : "";
  const contentType = typeof file.contentType === "string" && file.contentType
    ? file.contentType
    : "application/pdf";

  if (!base64) {
    throw new Error("The selected PDF file was empty or could not be read.");
  }

  if (!isPdfBase64(base64)) {
    throw new Error("The selected file does not look like a valid PDF.");
  }

  if (!fileName.toLowerCase().endsWith(".pdf") && contentType !== "application/pdf") {
    throw new Error("Select a PDF file.");
  }

  return {
    base64,
    fileName,
    metadata: {
      fileName,
      fileSize,
      contentType: "application/pdf",
      source: "uploaded-pdf",
      uploadedAt: new Date().toISOString()
    }
  };
}

function normalizeCapturedBrowserPdf(file) {
  const fileName = sanitizeUploadedPdfFileName(file.fileName || "document.pdf");
  const fileSize = Number.isFinite(Number(file.fileSize)) ? Number(file.fileSize) : base64ToByteLength(file.base64 || "");
  const base64 = typeof file.base64 === "string" ? file.base64.trim() : "";

  if (!base64) {
    throw new Error("The captured PDF file was empty or could not be read.");
  }

  if (!isPdfBase64(base64)) {
    throw new Error("The captured file does not look like a valid PDF.");
  }

  return {
    base64,
    fileName,
    metadata: {
      fileName,
      fileSize,
      contentType: "application/pdf",
      source: "browser-pdf",
      sourceUrl: file.sourceUrl || "",
      discoveredBy: file.discoveredBy || "download-capture",
      foundAt: new Date().toISOString()
    }
  };
}

function sanitizeUploadedPdfFileName(fileName) {
  const cleaned = `${fileName || ""}`
    .split(/[\\/]/)
    .pop()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  if (!cleaned) {
    return "document.pdf";
  }

  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function isPdfBase64(base64) {
  return base64.replace(/\s+/g, "").startsWith("JVBER");
}

function isProtectedBrowserUrl(url = "") {
  return /^(chrome|edge|chrome-extension):\/\//i.test(url);
}

function isPolicyCenterUrl(url = "") {
  try {
    const parsed = new URL(url);

    return POLICYCENTER_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isAegisUrl(url = "") {
  try {
    const parsed = new URL(url);

    return parsed.hostname === "prod.aegisinsurance.com";
  } catch {
    return false;
  }
}

function isBambooUrl(url = "") {
  try {
    const parsed = new URL(url);

    return parsed.hostname === "agent-access.bambooinsurance.com";
  } catch {
    return false;
  }
}

function isWatchedNetworkTab(state, tabId) {
  return Number.isInteger(tabId)
    && (state?.tabId === tabId || (state?.attachedTabIds || []).includes(tabId));
}

function normalizeTabIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();

  for (const item of raw.flat ? raw.flat() : raw) {
    if (item === null || item === undefined || item === "") {
      continue;
    }

    const id = Number(item);

    if (Number.isInteger(id) && id >= 0 && !seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }

  return ids;
}

function getTabPdfCacheId(tabId) {
  return `${TAB_PDF_CACHE_ID_PREFIX}${tabId}`;
}

function getNetworkCapturePdfTabIds(state, responseTabId) {
  return normalizeTabIds([
    state?.tabId,
    responseTabId,
    ...(state?.attachedTabIds || [])
  ]);
}

function isGwpcPolicyCenterTab(url = "") {
  return isPolicyCenterUrl(url);
}

function redactLongUrl(url = "") {
  if (url.length <= 240) {
    return url;
  }

  return `${url.slice(0, 220)}...`;
}

function isPdfBytes(bytes) {
  if (!bytes || bytes.length < 5) {
    return false;
  }

  return bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  return uint8ArrayToBase64(bytes);
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function concatUint8Arrays(parts, totalLength) {
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToByteLength(base64) {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function getBrowserPdfFileName(url, title = "") {
  const titleName = sanitizeUploadedPdfFileName(title || "document.pdf");

  try {
    const parsed = new URL(url);
    const viewerSource = parsed.searchParams.get("src") || "";

    if (viewerSource) {
      const sourceFileName = getBrowserPdfFileName(viewerSource, "");

      if (sourceFileName !== "document.pdf") {
        return sourceFileName;
      }
    }

    const pathName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");

    if (pathName && pathName.toLowerCase().endsWith(".pdf")) {
      return sanitizeUploadedPdfFileName(pathName);
    }
  } catch {
    // Blob and data URLs usually do not carry a useful filename.
  }

  return titleName;
}

function openPdfCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PDF_CACHE_DB_NAME, PDF_CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PDF_CACHE_STORE_NAME)) {
        db.createObjectStore(PDF_CACHE_STORE_NAME, {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open PDF cache."));
  });
}

function idbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function idbTransactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

function getSessionStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function getActiveDownloadCaptureSession(sender) {
  const tabId = sender?.tab?.id;

  if (!Number.isInteger(tabId)) {
    return null;
  }

  const storage = getSessionStorage();
  const stored = await storage.get(DOWNLOAD_CAPTURE_KEY);
  const session = stored[DOWNLOAD_CAPTURE_KEY];

  if (!session || session.tabId !== tabId || Date.now() > session.expiresAt) {
    await clearDownloadCaptureSession();
    return null;
  }

  return session;
}

async function clearDownloadCaptureSession() {
  await getSessionStorage().remove(DOWNLOAD_CAPTURE_KEY);
}

function base64ToBlob(base64, contentType) {
  const binary = atob(base64);
  const chunks = [];

  for (let offset = 0; offset < binary.length; offset += 1024) {
    const slice = binary.slice(offset, offset + 1024);
    const bytes = new Uint8Array(slice.length);

    for (let index = 0; index < slice.length; index += 1) {
      bytes[index] = slice.charCodeAt(index);
    }

    chunks.push(bytes);
  }

  return new Blob(chunks, { type: contentType });
}

function serializeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || ""
  };
}
