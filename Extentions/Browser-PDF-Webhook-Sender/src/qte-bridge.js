(() => {
  const READY_SOURCE = "quote-to-email";
  const READY_TYPE = "qte-intake-ready";
  const PDF_SOURCE = "qte-extension";
  const PDF_TYPE = "qte-intake-pdf";
  const PENDING_KEY = "qtePendingPdf";
  const LAST_SENT_KEY = "qteLastSentPdf";
  const DOWNLOAD_BUTTON_ID = "qte-extension-download-last-pdf";
  const WAIT_FOR_PENDING_MS = 120000;
  let delivered = false;
  let delivering = false;

  chrome.storage.session.get(LAST_SENT_KEY)
    .then((stored) => {
      const lastSent = stored[LAST_SENT_KEY];

      if (lastSent?.base64) {
        installDownloadButton(lastSent);
      }
    })
    .catch(() => {});

  window.addEventListener("message", async (event) => {
    if (event.origin !== location.origin) {
      return;
    }

    const data = event.data;

    if (!data || data.source !== READY_SOURCE || data.type !== READY_TYPE) {
      return;
    }

    await deliverPendingPdf(await waitForPendingPdf());
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "session") {
      return;
    }

    const pending = changes[PENDING_KEY]?.newValue;

    if (pending?.base64) {
      deliverPendingPdf(pending).catch(() => {});
    }
  });

  async function deliverPendingPdf(pending) {
    if (delivered || delivering || !pending) {
      return;
    }

    if (pending.expiresAtMs && Date.now() > pending.expiresAtMs) {
      await chrome.storage.session.remove(PENDING_KEY);
      return;
    }

    delivering = true;

    try {
      const sent = {
        filename: pending.filename || "quote.pdf",
        base64: stripDataUrlPrefix(pending.base64 || ""),
        deliveredAt: new Date().toISOString(),
        metadata: pending.metadata || {}
      };

      window.postMessage({
        source: PDF_SOURCE,
        type: PDF_TYPE,
        filename: sent.filename,
        base64: sent.base64
      }, location.origin);

      await chrome.storage.session.set({
        [LAST_SENT_KEY]: sent
      });
      await chrome.storage.session.remove(PENDING_KEY);
      installDownloadButton(sent);
      delivered = true;

      chrome.runtime.sendMessage({
        type: "QTE_PENDING_PDF_DELIVERED",
        filename: sent.filename,
        appUrl: location.href
      }).catch(() => {});
    } finally {
      delivering = false;
    }
  }

  async function waitForPendingPdf() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < WAIT_FOR_PENDING_MS) {
      const stored = await chrome.storage.session.get(PENDING_KEY);
      const pending = stored[PENDING_KEY];

      if (pending?.expiresAtMs && Date.now() > pending.expiresAtMs) {
        await chrome.storage.session.remove(PENDING_KEY);
        return null;
      }

      if (pending?.base64) {
        return pending;
      }

      await delay(500);
    }

    return null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
