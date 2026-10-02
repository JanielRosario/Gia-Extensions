# Browser PDF Webhook Sender

Internal Chrome and Microsoft Edge extension MVP for caching readable PDFs and sending cached/current PDFs to Quote-to-Email, a webhook, or both only after a manual click.

## Load for testing

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this folder: `Extentions/Browser-PDF-Webhook-Sender`.
5. Open the extension settings and choose a send target. A webhook URL is only required for `Webhook only` or `Quote-to-Email and webhook`.

After changing extension files, click Reload on the extension card, then refresh the page tab.

## Install or Update for Staff

Use the managed installer page:

```text
https://JanielRosario.github.io/Gia-Extensions/Extentions/Browser-PDF-Webhook-Sender/
```

Chrome and Edge do not allow one-click installs for extensions hosted outside the Chrome Web Store. The page provides the closest supported flow: download/run the Windows installer as Administrator. It configures Chrome and Edge policy so the browser installs the signed CRX from this repo's GitHub Pages update feed.

For people who already installed the managed version, updates are automatic after `manifest.json` version is bumped, changes are pushed to `main`, and the GitHub Pages deploy workflow publishes the new CRX/update manifest. Restart Chrome/Edge to pick up the update faster.

For people using a local unpacked developer copy, install the managed version from the page above, then remove or disable the old unpacked copy in `chrome://extensions` / `edge://extensions`.

## Browser Button

Click the extension icon in the Chrome or Edge toolbar to send the PDF. The click first sends the latest PDF cached for the current tab. If the current tab has no cached PDF, the extension tries to read the current tab as a PDF and send it.

By default, sending stores the PDF temporarily for the app-tab bridge, then opens `https://quote-to-email.giatools.com/dashboard`. When the logged-in dashboard posts `{ source: "quote-to-email", type: "qte-intake-ready" }`, the bridge replies with `{ source: "qte-extension", type: "qte-intake-pdf", filename, base64 }` and clears the pending PDF. If the dashboard never becomes ready, the pending PDF expires after about 2 minutes.

For Guidewire/PolicyCenter/GWPC pages, a content script watches the known GWPC `Download` button. When that button is clicked, the extension watches the next PolicyCenter PDF response and tries to replay that same request so it can cache the original PDF bytes. It does not send automatically; click the extension icon after the cache appears.

The GWPC trigger is refreshed automatically when the extension starts and when a PolicyCenter tab updates. It also prepares the watcher as soon as the Download button appears, and again on hover/pointer-down, so the watcher should already be armed before the real Download click fires. If Chrome does not expose the PDF POST request body through `webRequest`, a temporary page hook captures the matching PolicyCenter form submit in memory as a fallback replay source. Diagnostic logs list field names/counts only, not field values.

For Aegis/GameChanger quote pages, a content script watches for the `Print Quote` dialog iframe (`#pdfQuoteIframe`). When the iframe points at `/GameChanger/PolicyFrame/Quote/QuotePrintPdf`, the extension fetches that iframe URL with the current browser session, verifies the response is a PDF, and caches it for the current tab. It does not send automatically; click the extension icon after the `PDF` badge appears. If the auto watcher misses the iframe, clicking the extension icon on an Aegis tab also scans the open page for `#pdfQuoteIframe`, caches it, then sends it.

For Alta presentation pages, clicking the extension icon on `https://alta.farmers.com/quote/presentation` captures Alta's own `Download/Print` HTML without opening the print popup, waits for that static quote document to render into a PDF, then opens Quote-to-Email. If Alta does not provide the printable HTML, the extension falls back to rendering the visible quote preview.

To change settings, right-click the extension icon and open Options, or use the extension card in `chrome://extensions` or `edge://extensions`.
The Options page also includes a diagnostics section with refresh and copy buttons.

## PDF Cache

Latest PDF metadata is stored per browser tab in extension local storage. The PDF body is stored in IndexedDB to avoid Chrome storage quota limits. On non-GWPC sites, the extension can cache a direct/current PDF or a PDF download when Chrome clearly identifies the file as a PDF and the source URL is still readable.

When the GWPC Download button is clicked, the extension clears the previous cached PDF for that GWPC tab before watching the next PDF response. If GWPC opens the PDF in another tab, the captured PDF is saved for both the original GWPC tab and the PDF tab.

GWPC PDF watching only watches these hosts:

- `https://policycenter.farmersinsurance.com/*`
- `https://policycenter-2.farmersinsurance.com/*`
- `https://policycenter-3.farmersinsurance.com/*`

Aegis quote PDF watching only watches:

- `https://prod.aegisinsurance.com/*`

## Delivery Modes

- `Quote-to-Email web app` opens the dashboard and sends the PDF by the fixed `postMessage` handshake.
- `Webhook only` keeps the older background HTTP POST behavior.
- `Quote-to-Email and webhook` does both.

## Webhook Send Modes

- `Multipart PDF upload` posts a `pdf` file plus metadata.
- `Raw PDF body` posts the PDF directly with `Content-Type: application/pdf`.
- `JSON with base64 PDF` posts the PDF bytes as `pdfBase64`.

## Remote config

The settings page can point to an admin-managed JSON endpoint. The extension refreshes remote config before sending and every 30 minutes.

Example:

```json
{
  "enabled": true,
  "deliveryMode": "webApp",
  "webhookUrl": "https://example.com/webhook",
  "sendMode": "multipart"
}
```

Remote config is data only. Extension JavaScript must stay packaged inside the extension.

## Troubleshooting

- Toolbar sending requires either a cached PDF for the current tab or a current tab that can be read directly as a PDF. In GWPC, click the GWPC `Download` button first, wait for the `PDF` badge, then click the extension icon. In Aegis, click `Print Quote`, wait for the quote PDF dialog and the `PDF` badge, then click the extension icon.
- Current-tab PDF fallback works with PDFs opened directly in the browser PDF reader when the tab URL/response clearly identifies a PDF, such as `application/pdf`, a `.pdf` filename, or Chrome's PDF viewer `src=` URL.
- If the Quote-to-Email dashboard is not logged in or never posts ready, the pending PDF is discarded after about 2 minutes.
- If the webhook shows a long string beginning with `JVBERi0x`, it received a base64 PDF. Switch Send mode to `Multipart PDF upload` or `Raw PDF body` if your webhook needs a file/binary request.
- If the extension shows a `SET` badge while using a webhook delivery mode, add a webhook URL from right-click Options.
- Alta normally sends the static printable document generated by `Download/Print`; no debugger permission or browser print-preview tab is used. If that capture fails, it falls back to the visible preview render.
- Local `file://` PDFs can live anywhere on the PC, but each browser must enable `Allow access to file URLs` on the extension card before an unpacked/managed extension can read those tabs.

## Enterprise deployment notes

For internal deployment without a public store listing, package the extension as a `.crx`, host the update manifest and package on an internal HTTPS endpoint, then force-install it through Chrome or Edge enterprise policy.
