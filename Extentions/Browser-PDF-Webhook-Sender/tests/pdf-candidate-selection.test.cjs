const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "service-worker.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

assert.equal(source.includes("chrome.debugger"), false);
assert.equal(manifest.permissions.includes("debugger"), false);

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

const sandbox = {
  URL,
  setTimeout,
  clearTimeout,
  atob,
  btoa
};
vm.createContext(sandbox);
vm.runInContext(`
  ${extractFunction("decodeURIComponentSafe")}
  ${extractFunction("urlLooksLikePdfFile")}
  ${extractFunction("sanitizeUploadedPdfFileName")}
  ${extractFunction("getBrowserPdfFileName")}
  ${extractFunction("stripPdfDataUrlPrefix")}
  ${extractFunction("getPdfCandidateRank")}
  ${extractFunction("comparePdfCandidates")}
  ${extractFunction("handleActionClick")}
  ${extractFunction("isAltaPresentationUrl")}
  ${extractFunction("isAegisUrl")}
  ${extractFunction("isBambooUrl")}
  ${extractFunction("isBrowserPdfReaderUrl")}
  ${extractFunction("getBrowserPdfReaderSourceUrl")}
  ${extractFunction("isAltaBlockedPdfCandidate")}
  ${extractFunction("delay")}
  ${extractFunction("captureAltaPrintHtmlInPage")}
  ${extractFunction("captureAltaQuotePdfInPage")}
  ${extractFunction("clickAegisPrintQuoteButtonInPage")}
  ${extractFunction("captureBambooQuotePdfInPage")}
  globalThis.comparePdfCandidates = comparePdfCandidates;
  globalThis.urlLooksLikePdfFile = urlLooksLikePdfFile;
  globalThis.sanitizeUploadedPdfFileName = sanitizeUploadedPdfFileName;
  globalThis.getBrowserPdfFileName = getBrowserPdfFileName;
  globalThis.stripPdfDataUrlPrefix = stripPdfDataUrlPrefix;
  globalThis.handleActionClick = handleActionClick;
  globalThis.isAltaPresentationUrl = isAltaPresentationUrl;
  globalThis.isAegisUrl = isAegisUrl;
  globalThis.isBambooUrl = isBambooUrl;
  globalThis.isBrowserPdfReaderUrl = isBrowserPdfReaderUrl;
  globalThis.getBrowserPdfReaderSourceUrl = getBrowserPdfReaderSourceUrl;
  globalThis.isAltaBlockedPdfCandidate = isAltaBlockedPdfCandidate;
  globalThis.captureAltaPrintHtmlInPage = captureAltaPrintHtmlInPage;
  globalThis.captureAltaQuotePdfInPage = captureAltaQuotePdfInPage;
  globalThis.clickAegisPrintQuoteButtonInPage = clickAegisPrintQuoteButtonInPage;
  globalThis.captureBambooQuotePdfInPage = captureBambooQuotePdfInPage;
`, sandbox);

const visibleAltaPdf = {
  url: "https://alta.example/visible.pdf",
  source: "dom:src",
  tagName: "iframe",
  visible: true,
  inViewport: true,
  visibleArea: 600000
};
const hidden360Pdf = {
  url: "https://alta.example/360-value.pdf",
  source: "frame-location",
  tagName: "document",
  visible: false,
  inViewport: false,
  visibleArea: 0
};
const performance360Pdf = {
  url: "https://alta.example/360-value-from-performance.pdf",
  source: "performance-resource",
  tagName: "resource",
  visible: false,
  inViewport: false,
  visibleArea: 0
};

assert.equal(
  [hidden360Pdf, performance360Pdf, visibleAltaPdf].sort(sandbox.comparePdfCandidates)[0],
  visibleAltaPdf
);

assert.equal(
  [hidden360Pdf, performance360Pdf].sort(sandbox.comparePdfCandidates).at(-1),
  performance360Pdf
);

assert.equal(
  [
    visibleAltaPdf,
    {
      url: "https://alta.example/direct.pdf",
      source: "location",
      tagName: "document",
      visible: true,
      inViewport: true,
      visibleArea: Number.MAX_SAFE_INTEGER
    }
  ].sort(sandbox.comparePdfCandidates)[0].source,
  "location"
);

assert.equal(sandbox.isAltaPresentationUrl("https://alta.farmers.com/quote/presentation"), true);
assert.equal(sandbox.isAltaPresentationUrl("https://alta.farmers.com/quote/customer"), false);
assert.equal(sandbox.isBambooUrl("https://agent-access.bambooinsurance.com/Homeowners/HoQbWizardPage/quote"), true);
assert.equal(sandbox.isBambooUrl("https://bambooinsurance.com/"), false);
assert.equal(sandbox.isBrowserPdfReaderUrl("file:///C:/Quotes/Quote%20-%20Q1002409964.pdf"), true);
assert.equal(sandbox.isBrowserPdfReaderUrl("https://example.com/quote.pdf"), true);
assert.equal(sandbox.isBrowserPdfReaderUrl("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=file:///C:/Quotes/Quote.pdf"), true);
assert.equal(sandbox.isBrowserPdfReaderUrl("https://example.com/quote.html"), false);
assert.equal(sandbox.getBrowserPdfReaderSourceUrl("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=file:///C:/Quotes/Quote.pdf"), "file:///C:/Quotes/Quote.pdf");
assert.equal(sandbox.getBrowserPdfFileName("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=file:///C:/Quotes/Quote%20-%20Q1002409964.pdf", "index.html"), "Quote - Q1002409964.pdf");
assert.equal(sandbox.stripPdfDataUrlPrefix("data:application/pdf;filename=Alta.pdf;base64,JVBERi0x"), "JVBERi0x");
assert.equal(sandbox.isAltaBlockedPdfCandidate({ url: "https://alta.example/360Value.pdf" }), true);
assert.equal(sandbox.isAltaBlockedPdfCandidate({ url: "https://alta.example/presentation.pdf" }), false);

const altaPrintHtmlCaptureCheck = (async () => {
  let originalOpenCalled = false;
  const button = {
    innerText: "Download/Print",
    textContent: "Download/Print",
    disabled: false,
    className: "",
    getAttribute: () => null,
    click() {
      const popup = isolated.window.open("", "_blank", "top=0,left=0,height=auto,width=auto");
      popup.document.open();
      popup.document.write(`
        <html>
          <head><title>Feder_Home_10012026</title></head>
          <body>Quote number 1790872992151629 Printable Alta quote</body>
        </html>
      `);
      popup.document.close();
    }
  };
  const isolated = {
    setTimeout,
    clearTimeout,
    location: {
      href: "https://alta.farmers.com/quote/presentation"
    },
    document: {
      querySelectorAll(selector) {
        return selector.includes("button") ? [button] : [];
      }
    },
    window: null
  };

  isolated.window = {
    open() {
      originalOpenCalled = true;
      return null;
    }
  };

  vm.createContext(isolated);
  vm.runInContext(`
    ${extractFunction("captureAltaPrintHtmlInPage")}
    globalThis.resultPromise = captureAltaPrintHtmlInPage(500);
  `, isolated);
  isolated.result = await isolated.resultPromise;

  assert.equal(isolated.result.ok, true);
  assert.match(isolated.result.html, /Printable Alta quote/);
  assert.equal(isolated.result.fileName, "Farmers Home.pdf");
  assert.equal(isolated.result.quoteNumber, "1790872992151629");
  assert.equal(originalOpenCalled, false);
})();

const altaRenderCheck = (async () => {
  const canvasCalls = [];
  const imageCalls = [];
  const dataUrlCalls = [];
  const page = createNode();
  const preview = createNode();
  const previewText = `Quote number 1790872992151629 ${"coverage ".repeat(20)}`;

  page.scrollWidth = 900;
  page.offsetWidth = 900;
  page.scrollHeight = 1200;
  page.offsetHeight = 1200;
  page.getBoundingClientRect = () => ({ width: 450, height: 600 });
  preview.innerText = previewText;
  preview.textContent = preview.innerText;
  preview.querySelectorAll = (selector) => selector === ".a4-page" ? [page] : [];

  const isolated = {
    atob,
    btoa,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    location: {
      href: "https://alta.farmers.com/quote/presentation"
    },
    getComputedStyle: () => ({ width: "900px", height: "1200px", minHeight: "0px" }),
    requestAnimationFrame: (callback) => callback(),
    document: {
      body: {
        append(element) {
          this.lastChild = element;
        }
      },
      querySelector: (selector) => selector === "#estimate_page_view2"
        ? preview
        : null,
      querySelectorAll: () => [],
      createElement: createNode
    },
    window: {
      devicePixelRatio: 1,
      html2canvas: async (element, options) => {
        canvasCalls.push(options);
        return {
          width: options.width * options.scale,
          height: options.height * options.scale,
          toDataURL: (...args) => {
            dataUrlCalls.push(args);
            return "data:image/jpeg;base64,page";
          }
        };
      },
      jspdf: {
        jsPDF: function MockPdf() {
          this.addPage = () => {};
          this.addImage = (...args) => imageCalls.push(args);
          this.output = () => "data:application/pdf;base64,JVBERi0xLjQK";
        }
      }
    }
  };

  vm.createContext(isolated);
  vm.runInContext(`
    ${extractFunction("captureAltaQuotePdfInPage")}
    globalThis.resultPromise = captureAltaQuotePdfInPage();
  `, isolated);
  isolated.result = await isolated.resultPromise;

  assert.equal(isolated.result.ok, true);
  assert.equal(canvasCalls[0].width, 900);
  assert.equal(canvasCalls[0].height, 1200);
  assert.equal(canvasCalls[0].scale, 1.35);
  assert.deepEqual(dataUrlCalls[0], ["image/jpeg", 0.95]);
  assert.equal(isolated.document.body.lastChild.style.position, "fixed");
  assert.equal(isolated.document.body.lastChild.style.left, "-100000px");
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0][1], "JPEG");
  assert.equal(imageCalls[0][7], "FAST");
  assert.equal(isolated.result.base64, "JVBERi0xLjQK");
  assert.equal(isolated.result.fileName, "Alta-1790872992151629-presentation.pdf");

  function createNode() {
    return {
      style: {},
      children: [],
      innerText: "",
      textContent: "",
      scrollWidth: 900,
      offsetWidth: 900,
      scrollHeight: 1200,
      offsetHeight: 1200,
      append(child) {
        this.children.push(child);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      remove() {
        this.removed = true;
      },
      cloneNode() {
        const clone = createNode();
        clone.innerText = this.innerText;
        clone.textContent = this.textContent;
        clone.scrollWidth = this.scrollWidth;
        clone.offsetWidth = this.offsetWidth;
        clone.scrollHeight = this.scrollHeight;
        clone.offsetHeight = this.offsetHeight;
        clone.getBoundingClientRect = this.getBoundingClientRect;
        clone.querySelectorAll = this.querySelectorAll;
        return clone;
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 900, height: 1200 })
    };
  }
})();

(async () => {
  await altaPrintHtmlCaptureCheck;
  await altaRenderCheck;

  const actionCalls = [];
  Object.assign(sandbox, {
    cacheAltaQuoteFromOpenTab: async () => {
      actionCalls.push("alta");
      return { fileName: "fresh-alta.pdf" };
    },
    cacheAegisQuoteFromOpenTab: async () => {
      actionCalls.push("aegis");
      return { fileName: "fresh-aegis.pdf" };
    },
    cacheBambooQuoteFromOpenTab: async () => {
      actionCalls.push("bamboo");
      return { fileName: "fresh-bamboo.pdf" };
    },
    getLatestPdfMetadata: async () => {
      actionCalls.push("stale-cache");
      return { fileName: "old.pdf" };
    },
    sendBrowserPdf: async () => {
      actionCalls.push("send-browser");
      return { message: "sent" };
    },
    sendLatestPdf: async () => {
      actionCalls.push("send-latest");
      return { message: "sent" };
    },
    showPdfCaptureLoadingIndicator: async (tab) => {
      actionCalls.push(`show:${tab.id}`);
    },
    hidePdfCaptureLoadingIndicator: async (tab) => {
      actionCalls.push(`hide:${tab.id}`);
    },
    setActionBadge: async () => {},
    showActionError: async (tabId, error) => {
      actionCalls.push(`error:${tabId}:${error.message}`);
    }
  });

  await sandbox.handleActionClick({
    id: 9,
    url: "https://alta.farmers.com/quote/presentation"
  });

  assert.deepEqual(actionCalls, ["show:9", "alta", "send-latest", "hide:9"]);
  actionCalls.length = 0;

  await sandbox.handleActionClick({
    id: 10,
    url: "https://agent-access.bambooinsurance.com/Homeowners/HoQbWizardPage/quote"
  });

  assert.deepEqual(actionCalls, ["show:10", "bamboo", "send-latest", "hide:10"]);
  actionCalls.length = 0;

  sandbox.cacheAltaQuoteFromOpenTab = async () => {
    actionCalls.push("alta-miss");
    return null;
  };

  await sandbox.handleActionClick({
    id: 11,
    url: "https://alta.farmers.com/quote/presentation"
  });

  assert.deepEqual(actionCalls, [
    "show:11",
    "alta-miss",
    "error:11:Could not capture the current Alta quote PDF.",
    "hide:11"
  ]);

  const buttons = [
    {
      innerText: "Apply changes",
      textContent: "Apply changes",
      disabled: false,
      className: "apply-btn",
      getAttribute: () => null,
      click() {
        this.clicked = true;
        this.disabled = true;
      }
    },
    {
      innerText: "Download/Print",
      textContent: "Download/Print",
      disabled: false,
      className: "down-print-btn",
      getAttribute: () => null,
      click() {
        this.clicked = true;
      }
    },
    {
      id: "printQuotePdf",
      innerText: "Print Quote",
      textContent: "Print Quote",
      disabled: false,
      className: "",
      getAttribute: () => null,
      click() {
        this.clicked = true;
      }
    },
    {
      innerText: "Print Quote Summary",
      textContent: "Print Quote Summary",
      disabled: false,
      className: "print-summary",
      getAttribute: () => null,
      click() {
        this.clicked = true;
        sandbox.window.fetch("https://pc-prod-bamboo-bambooprod.api.delta4-andromeda.guidewire.net/rest/bamboo/digital/integration/v1/jobs/pc:test/generate-document-ext?docType=SubmissionQuote&draftMode=false")
          .then(() => {
            const anchor = new sandbox.HTMLAnchorElement();
            anchor.download = "Quote.pdf";
            anchor.href = "blob:https://agent-access.bambooinsurance.com/test";
            anchor.click();
          });
      }
    }
  ];
  let anchorClicked = false;
  sandbox.HTMLAnchorElement = function MockAnchor() {};
  sandbox.HTMLAnchorElement.prototype.click = function click() {
    anchorClicked = true;
  };
  sandbox.document = {
    body: {
      innerText: "Selected quotes\nHome Quotes\nQ1002409964"
    },
    head: {},
    querySelectorAll(selector) {
      if (selector.includes("button")) {
        return buttons;
      }

      return [];
    },
    querySelector: () => null
  };
  sandbox.window = {
    fetch: async (url) => ({
      url,
      clone() {
        return this;
      },
      json: async () => ({
        contents: "JVBERi0xLjQK",
        responseMimeType: "application/pdf"
      })
    })
  };

  const aegisClickResult = sandbox.clickAegisPrintQuoteButtonInPage();

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(aegisClickResult.ok, true);
  assert.equal(buttons[2].clicked, true);

  const bambooResult = await sandbox.captureBambooQuotePdfInPage(500);

  assert.equal(bambooResult.ok, true);
  assert.equal(bambooResult.fileName, "Quote - Q1002409964.pdf");
  assert.equal(bambooResult.base64, "JVBERi0xLjQK");
  assert.equal(buttons[3].clicked, true);
  assert.equal(anchorClicked, false);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
