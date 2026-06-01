# Remote Deployment

This extension can be installed and updated remotely with a self-hosted CRX and Chrome/Edge enterprise policy.

## GitHub Setup

1. Keep the extension source in this folder:
   `Extentions/Browser-PDF-Webhook-Sender`
2. In GitHub, go to repository Settings > Secrets and variables > Actions.
3. Add this secret:
   `BROWSER_PDF_WEBHOOK_EXTENSION_PEM_BASE64`
4. The secret value must be the base64 of the extension signing `.pem` file.

From PowerShell, create the secret value with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\pdf-webhook-extension.pem"))
```

Do not commit the `.pem` file. It controls the extension ID and future updates.

## Publish

1. Enable GitHub Pages with source set to GitHub Actions.
2. Run the workflow:
   `Deploy Browser PDF Webhook Sender`
3. The workflow publishes:
   - `update.xml`
   - the signed `.crx`
   - `install-managed-extension.ps1`
   - `install-managed-extension.bat`

The public update URL will be:

```text
https://JanielRosario.github.io/Gia-Extensions/Extentions/Browser-PDF-Webhook-Sender/update.xml
```

## Remote Install

Run this remotely as Administrator on each Windows PC:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm 'https://JanielRosario.github.io/Gia-Extensions/Extentions/Browser-PDF-Webhook-Sender/install-managed-extension.ps1' | iex"
```

Or download and run this batch file as Administrator:

```text
https://JanielRosario.github.io/Gia-Extensions/Extentions/Browser-PDF-Webhook-Sender/install-managed-extension.bat
```

The installer writes Chrome and Edge force-install policy entries. Restart Chrome/Edge, or open `chrome://policy` / `edge://policy` and reload policies.

## Updates

1. Bump `manifest.json` version.
2. Push to `main`.
3. The workflow publishes a new CRX and updates `update.xml`.
4. Chrome/Edge updates managed clients automatically.

Use the same signing key every time. A different key creates a different extension ID.
