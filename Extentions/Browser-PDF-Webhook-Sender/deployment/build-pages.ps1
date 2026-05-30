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

  $indexHtml = @"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Browser PDF Webhook Sender</title>
  </head>
  <body>
    <h1>Browser PDF Webhook Sender</h1>
    <p>Version: $version</p>
    <p>Extension ID: <code>$extensionId</code></p>
    <ul>
      <li><a href="./update.xml">update.xml</a></li>
      <li><a href="./$packageSlug-$version.crx">$packageSlug-$version.crx</a></li>
      <li><a href="./install-managed-extension.ps1">install-managed-extension.ps1</a></li>
    </ul>
    <p>Install command, run as Administrator:</p>
    <pre>powershell -ExecutionPolicy Bypass -Command "irm '$pagesBase/$relativeDir/install-managed-extension.ps1' | iex"</pre>
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
