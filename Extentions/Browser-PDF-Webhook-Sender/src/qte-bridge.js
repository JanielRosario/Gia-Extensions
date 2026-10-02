(() => {
  const APP_SOURCE = "quote-to-email";
  const READY_TYPE = "qte-intake-ready";
  const ACK_TYPE = "qte-intake-ack";
  const EXTENSION_SOURCE = "qte-extension";
  const PING_TYPE = "qte-intake-ping";
  const PDF_TYPE = "qte-intake-pdf";
  const DOWNLOAD_BUTTON_ID = "qte-extension-download-last-pdf";
  const ACK_TIMEOUT_MS = 3000;
  const posted = new Map();
  const delivered = new Set();
  const failed = new Set();
  let inFlight = null;
  let asking = false;

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) {
      return;
    }

    const data = event.data;

    if (!data || data.source !== APP_SOURCE) {
      return;
    }

    if (data.type === READY_TYPE) {
      askForPendingPdf();
    } else if (data.type === ACK_TYPE) {
      handleAck(data);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "QTE_PROBE") {
      sendResponse({ ok: true });
    } else if (message?.type === "QTE_PING") {
      postPing();
      sendResponse({ ok: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      postPing();
    }
  });

  postPing();

  function postPing() {
    window.postMessage({
      source: EXTENSION_SOURCE,
      type: PING_TYPE
    }, location.origin);
  }

  async function askForPendingPdf() {
    if (asking || inFlight) {
      return;
    }

    asking = true;
    const reply = await sendToWorker({
      type: "QTE_READY",
      exclude: [...delivered, ...failed]
    });
    asking = false;

    const pending = reply?.pending;

    if (!pending?.base64 || inFlight || delivered.has(pending.handoffId) || failed.has(pending.handoffId)) {
      return;
    }

    const handoff = {
      handoffId: pending.handoffId,
      filename: pending.filename || "quote.pdf",
      base64: stripDataUrlPrefix(pending.base64),
      metadata: pending.metadata || {}
    };

    posted.set(getFingerprint(handoff.base64), handoff);
    inFlight = {
      handoff,
      timer: setTimeout(handleAckTimeout, ACK_TIMEOUT_MS),
      retried: false
    };
    postPdf(handoff);
  }

  function postPdf(handoff) {
    window.postMessage({
      source: EXTENSION_SOURCE,
      type: PDF_TYPE,
      filename: handoff.filename,
      base64: handoff.base64
    }, location.origin);
  }

  function handleAckTimeout() {
    const handoff = inFlight.handoff;

    if (!inFlight.retried) {
      inFlight.retried = true;
      inFlight.timer = setTimeout(handleAckTimeout, ACK_TIMEOUT_MS);
      postPdf(handoff);
      return;
    }

    inFlight = null;
    failed.add(handoff.handoffId);
    sendToWorker({
      type: "QTE_PENDING_PDF_FAILED",
      handoffId: handoff.handoffId,
      filename: handoff.filename
    });
  }

  function handleAck(data) {
    const handoff = posted.get(data.fingerprint);

    if (!handoff || delivered.has(handoff.handoffId)) {
      return;
    }

    delivered.add(handoff.handoffId);
    failed.delete(handoff.handoffId);

    if (inFlight?.handoff === handoff) {
      clearTimeout(inFlight.timer);
      inFlight = null;
    }

    installDownloadButton(handoff);
    sendToWorker({
      type: "QTE_PENDING_PDF_DELIVERED",
      handoffId: handoff.handoffId,
      filename: handoff.filename,
      appUrl: location.href
    });
    askForPendingPdf();
  }

  async function sendToWorker(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function getFingerprint(base64) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < base64.length; index += 1) {
      hash ^= base64.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return `${base64.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function installDownloadButton(pdf) {
    if (!pdf?.base64) {
      return;
    }

    document.getElementById(DOWNLOAD_BUTTON_ID)?.remove();

    const button = document.createElement("button");
    button.id = DOWNLOAD_BUTTON_ID;
    button.type = "button";
    button.textContent = "Download sent PDF";
    button.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:20px",
      "z-index:2147483647",
      "padding:10px 14px",
      "border:0",
      "border-radius:6px",
      "background:#075985",
      "color:#fff",
      "font:600 14px Arial,sans-serif",
      "box-shadow:0 6px 18px rgba(0,0,0,.24)",
      "cursor:pointer"
    ].join(";");
    button.addEventListener("click", () => downloadPdf(pdf, button));
    document.body.append(button);
  }

  function downloadPdf(pdf, button) {
    button.disabled = true;

    try {
      const blob = base64ToPdfBlob(pdf.base64);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = getDownloadFileName(pdf);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } finally {
      button.disabled = false;
    }
  }

  function getDownloadFileName(pdf) {
    const originalName = sanitizeFileName(pdf.filename || "quote.pdf");
    const carrier = getCarrierName(pdf.metadata || {});
    const quote = getQuoteName(pdf.metadata || {}, originalName);
    const finalPart = carrier === "Farmers" ? getPolicyType(originalName) : originalName;
    const parts = [carrier, quote, finalPart].filter(Boolean);

    return sanitizeFileName(parts.join(" - ") || originalName);
  }

  function getCarrierName(metadata) {
    const sourceMode = `${metadata.carrier || metadata.sourceMode || ""}`;

    if (/alta|gwpc|policycenter/i.test(sourceMode)) {
      return "Farmers";
    }

    if (/bamboo/i.test(sourceMode)) {
      return "Bamboo";
    }

    if (/aegis/i.test(sourceMode)) {
      return "Aegis";
    }

    return sanitizeFileNamePart(metadata.carrier || "");
  }

  function getQuoteName(metadata, fileName) {
    const explicit = sanitizeFileNamePart(metadata.quoteNumber || metadata.quote || metadata.policyNumber || "");

    if (explicit) {
      return explicit;
    }

    return `${fileName || ""}`.match(/\bQ\d{4,}\b/i)?.[0]
      || `${fileName || ""}`.match(/\b\d{8,}\b/)?.[0]
      || "";
  }

  function getPolicyType(fileName) {
    const clean = sanitizeFileNamePart(fileName || "")
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ");
    const words = clean
      .split(" ")
      .filter(Boolean)
      .filter((word) => !/^(farmers|quote|presentation|alta|gwpc|policycenter)$/i.test(word))
      .filter((word) => !/^(?:Q\d{4,}|\d{6,})$/i.test(word));

    return words.join(" ");
  }

  function sanitizeFileName(fileName) {
    const cleaned = sanitizeFileNamePart(fileName || "quote.pdf").slice(0, 180);

    return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  }

  function sanitizeFileNamePart(value) {
    return `${value || ""}`
      .split(/[\\/]/)
      .pop()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function base64ToPdfBlob(base64) {
    const clean = stripDataUrlPrefix(base64);
    const binary = atob(clean);
    const chunks = [];

    for (let offset = 0; offset < binary.length; offset += 65536) {
      const slice = binary.slice(offset, offset + 65536);
      const bytes = new Uint8Array(slice.length);

      for (let index = 0; index < slice.length; index += 1) {
        bytes[index] = slice.charCodeAt(index);
      }

      chunks.push(bytes);
    }

    return new Blob(chunks, {
      type: "application/pdf"
    });
  }

  function stripDataUrlPrefix(base64) {
    return `${base64}`.replace(/^data:application\/pdf;base64,/i, "").replace(/\s+/g, "");
  }
})();
