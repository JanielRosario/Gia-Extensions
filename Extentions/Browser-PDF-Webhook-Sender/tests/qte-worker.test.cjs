const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "service-worker.js"), "utf8");

function extractFunction(name) {
  let start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Missing ${name}`);

  if (source.slice(Math.max(0, start - 6), start) === "async ") {
    start -= 6;
  }

  const bodyStart = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not extract ${name}`);
}

const APP_ORIGIN = "https://quote-to-email.giatools.com";
const DASHBOARD_URL = `${APP_ORIGIN}/dashboard`;
const PENDING_KEY = "qtePendingPdfs";
const PDF_BASE64 = "JVBERi0xLjQK".repeat(20);
const QTE_FUNCTIONS = [
  "updateQtePendingPdfs",
  "findQteTargetTab",
  "isQteIntakeUrl",
  "sendPdfToQuoteToEmailApp",
  "handleQteReady",
  "handleQtePendingPdfDelivered",
  "handleQtePendingPdfFailed",
  "expireQtePendingPdf",
  "handleQteTabRemoved",
  "setQteBadges",
  "handleActionClick"
];
const qteConstants = source.match(/^const QTE_[A-Z_]+ = .+;$/gm) || [];
const qteQueue = source.match(/^let qtePendingPdfsQueue = .+;$/m);

assert.ok(qteConstants.some((line) => line.includes(`"${PENDING_KEY}"`)), "Missing QTE_PENDING_PDFS_KEY");
assert.ok(qteConstants.some((line) => line.includes("15 * 60 * 1000")), "Timeout must be 15 minutes");
assert.ok(qteQueue, "Missing qtePendingPdfsQueue");

function createHarness() {
  const calls = [];
  const state = {
    store: {},
    failSet: false,
    tabs: new Map(),
    bridges: new Set(),
    nextTabId: 500
  };
  const chrome = {
    storage: {
      session: {
        async get(key) {
          calls.push("storage.get");
          return key in state.store ? { [key]: structuredClone(state.store[key]) } : {};
        },
        async set(items) {
          if (state.failSet) {
            calls.push("storage.set:quota");
            throw new Error("Session storage quota bytes exceeded. Values were not stored.");
          }

          calls.push("storage.set");
          Object.assign(state.store, structuredClone(items));
        }
      }
    },
    alarms: {
      async create(name, info) {
        calls.push(`alarms.create:${info.when}`);
      },
      async clear() {
        calls.push("alarms.clear");
      }
    },
    tabs: {
      async get(id) {
        if (!state.tabs.has(id)) {
          throw new Error(`No tab with id: ${id}.`);
        }

        return state.tabs.get(id);
      },
      async query({ url }) {
        calls.push(`tabs.query:${url}`);
        const prefix = url.replace(/\*$/, "");
        return [...state.tabs.values()].filter((tab) => (tab.url || "").startsWith(prefix));
      },
      async create({ url }) {
        const tab = { id: state.nextTabId, windowId: 9, pendingUrl: url, url: "" };

        state.nextTabId += 1;
        state.tabs.set(tab.id, tab);
        calls.push(`tabs.create:${tab.id}`);
        return tab;
      },
      async update(id) {
        calls.push(`tabs.update:${id}`);
      },
      async sendMessage(id, message) {
        calls.push(`sendMessage:${id}:${message.type}`);

        if (!state.bridges.has(id)) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }

        return { ok: true };
      }
    },
    windows: {
      async update(id) {
        calls.push(`windows.update:${id}`);
      }
    }
  };
  const sandbox = {
    chrome,
    URL,
    crypto: webcrypto,
    console,
    isPdfBase64: (base64) => base64.startsWith("JVBER"),
    sanitizeUploadedPdfFileName: (fileName) => fileName,
    stripPdfDataUrlPrefix: (base64) => base64,
    base64ToByteLength: (base64) => base64.length,
    redactLongUrl: (url) => url,
    logDiagnostic: async (step) => {
      calls.push(`log:${step}`);
    },
    setActionBadge: async (tabId, text, color, title, options = {}) => {
      calls.push(`badge:${tabId}:${text}${options.persist ? ":persist" : ""}`);
    },
    clearActionBadge: async (tabId) => {
      calls.push(`clearBadge:${tabId}`);
    }
  };

  vm.createContext(sandbox);
  vm.runInContext([
    ...qteConstants,
    qteQueue[0],
    ...QTE_FUNCTIONS.map(extractFunction),
    ...QTE_FUNCTIONS.map((name) => `globalThis.${name} = ${name};`)
  ].join("\n"), sandbox);

  return {
    sandbox,
    calls,
    state,
    addTab(tab, hasBridge = false) {
      state.tabs.set(tab.id, { windowId: 3, ...tab });

      if (hasBridge) {
        state.bridges.add(tab.id);
      }
    },
    setPending(entries) {
      state.store[PENDING_KEY] = structuredClone(entries);
    },
    pending() {
      return state.store[PENDING_KEY] || [];
    },
    send(sourceTabId) {
      return sandbox.sendPdfToQuoteToEmailApp({ base64: PDF_BASE64, fileName: "quote.pdf", metadata: {} }, sourceTabId);
    }
  };
}

function makeEntry(handoffId, targetTabId, sourceTabId, expiresInMs = 60000) {
  return {
    handoffId,
    targetTabId,
    sourceTabId,
    filename: `${handoffId}.pdf`,
    base64: `${PDF_BASE64}${handoffId}`,
    expiresAtMs: Date.now() + expiresInMs
  };
}

function indexOfCall(calls, call) {
  const index = calls.indexOf(call);

  assert.notEqual(index, -1, `Missing call ${call} in ${calls.join(", ")}`);
  return index;
}

// 1. Stores the entry with ids, and stores before activating/focusing/pinging.
async function storesBeforeActivatingCheck() {
  const harness = createHarness();

  harness.addTab({ id: 1, url: DASHBOARD_URL, windowId: 3 }, true);
  await harness.send(42);

  const [entry] = harness.pending();
  const { calls } = harness;

  assert.equal(harness.pending().length, 1);
  assert.match(entry.handoffId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(entry.targetTabId, 1);
  assert.equal(entry.sourceTabId, 42);
  assert.equal(entry.base64, PDF_BASE64);
  assert.equal(entry.filename, "quote.pdf");
  assert.ok(entry.expiresAtMs > Date.now() + 14 * 60 * 1000);
  assert.equal(calls[0], "badge:42:...");
  assert.ok(indexOfCall(calls, "sendMessage:1:QTE_PROBE") < indexOfCall(calls, "storage.set"));
  assert.ok(indexOfCall(calls, "storage.set") < indexOfCall(calls, `alarms.create:${entry.expiresAtMs}`));
  assert.ok(indexOfCall(calls, `alarms.create:${entry.expiresAtMs}`) < indexOfCall(calls, "tabs.update:1"));
  assert.ok(indexOfCall(calls, "tabs.update:1") < indexOfCall(calls, "windows.update:3"));
  assert.ok(indexOfCall(calls, "windows.update:3") < indexOfCall(calls, "sendMessage:1:QTE_PING"));
  assert.equal(calls.includes("tabs.create:500"), false);
}

// 2. A second click reuses the pending target tab while it stays on the app origin.
async function reusesPendingTargetTabCheck() {
  const harness = createHarness();

  await harness.send(42);
  indexOfCall(harness.calls, "tabs.create:500");

  // The new tab is now on the login page, not the dashboard, and has no bridge yet.
  Object.assign(harness.state.tabs.get(500), { pendingUrl: undefined, url: `${APP_ORIGIN}/` });
  harness.calls.length = 0;
  await harness.send(42);

  assert.equal(harness.calls.some((call) => call.startsWith("tabs.query")), false);
  assert.equal(harness.calls.some((call) => call.startsWith("tabs.create")), false);
  assert.equal(harness.calls.some((call) => call.endsWith("QTE_PROBE")), false);
  assert.deepEqual(harness.pending().map((entry) => entry.targetTabId), [500, 500]);
  // Ping is still attempted; the tab without a bridge throws and that is fine.
  indexOfCall(harness.calls, "sendMessage:500:QTE_PING");

  harness.state.tabs.get(500).url = "https://example.com/somewhere-else";
  harness.calls.length = 0;
  await harness.send(42);

  indexOfCall(harness.calls, `tabs.query:${DASHBOARD_URL}*`);
  indexOfCall(harness.calls, "tabs.create:501");
  assert.deepEqual(harness.pending().map((entry) => entry.targetTabId), [500, 500, 501]);
}

// 3. Probe order, discarded tabs skipped, and fallback to a new tab.
async function probesDashboardTabsCheck() {
  const tabs = [
    { id: 1, url: DASHBOARD_URL, lastAccessed: 10 },
    { id: 2, url: `${DASHBOARD_URL}?step=send`, lastAccessed: 30, discarded: true },
    { id: 3, url: DASHBOARD_URL, lastAccessed: 20 }
  ];
  const probes = (calls) => calls.filter((call) => call.endsWith("QTE_PROBE"));

  const noBridge = createHarness();

  tabs.forEach((tab) => noBridge.addTab(tab));
  await noBridge.send(null);
  assert.deepEqual(probes(noBridge.calls), ["sendMessage:3:QTE_PROBE", "sendMessage:1:QTE_PROBE"]);
  assert.equal(noBridge.pending()[0].targetTabId, 500);
  assert.equal(noBridge.pending()[0].sourceTabId, null);
  assert.equal(noBridge.calls.some((call) => call.startsWith("badge:")), false);

  const allBridges = createHarness();

  tabs.forEach((tab) => allBridges.addTab(tab, true));
  await allBridges.send(null);
  assert.deepEqual(probes(allBridges.calls), ["sendMessage:3:QTE_PROBE"]);
  assert.equal(allBridges.pending()[0].targetTabId, 3);
  assert.equal(allBridges.calls.some((call) => call.startsWith("tabs.create")), false);

  const oldestOnly = createHarness();

  tabs.forEach((tab) => oldestOnly.addTab(tab, tab.id !== 3));
  await oldestOnly.send(null);
  assert.deepEqual(probes(oldestOnly.calls), ["sendMessage:3:QTE_PROBE", "sendMessage:1:QTE_PROBE"]);
  assert.equal(oldestOnly.pending()[0].targetTabId, 1);
}

// 4. A quota error on set throws the storage-full error and never activates or pings.
async function quotaErrorCheck() {
  const harness = createHarness();

  harness.addTab({ id: 1, url: DASHBOARD_URL }, true);
  harness.state.failSet = true;

  await assert.rejects(harness.send(42), /browser storage is full/);
  assert.deepEqual(harness.pending(), []);
  assert.equal(harness.calls.some((call) => call.startsWith("tabs.update")), false);
  assert.equal(harness.calls.some((call) => call.startsWith("windows.update")), false);
  assert.equal(harness.calls.some((call) => call.endsWith("QTE_PING")), false);
  indexOfCall(harness.calls, "badge:42:ERR");

  // The queue keeps working after a failed write.
  harness.state.failSet = false;
  await harness.send(42);
  assert.equal(harness.pending().length, 1);
}

// 5. More than five pending entries drops the oldest.
async function dropsOldestCheck() {
  const harness = createHarness();

  harness.addTab({ id: 1, url: DASHBOARD_URL }, true);
  harness.setPending([0, 1, 2, 3, 4].map((index) => makeEntry(`e${index}`, 1, 70 + index)));
  await harness.send(42);

  const ids = harness.pending().map((entry) => entry.handoffId);

  assert.equal(ids.length, 5);
  assert.deepEqual(ids.slice(0, 4), ["e1", "e2", "e3", "e4"]);
  assert.equal(harness.pending()[4].sourceTabId, 42);
  indexOfCall(harness.calls, "log:Quote-to-Email queue full");
  indexOfCall(harness.calls, "clearBadge:70");
  assert.equal(harness.calls.includes("clearBadge:71"), false);
}

// 6. QTE_READY returns the oldest unexpired entry for the sender tab only.
async function readyCheck() {
  const harness = createHarness();
  const { sandbox } = harness;

  harness.setPending([
    makeEntry("A", 1, 42, -1000),
    makeEntry("B", 1, 42),
    makeEntry("C", 2, 43),
    makeEntry("D", 1, 42)
  ]);

  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: [] }, { tab: { id: 1 } })).pending.handoffId, "B");
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: ["B"] }, { tab: { id: 1 } })).pending.handoffId, "D");
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: ["B", "D"] }, { tab: { id: 1 } })).pending, null);
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY" }, { tab: { id: 2 } })).pending.handoffId, "C");
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: [] }, { tab: { id: 3 } })).pending, null);
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: [] }, {})).pending, null);
  assert.equal((await sandbox.handleQteReady({ type: "QTE_READY", exclude: [] }, { tab: { id: 1 } })).ok, true);
  assert.equal(harness.pending().length, 4);
  assert.equal(harness.calls.includes("storage.set"), false);
}

// 7. DELIVERED removes only its entry, badges OK, and a READY right behind it sees the removal.
async function deliveredCheck() {
  const harness = createHarness();
  const { sandbox } = harness;

  harness.setPending([makeEntry("A", 1, 42), makeEntry("B", 1, 42), makeEntry("C", 2, 2)]);

  const deliveredPromise = sandbox.handleQtePendingPdfDelivered(
    { type: "QTE_PENDING_PDF_DELIVERED", handoffId: "A", filename: "A.pdf", appUrl: DASHBOARD_URL },
    { tab: { id: 1, url: DASHBOARD_URL } }
  );
  const readyPromise = sandbox.handleQteReady({ type: "QTE_READY", exclude: [] }, { tab: { id: 1 } });
  const [delivered, ready] = await Promise.all([deliveredPromise, readyPromise]);

  assert.equal(delivered.ok, true);
  assert.equal(ready.pending.handoffId, "B");
  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["B", "C"]);
  indexOfCall(harness.calls, "badge:42:OK");
  indexOfCall(harness.calls, "badge:1:OK");

  // Source tab equal to sender tab is badged once.
  harness.calls.length = 0;
  await sandbox.handleQtePendingPdfDelivered({ handoffId: "C", filename: "C.pdf" }, { tab: { id: 2 } });
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("badge:")), ["badge:2:OK"]);
  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["B"]);

  // A badge failure (closed tab) does not throw out of the handler.
  sandbox.setActionBadge = async () => {
    throw new Error("No tab with id: 42.");
  };
  assert.equal((await sandbox.handleQtePendingPdfDelivered({ handoffId: "B" }, { tab: { id: 1 } })).ok, true);
  assert.deepEqual(harness.pending(), []);
  indexOfCall(harness.calls, "alarms.clear");
}

// 8. FAILED keeps the entry and sets a persistent ERR badge.
async function failedCheck() {
  const harness = createHarness();

  harness.setPending([makeEntry("A", 1, 42)]);

  const result = await harness.sandbox.handleQtePendingPdfFailed(
    { type: "QTE_PENDING_PDF_FAILED", handoffId: "A", filename: "A.pdf" },
    { tab: { id: 1 } }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["A"]);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("badge:")), ["badge:42:ERR:persist", "badge:1:ERR:persist"]);
  assert.equal(harness.calls.includes("storage.set"), false);
}

// 9. Expiry drops only expired entries and reschedules or clears the alarm.
async function expireCheck() {
  const harness = createHarness();
  const fresh = makeEntry("B", 1, 43, 60000);

  harness.setPending([makeEntry("A", 1, 42, -1000), fresh, makeEntry("C", 1, null, -1000)]);
  await harness.sandbox.expireQtePendingPdf();

  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["B"]);
  indexOfCall(harness.calls, `alarms.create:${fresh.expiresAtMs}`);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("badge:")), ["badge:42:ERR:persist"]);
  assert.equal(harness.calls.filter((call) => call === "log:Quote-to-Email PDF timeout").length, 2);

  harness.calls.length = 0;
  harness.setPending([makeEntry("B", 1, 43, -1)]);
  await harness.sandbox.expireQtePendingPdf();

  assert.deepEqual(harness.pending(), []);
  indexOfCall(harness.calls, "alarms.clear");
  assert.equal(harness.calls.some((call) => call.startsWith("alarms.create")), false);
}

// 10. Closing the target tab drops only its entries and clears their source badges.
async function tabRemovedCheck() {
  const harness = createHarness();

  harness.setPending([makeEntry("A", 1, 42), makeEntry("B", 2, 43), makeEntry("C", 1, null)]);
  await harness.sandbox.handleQteTabRemoved(1);

  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["B"]);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("clearBadge:")), ["clearBadge:42"]);
  assert.equal(harness.calls.filter((call) => call === "log:Quote-to-Email tab closed").length, 2);

  harness.calls.length = 0;
  await harness.sandbox.handleQteTabRemoved(99);
  assert.equal(harness.calls.includes("storage.set"), false);
  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["B"]);
}

// 12. The action click shows "OK" only when the web app was not used.
async function actionClickBadgeCheck() {
  const harness = createHarness();
  const { sandbox } = harness;
  let webAppOpened = true;

  Object.assign(sandbox, {
    isAltaPresentationUrl: () => false,
    isAegisUrl: () => false,
    isBambooUrl: () => false,
    getLatestPdfMetadata: async () => null,
    sendBrowserPdf: async () => ({ message: "sent", webAppOpened }),
    showPdfCaptureLoadingIndicator: async () => {},
    hidePdfCaptureLoadingIndicator: async () => {},
    showActionError: async (tabId, error) => {
      harness.calls.push(`error:${tabId}:${error.message}`);
    }
  });

  await sandbox.handleActionClick({ id: 7, url: "https://example.com/quote.pdf" });
  assert.deepEqual(harness.calls, ["badge:7:..."]);

  harness.calls.length = 0;
  webAppOpened = false;
  await sandbox.handleActionClick({ id: 7, url: "https://example.com/quote.pdf" });
  assert.deepEqual(harness.calls, ["badge:7:...", "badge:7:OK"]);
}

// 13. Two sends that overlap (toolbar double-click) pick one target tab, not two new tabs.
async function concurrentSendsCheck() {
  const harness = createHarness();

  await Promise.all([harness.send(42), harness.send(42)]);

  assert.equal(harness.calls.filter((call) => call.startsWith("tabs.create")).length, 1);
  assert.deepEqual(harness.pending().map((entry) => entry.targetTabId), [500, 500]);
}

// 14. The previous target is reused only on the login page or the dashboard.
async function reuseRouteCheck() {
  for (const [url, reused] of [
    [`${APP_ORIGIN}/?redirect=%2Fdashboard`, true],
    [`${DASHBOARD_URL}?step=send`, true],
    [`${APP_ORIGIN}/settings`, false],
    [`${APP_ORIGIN}/history`, false]
  ]) {
    const harness = createHarness();

    harness.addTab({ id: 1, url });
    harness.setPending([makeEntry("A", 1, 42)]);
    await harness.send(42);

    assert.equal(harness.pending()[1].targetTabId, reused ? 1 : 500, url);
  }
}

// 15. DELIVERED also drops waiting copies of the same PDF for the same tab (e.g. an earlier FAILED one).
async function deliveredDropsSamePdfCheck() {
  const harness = createHarness();
  const samePdf = (entry) => ({ ...entry, base64: PDF_BASE64 });

  harness.setPending([
    samePdf(makeEntry("A", 1, 42)),
    samePdf(makeEntry("B", 1, 42)),
    makeEntry("C", 1, 42),
    samePdf(makeEntry("D", 2, 43))
  ]);
  await harness.sandbox.handleQtePendingPdfDelivered({ handoffId: "B" }, { tab: { id: 1 } });

  assert.deepEqual(harness.pending().map((entry) => entry.handoffId), ["C", "D"]);
}

// 11. Source-level guards.
function sourceCheck() {
  const handleMessageSource = extractFunction("handleMessage");

  assert.equal(source.includes("setAccessLevel"), false);
  assert.equal(source.includes("TRUSTED_AND_UNTRUSTED_CONTEXTS"), false);
  assert.match(handleMessageSource, /case "QTE_READY":\s*return handleQteReady\(message, sender\);/);
  assert.match(handleMessageSource, /case "QTE_PENDING_PDF_FAILED":\s*return handleQtePendingPdfFailed\(message, sender\);/);
  assert.match(handleMessageSource, /case "QTE_PENDING_PDF_DELIVERED":\s*return handleQtePendingPdfDelivered\(message, sender\);/);
  assert.ok(source.includes("handleQteTabRemoved(tabId).catch(() => {});"));
}

(async () => {
  await storesBeforeActivatingCheck();
  await reusesPendingTargetTabCheck();
  await probesDashboardTabsCheck();
  await quotaErrorCheck();
  await dropsOldestCheck();
  await readyCheck();
  await deliveredCheck();
  await failedCheck();
  await expireCheck();
  await tabRemovedCheck();
  sourceCheck();
  await actionClickBadgeCheck();
  await concurrentSendsCheck();
  await reuseRouteCheck();
  await deliveredDropsSamePdfCheck();
  console.log("qte-worker tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
