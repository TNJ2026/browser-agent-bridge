param (
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path "$PSScriptRoot\.."
$EnvFile = "$env:USERPROFILE\.browser-agent-bridge.env"

# 1. Ensure security token env file exists
if (-not (Test-Path $EnvFile)) {
    $bytes = New-Object Byte[] 16
    [System.Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
    $token = [System.Convert]::ToHexString($bytes).ToLower()
    Set-Content -Path $EnvFile -Value "BROWSER_AGENT_BRIDGE_TOKEN=$token" -Encoding utf8
    Write-Host "Security token generated and saved in $EnvFile"
}

# 2. Paths definitions
$HostWrapper = Join-Path $RootDir "native\host-wrapper.win.bat"
$ManifestSrc = Join-Path $RootDir "native\com.local.browser_agent_bridge.json"
$ManifestDstDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\NativeMessagingHosts"
$ManifestDst = Join-Path $ManifestDstDir "com.local.browser_agent_bridge.json"

if (-not (Test-Path $ManifestDstDir)) {
    New-Item -ItemType Directory -Path $ManifestDstDir -Force | Out-Null
}

# 3. Format paths for JSON compatibility (escaping backslashes)
$EscapedHostWrapper = $HostWrapper.Replace("\", "\\")

# 4. Generate the target manifest JSON
$ManifestContent = Get-Content $ManifestSrc -Raw
$ManifestContent = $ManifestContent -replace "__HOST_PATH__", $EscapedHostWrapper
$ManifestContent = $ManifestContent -replace "__EXTENSION_ID__", $ExtensionId
Set-Content -Path $ManifestDst -Value $ManifestContent -Encoding utf8

# 5. Register in Windows Registry
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.local.browser_agent_bridge"
if (-not (Test-Path $RegistryPath)) {
    New-Item -Path $RegistryPath -Force | Out-Null
}
Set-ItemProperty -Path $RegistryPath -Name "(default)" -Value $ManifestDst -Force

Write-Host "Installed Windows Native Messaging Host:"
Write-Host "Registry registered pointing to: $ManifestDst"
Write-Host "Host launcher: $HostWrapper"
