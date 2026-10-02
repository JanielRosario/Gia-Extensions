param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionDir,

  [Parameter(Mandatory = $true)]
  [string]$PemPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [Parameter(Mandatory = $true)]
  [string]$PagesBaseUrl,

  [string]$BrowserPath = ""
)

$ErrorActionPreference = "Stop"

function Get-PackBrowserPath {
  if ($BrowserPath) {
    if (!(Test-Path -LiteralPath $BrowserPath)) {
      throw "BrowserPath was provided but not found: $BrowserPath"
    }

    return $BrowserPath
  }

  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Could not find Chrome or Edge to pack the extension."
}

function Copy-ExtensionRuntimeFiles {
  param(
    [string]$SourceDir,
    [string]$DestinationDir
  )

  New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null

  $files = @(
    "manifest.json",
    "options.html",
    "options.js",
    "popup.html",
    "popup.js",
    "README.md",
    "styles.css"
  )

  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination $DestinationDir -Force
  }

  Copy-Item -LiteralPath (Join-Path $SourceDir "icons") -Destination $DestinationDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $SourceDir "src") -Destination $DestinationDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $SourceDir "vendor") -Destination $DestinationDir -Recurse -Force
}

$resolvedExtensionDir = (Resolve-Path -LiteralPath $ExtensionDir).Path
$resolvedPemPath = (Resolve-Path -LiteralPath $PemPath).Path
$deploymentDir = $PSScriptRoot
$manifestPath = Join-Path $resolvedExtensionDir "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = "$($manifest.version)"
$packageSlug = "browser-pdf-webhook-sender"
$pagesBase = $PagesBaseUrl.TrimEnd("/")
$relativeDir = "Extentions/Browser-PDF-Webhook-Sender"
$relativeCrxPath = "$relativeDir/$packageSlug-$version.crx"
$updateUrl = "$pagesBase/$relativeDir/update.xml"
$installerPs1Url = "$pagesBase/$relativeDir/install-managed-extension.ps1"
$crxUrl = "$pagesBase/$relativeCrxPath"
$extensionId = (& node (Join-Path $deploymentDir "extension-id-from-pem.js") $resolvedPemPath).Trim()

if (!$extensionId -or $extensionId.Length -ne 32) {
  throw "Could not derive a valid Chrome extension ID from the signing key."
}

$resolvedOutputDir = [IO.Path]::GetFullPath($OutputDir)

if (Test-Path -LiteralPath $resolvedOutputDir) {
  $leaf = Split-Path -Leaf $resolvedOutputDir

  if ($leaf -ne "dist-pages") {
    throw "Refusing to clear output directory because it is not named dist-pages: $resolvedOutputDir"
  }

  Remove-Item -LiteralPath $resolvedOutputDir -Recurse -Force
}

New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "browser-pdf-webhook-sender-pack-$([guid]::NewGuid())"
$stagingDir = Join-Path $tempRoot "Browser-PDF-Webhook-Sender"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  Copy-ExtensionRuntimeFiles -SourceDir $resolvedExtensionDir -DestinationDir $stagingDir

  $stagingManifestPath = Join-Path $stagingDir "manifest.json"
  $stagingManifest = Get-Content -LiteralPath $stagingManifestPath -Raw | ConvertFrom-Json
  if ($stagingManifest.PSObject.Properties.Name -contains "update_url") {
    $stagingManifest.update_url = $updateUrl
  } else {
    $stagingManifest | Add-Member -NotePropertyName "update_url" -NotePropertyValue $updateUrl
  }
  $stagingManifest |
    ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $stagingManifestPath -Encoding UTF8

  $browser = Get-PackBrowserPath
  $browserProfileDir = Join-Path $tempRoot "browser-profile"
  New-Item -ItemType Directory -Path $browserProfileDir -Force | Out-Null
  $packArgs = @(
    "--user-data-dir=$browserProfileDir",
    "--no-first-run",
    "--disable-background-networking",
    "--pack-extension=$stagingDir",
    "--pack-extension-key=$resolvedPemPath"
  )

  & $browser @packArgs

  if ($LASTEXITCODE -ne 0) {
    throw "Browser extension packing failed with exit code $LASTEXITCODE."
  }

  $packedCrx = "$stagingDir.crx"
  $packDeadline = (Get-Date).AddSeconds(30)

  while (!(Test-Path -LiteralPath $packedCrx) -and (Get-Date) -lt $packDeadline) {
    Start-Sleep -Milliseconds 500
  }

  if (!(Test-Path -LiteralPath $packedCrx)) {
    throw "Packed CRX was not created at expected path: $packedCrx"
  }

  $publishDir = Join-Path $resolvedOutputDir $relativeDir
  New-Item -ItemType Directory -Path $publishDir -Force | Out-Null
  Copy-Item -LiteralPath $packedCrx -Destination (Join-Path $publishDir "$packageSlug-$version.crx") -Force

  $escapedCrxUrl = [Security.SecurityElement]::Escape($crxUrl)
  $escapedExtensionId = [Security.SecurityElement]::Escape($extensionId)
  $escapedVersion = [Security.SecurityElement]::Escape($version)
  $updateXml = @"
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$escapedExtensionId">
    <updatecheck codebase="$escapedCrxUrl" version="$escapedVersion" />
  </app>
</gupdate>
"@

  Set-Content -LiteralPath (Join-Path $publishDir "update.xml") -Value $updateXml -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $publishDir "extension-id.txt") -Value $extensionId -Encoding UTF8

  $template = Get-Content -LiteralPath (Join-Path $deploymentDir "install-managed-extension.template.ps1") -Raw
  $installer = $template.Replace("__EXTENSION_ID__", $extensionId).Replace("__UPDATE_URL__", $updateUrl)
  Set-Content -LiteralPath (Join-Path $publishDir "install-managed-extension.ps1") -Value $installer -Encoding UTF8

  $batchInstaller = @"
@echo off
setlocal

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo This installer must be run as Administrator.
  echo Right-click this file and choose Run as administrator.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '$installerPs1Url' | iex"
if errorlevel 1 (
  echo.
  echo Install failed.
  pause
  exit /b %errorlevel%
)

echo.
echo Managed extension install policy is configured.
echo Restart Chrome/Edge or visit chrome://policy / edge://policy and reload policies.
pause
"@
  Set-Content -LiteralPath (Join-Path $publishDir "install-managed-extension.bat") -Value $batchInstaller -Encoding ASCII

  $indexHtml = @"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Browser PDF Webhook Sender</title>
    <style>
      body {
        color: #172033;
        font-family: Arial, sans-serif;
        line-height: 1.5;
        margin: 0;
        background: #f6f8fb;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 20px;
      }
      section {
        background: #fff;
        border: 1px solid #d9e1ee;
        border-radius: 8px;
        margin: 16px 0;
        padding: 20px;
      }
      h1, h2 {
        line-height: 1.2;
      }
      .button {
        display: inline-block;
        background: #005eb8;
        border-radius: 6px;
        color: #fff;
        font-weight: 700;
        margin: 8px 8px 8px 0;
        padding: 12px 16px;
        text-decoration: none;
      }
      code, pre {
        background: #eef2f7;
        border-radius: 6px;
      }
      code {
        padding: 2px 5px;
      }
      pre {
        overflow-x: auto;
        padding: 12px;
      }
      .muted {
        color: #526070;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser PDF Webhook Sender</h1>
      <p class="muted">Version $version &middot; Extension ID <code>$extensionId</code></p>

      <section>
        <h2>Install or Update</h2>
        <p>Download the Windows installer, then right-click it and choose <strong>Run as administrator</strong>. It configures Chrome and Edge to install this managed extension and receive future updates from this page.</p>
        <p><a class="button" href="./install-managed-extension.bat">Download installer</a></p>
        <p class="muted">Already installed with this managed installer? Restart Chrome or Edge after a new version is published. Running this installer again is safe and refreshes the browser policy.</p>
      </section>

      <section>
        <h2>Administrator Command</h2>
        <p>Run this in an elevated PowerShell window:</p>
        <pre>powershell -ExecutionPolicy Bypass -Command "irm '$installerPs1Url' | iex"</pre>
      </section>

      <section>
        <h2>Files</h2>
        <ul>
          <li><a href="./update.xml">update.xml</a></li>
          <li><a href="./$packageSlug-$version.crx">$packageSlug-$version.crx</a></li>
          <li><a href="./install-managed-extension.ps1">install-managed-extension.ps1</a></li>
          <li><a href="./install-managed-extension.bat">install-managed-extension.bat</a></li>
        </ul>
        <p class="muted">Chrome and Edge do not allow true one-click installs for extensions hosted outside their stores. This managed installer is the supported internal install/update path.</p>
      </section>
    </main>
  </body>
</html>
"@
  Set-Content -LiteralPath (Join-Path $publishDir "index.html") -Value $indexHtml -Encoding UTF8

  Write-Host "Extension ID: $extensionId"
  Write-Host "Version:      $version"
  Write-Host "Update URL:   $updateUrl"
  Write-Host "CRX URL:      $crxUrl"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
