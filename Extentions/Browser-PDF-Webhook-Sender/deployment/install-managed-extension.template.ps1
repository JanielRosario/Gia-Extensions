param(
  [ValidateSet("Machine", "User")]
  [string]$Scope = "Machine",

  [switch]$ChromeOnly,
  [switch]$EdgeOnly,

  [string]$ExtensionId = "__EXTENSION_ID__",
  [string]$UpdateUrl = "__UPDATE_URL__"
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-ForceInstallEntry {
  param(
    [string]$PolicyPath,
    [string]$BrowserName
  )

  if (!(Test-Path -LiteralPath $PolicyPath)) {
    New-Item -Path $PolicyPath -Force | Out-Null
  }

  $value = "$ExtensionId;$UpdateUrl"
  $properties = Get-ItemProperty -LiteralPath $PolicyPath
  $numericProperties = $properties.PSObject.Properties |
    Where-Object { $_.Name -match '^\d+$' } |
    Sort-Object { [int]$_.Name }
  $existing = $numericProperties |
    Where-Object { "$($_.Value)".StartsWith("$ExtensionId;") } |
    Select-Object -First 1

  if ($existing) {
    New-ItemProperty -LiteralPath $PolicyPath -Name $existing.Name -Value $value -PropertyType String -Force | Out-Null
    Write-Host "$BrowserName policy updated at slot $($existing.Name)."
    return
  }

  $nextIndex = 1

  if ($numericProperties.Count -gt 0) {
    $nextIndex = ([int]($numericProperties | Select-Object -Last 1).Name) + 1
  }

  New-ItemProperty -LiteralPath $PolicyPath -Name "$nextIndex" -Value $value -PropertyType String -Force | Out-Null
  Write-Host "$BrowserName policy added at slot $nextIndex."
}

function Set-ExtensionSettingsPolicy {
  param(
    [string]$BrowserPolicyPath,
    [string]$BrowserName
  )

  if (!(Test-Path -LiteralPath $BrowserPolicyPath)) {
    New-Item -Path $BrowserPolicyPath -Force | Out-Null
  }

  $existingSettings = @{}
  $existingValue = (Get-ItemProperty -LiteralPath $BrowserPolicyPath -Name "ExtensionSettings" -ErrorAction SilentlyContinue).ExtensionSettings

  if (![string]::IsNullOrWhiteSpace($existingValue)) {
    try {
      $existingObject = $existingValue | ConvertFrom-Json
      foreach ($property in $existingObject.PSObject.Properties) {
        $existingSettings[$property.Name] = $property.Value
      }
    } catch {
      Write-Warning "$BrowserName ExtensionSettings policy exists but is not valid JSON. Replacing it."
    }
  }

  $existingSettings[$ExtensionId] = [ordered]@{
    installation_mode = "force_installed"
    update_url = $UpdateUrl
    override_update_url = $true
  }

  $settingsJson = $existingSettings | ConvertTo-Json -Depth 20 -Compress
  New-ItemProperty `
    -LiteralPath $BrowserPolicyPath `
    -Name "ExtensionSettings" `
    -Value $settingsJson `
    -PropertyType String `
    -Force | Out-Null

  Write-Host "$BrowserName ExtensionSettings policy updated."
}

if ($Scope -eq "Machine" -and !(Test-IsAdmin)) {
  throw "Machine-scope install requires running PowerShell as Administrator."
}

if ($ExtensionId -match "__" -or $UpdateUrl -match "__") {
  throw "This installer still has template placeholders. Use the generated installer from GitHub Pages."
}

$policyRoot = if ($Scope -eq "Machine") {
  "HKLM:\SOFTWARE\Policies"
} else {
  "HKCU:\SOFTWARE\Policies"
}

$installChrome = !$EdgeOnly
$installEdge = !$ChromeOnly

if ($installChrome) {
  Set-ForceInstallEntry `
    -PolicyPath "$policyRoot\Google\Chrome\ExtensionInstallForcelist" `
    -BrowserName "Chrome"
  Set-ExtensionSettingsPolicy `
    -BrowserPolicyPath "$policyRoot\Google\Chrome" `
    -BrowserName "Chrome"
}

if ($installEdge) {
  Set-ForceInstallEntry `
    -PolicyPath "$policyRoot\Microsoft\Edge\ExtensionInstallForcelist" `
    -BrowserName "Edge"
  Set-ExtensionSettingsPolicy `
    -BrowserPolicyPath "$policyRoot\Microsoft\Edge" `
    -BrowserName "Edge"
}

Write-Host ""
Write-Host "Managed extension install policy is configured."
Write-Host "Extension ID: $ExtensionId"
Write-Host "Update URL:   $UpdateUrl"
Write-Host ""
Write-Host "Restart Chrome/Edge or visit chrome://policy / edge://policy and reload policies."
