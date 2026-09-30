const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

const sandbox = {
  URL,
  setTimeout
};
vm.createContext(sandbox);
vm.runInContext(`
  ${extractFunction("getPdfCandidateRank")}
  ${extractFunction("comparePdfCandidates")}
  ${extractFunction("isAltaPresentationUrl")}
  ${extractFunction("delay")}
  ${extractFunction("waitForAltaPrintableTab")}
  globalThis.comparePdfCandidates = comparePdfCandidates;
  globalThis.isAltaPresentationUrl = isAltaPresentationUrl;
  globalThis.waitForAltaPrintableTab = waitForAltaPrintableTab;
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

(async () => {
  let calls = 0;
  sandbox.chrome = {
    tabs: {
      query: async () => {
        calls += 1;

        return calls === 1
          ? [{ id: 1, url: "https://alta.farmers.com/quote/presentation", title: "Alta" }]
          : [
            { id: 1, url: "https://alta.farmers.com/quote/presentation", title: "Alta" },
            { id: 2, openerTabId: 1, url: "about:blank", title: "Music_Home_09302026" }
          ];
      }
    }
  };

  const printTab = await sandbox.waitForAltaPrintableTab(1, new Set([1]), 500);

  assert.equal(printTab.id, 2);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
