const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(path.join(__dirname, "..", "src", "qte-bridge.js"), "utf8");
const ORIGIN = "https://quote-to-email.giatools.com";
const PDF_BASE64 = "JVBERi0xLjQK";
const SECOND_BASE64 = "JVBERi0xLjcK";

(async () => {
  assert.equal(bridgeSource.includes("chrome.storage"), false);
  assert.equal(fingerprint(""), "0:811c9dc5");
  assert.equal(fingerprint("a"), "1:e40c292c");

  await pingOnInjectionCheck();
  await readyRequestsPendingPdfCheck();
  await readyBurstPostsOnceCheck();
  await ackTimeoutRetriesThenFailsCheck();
  await ackDeliversOnceCheck();
  await lateAckAfterFailureCheck();
  await drainsQueueAfterAckCheck();
  await workerMessagesAndVisibilityCheck();
  await downloadNameCheck();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function pingOnInjectionCheck() {
  const bridge = loadBridge();

  assert.equal(bridge.posts.length, 1);
  assert.equal(bridge.posts[0].message.source, "qte-extension");
  assert.equal(bridge.posts[0].message.type, "qte-intake-ping");
  assert.equal(bridge.posts[0].targetOrigin, ORIGIN);

  bridge.queue.push(makeHandoff("h1"));
  await flush();
  await bridge.ready("https://evil.example");

  assert.equal(bridge.pdfPosts().length, 0);
  assert.equal(bridge.sentOfType("QTE_READY").length, 0);
}

async function readyRequestsPendingPdfCheck() {
  const bridge = loadBridge();

  await bridge.ready();

  const [firstAsk] = bridge.sentOfType("QTE_READY");

  assert.equal(Array.isArray(firstAsk.exclude), true);
  assert.equal(firstAsk.exclude.length, 0);
  assert.equal(bridge.pdfPosts().length, 0);

  bridge.queue.push(makeHandoff("h1", "data:application/pdf;base64,JVBERi0x\nLjQK"));
  await bridge.ready();

  const [pdf] = bridge.pdfPosts();

  assert.equal(bridge.sentOfType("QTE_READY").length, 2);
  assert.equal(bridge.pdfPosts().length, 1);
  assert.equal(pdf.targetOrigin, ORIGIN);
  assert.equal(pdf.message.source, "qte-extension");
  assert.equal(pdf.message.filename, "h1.pdf");
  assert.equal(pdf.message.base64, PDF_BASE64);

  await bridge.ack(fingerprint(PDF_BASE64));

  assert.deepEqual(bridge.sentOfType("QTE_PENDING_PDF_DELIVERED").map((message) => message.handoffId), ["h1"]);
}

async function readyBurstPostsOnceCheck() {
  const bridge = loadBridge();
  let resolveReply = null;

  bridge.reply = () => new Promise((resolve) => {
    resolveReply = resolve;
  });
  await bridge.ready();
  await bridge.ready();
  await bridge.ready();

  assert.equal(bridge.sentOfType("QTE_READY").length, 1);
  assert.equal(bridge.pdfPosts().length, 0);

  resolveReply({ ok: true, pending: makeHandoff("h1") });
  await flush();

  assert.equal(bridge.pdfPosts().length, 1);

  bridge.reply = () => ({ ok: true, pending: makeHandoff("h1") });

  for (let index = 0; index < 5; index += 1) {
    await bridge.ready();
  }

  assert.equal(bridge.sentOfType("QTE_READY").length, 1);
  assert.equal(bridge.pdfPosts().length, 1);
}

async function ackTimeoutRetriesThenFailsCheck() {
  const bridge = loadBridge();

  bridge.queue.push(makeHandoff("h1"));
  await bridge.ready();
  bridge.advance(2999);

  assert.equal(bridge.pdfPosts().length, 1);

  bridge.advance(1);

  assert.equal(bridge.pdfPosts().length, 2);
  assert.equal(bridge.pdfPosts()[1].message.base64, PDF_BASE64);
  assert.equal(bridge.pdfPosts()[1].message.filename, "h1.pdf");
  assert.equal(bridge.sentOfType("QTE_PENDING_PDF_FAILED").length, 0);

  bridge.advance(3000);

  const failures = bridge.sentOfType("QTE_PENDING_PDF_FAILED");

  assert.equal(failures.length, 1);
  assert.equal(failures[0].handoffId, "h1");
  assert.equal(failures[0].filename, "h1.pdf");
  assert.equal(bridge.pdfPosts().length, 2);

  await bridge.ready();

  const asks = bridge.sentOfType("QTE_READY");

  assert.equal(asks.length, 2);
  assert.deepEqual([...asks[1].exclude], ["h1"]);
  assert.equal(bridge.pdfPosts().length, 2);

  bridge.reply = () => ({ ok: true, pending: makeHandoff("h1") });
  bridge.onRuntimeMessage({ type: "QTE_PING" }, {}, () => {});
  await bridge.ready();
  bridge.advance(10000);

  assert.equal(bridge.sentOfType("QTE_READY").length, 3);
  assert.equal(bridge.pdfPosts().length, 2);
  assert.equal(bridge.sentOfType("QTE_PENDING_PDF_FAILED").length, 1);
}

async function ackDeliversOnceCheck() {
  const bridge = loadBridge();

  bridge.queue.push(makeHandoff("h1"));
  await bridge.ready();
  await bridge.ack("12:00000000");

  assert.equal(bridge.sentOfType("QTE_PENDING_PDF_DELIVERED").length, 0);

  await bridge.ack(fingerprint(PDF_BASE64), { duplicate: true });
  await bridge.ack(fingerprint(PDF_BASE64));

  const deliveries = bridge.sentOfType("QTE_PENDING_PDF_DELIVERED");

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].handoffId, "h1");
  assert.equal(deliveries[0].filename, "h1.pdf");
  assert.equal(deliveries[0].appUrl, `${ORIGIN}/dashboard`);

  bridge.advance(10000);

  assert.equal(bridge.pdfPosts().length, 1);
  assert.equal(bridge.sentOfType("QTE_PENDING_PDF_FAILED").length, 0);
}

async function lateAckAfterFailureCheck() {
  const bridge = loadBridge();

  bridge.queue.push(makeHandoff("h1"));
  await bridge.ready();
  bridge.advance(3000);
  bridge.advance(3000);

  assert.equal(bridge.sentOfType("QTE_PENDING_PDF_FAILED").length, 1);

  await bridge.ack(fingerprint(PDF_BASE64));

  const deliveries = bridge.sentOfType("QTE_PENDING_PDF_DELIVERED");
  const asks = bridge.sentOfType("QTE_READY");

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].handoffId, "h1");
  assert.deepEqual([...asks[asks.length - 1].exclude], ["h1"]);
}

async function drainsQueueAfterAckCheck() {
  const bridge = loadBridge();

  bridge.queue.push(makeHandoff("h1"), makeHandoff("h2", SECOND_BASE64));
  await bridge.ready();

  assert.equal(bridge.pdfPosts().length, 1);
  assert.equal(bridge.pdfPosts()[0].message.filename, "h1.pdf");

  await bridge.ack(fingerprint(PDF_BASE64));

  let asks = bridge.sentOfType("QTE_READY");

  assert.equal(asks.length, 2);
  assert.deepEqual([...asks[1].exclude], ["h1"]);
  assert.equal(bridge.pdfPosts().length, 2);
  assert.equal(bridge.pdfPosts()[1].message.filename, "h2.pdf");
  assert.equal(bridge.pdfPosts()[1].message.base64, SECOND_BASE64);

  await bridge.ack(fingerprint(SECOND_BASE64));
  asks = bridge.sentOfType("QTE_READY");

  assert.deepEqual(bridge.sentOfType("QTE_PENDING_PDF_DELIVERED").map((message) => message.handoffId), ["h1", "h2"]);
  assert.equal(asks.length, 3);
  assert.deepEqual([...asks[2].exclude], ["h1", "h2"]);
  assert.equal(bridge.pdfPosts().length, 2);
}

async function workerMessagesAndVisibilityCheck() {
  const bridge = loadBridge();
  const responses = [];
  const respond = (response) => responses.push(response);

  assert.equal(bridge.onRuntimeMessage({ type: "QTE_PROBE" }, {}, respond), undefined);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(bridge.pings().length, 1);

  assert.equal(bridge.onRuntimeMessage({ type: "QTE_PING" }, {}, respond), undefined);
  assert.equal(responses.length, 2);
  assert.equal(responses[1].ok, true);
  assert.equal(bridge.pings().length, 2);

  assert.equal(bridge.onRuntimeMessage({ type: "SOMETHING_ELSE" }, {}, respond), undefined);
  assert.equal(responses.length, 2);

  bridge.document.visibilityState = "hidden";
  bridge.onVisibilityChange();

  assert.equal(bridge.pings().length, 2);

  bridge.document.visibilityState = "visible";
  bridge.onVisibilityChange();

  assert.equal(bridge.pings().length, 3);
  assert.equal(bridge.pings()[2].targetOrigin, ORIGIN);
}

async function downloadNameCheck() {
  const bamboo = await getDownloadName({
    filename: "Quote - Q1002409964.pdf",
    metadata: {
      sourceMode: "Bamboo Quote PDF"
    }
  });
  const alta = await getDownloadName({
    filename: "Farmers Home.pdf",
    metadata: {
      sourceMode: "Alta Quote PDF",
      quoteNumber: "1790872992151629"
    }
  });
  const gwpc = await getDownloadName({
    filename: "Home Quote 123456789.pdf",
    metadata: {
      sourceMode: "GWPC Download Trigger"
    }
  });

  assert.equal(bamboo, "Bamboo - Q1002409964 - Quote - Q1002409964.pdf");
  assert.equal(alta, "Farmers - 1790872992151629 - Home.pdf");
  assert.equal(gwpc, "Farmers - 123456789 - Home.pdf");

  async function getDownloadName(extra) {
    const bridge = loadBridge();

    bridge.queue.push(makeHandoff("h1", PDF_BASE64, extra));
    await bridge.ready();

    assert.equal(bridge.button, null);

    await bridge.ack(fingerprint(PDF_BASE64));

    assert.equal(bridge.button.id, "qte-extension-download-last-pdf");
    assert.equal(bridge.button.textContent, "Download sent PDF");

    bridge.button.click();

    return bridge.downloadName;
  }
}

function loadBridge() {
  const listeners = {};
  const timers = new Map();
  let clock = 0;
  let nextTimerId = 1;
  const bridge = {
    button: null,
    downloadName: "",
    posts: [],
    queue: [],
    sent: [],
    reply: (message) => ({
      ok: true,
      pending: bridge.queue.find((entry) => !message.exclude.includes(entry.handoffId)) || null
    }),
    advance(ms) {
      clock += ms;

      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= clock && timers.has(id)) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    ack: (value, extra = {}) => dispatch({
      source: "quote-to-email",
      type: "qte-intake-ack",
      filename: "acked.pdf",
      fingerprint: value,
      ...extra
    }),
    ready: (origin = ORIGIN) => dispatch({
      source: "quote-to-email",
      type: "qte-intake-ready"
    }, origin),
    onRuntimeMessage: (...args) => listeners.runtime(...args),
    onVisibilityChange: () => listeners.visibilitychange(),
    pdfPosts: () => bridge.posts.filter((post) => post.message.type === "qte-intake-pdf"),
    pings: () => bridge.posts.filter((post) => post.message.type === "qte-intake-ping"),
    sentOfType: (type) => bridge.sent.filter((message) => message.type === type)
  };
  const context = {
    atob,
    Blob: function MockBlob(parts, options) {
      this.parts = parts;
      this.options = options;
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listeners.runtime = callback;
          }
        },
        sendMessage: async (message) => {
          bridge.sent.push(message);
          return message.type === "QTE_READY" ? bridge.reply(message) : undefined;
        }
      }
    },
    clearTimeout: (id) => timers.delete(id),
    document: {
      visibilityState: "visible",
      addEventListener(type, callback) {
        listeners[type] = callback;
      },
      body: {
        append(element) {
          bridge.button = element;
        }
      },
      createElement: (tagName) => ({
        style: {},
        addEventListener(type, callback) {
          this[`on${type}`] = callback;
        },
        click() {
          if (tagName === "a") {
            bridge.downloadName = this.download;
          } else {
            this.onclick?.();
          }
        }
      }),
      getElementById: () => null
    },
    location: {
      href: `${ORIGIN}/dashboard`,
      origin: ORIGIN
    },
    setTimeout: (callback, ms) => {
      const id = nextTimerId;

      nextTimerId += 1;
      timers.set(id, { callback, at: clock + ms });
      return id;
    },
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL() {}
    },
    window: {
      addEventListener(type, callback) {
        if (type === "message") {
          listeners.message = callback;
        }
      },
      postMessage(message, targetOrigin) {
        bridge.posts.push({ message, targetOrigin });
      }
    }
  };

  bridge.document = context.document;
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  return bridge;

  async function dispatch(data, origin = ORIGIN) {
    listeners.message({ origin, data });
    await flush();
  }
}

function makeHandoff(handoffId, base64 = PDF_BASE64, extra = {}) {
  return {
    handoffId,
    targetTabId: 7,
    filename: `${handoffId}.pdf`,
    base64,
    metadata: {},
    ...extra
  };
}

function fingerprint(base64) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < base64.length; index += 1) {
    hash ^= base64.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `${base64.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
