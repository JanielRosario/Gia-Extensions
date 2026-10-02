const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const buildScript = fs.readFileSync(
  path.join(__dirname, "..", "deployment", "build-pages.ps1"),
  "utf8"
);

assert.match(buildScript, /\$unpackedZipName\s*=\s*"\$packageSlug-\$version-unpacked\.zip"/);
assert.match(buildScript, /Compress-Archive/);
assert.match(buildScript, /href="\.\/\$unpackedZipName"/);
assert.match(buildScript, /Load unpacked/);
