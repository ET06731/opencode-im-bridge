[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$BunPath,
  [string]$ConfigId,
  [string]$OpencodePath
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $scriptRoot = Split-Path -Parent $PSCommandPath
  $RepoRoot = Split-Path -Parent $scriptRoot
}

if (-not $BunPath) {
  $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bunCommand) {
    throw "Could not find 'bun' in PATH. Install Bun first or pass -BunPath."
  }
  $BunPath = $bunCommand.Source
}

if (-not $OpencodePath) {
  $opencodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
  if (-not $opencodeCommand) {
    throw "Could not find 'opencode' in PATH. Install opencode first or pass -OpencodePath."
  }
  $OpencodePath = $opencodeCommand.Source
}

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repository root does not exist: $RepoRoot"
}

Set-Location -LiteralPath $RepoRoot

# Start opencode serve first
$opencodeServeJob = Start-Job -ScriptBlock {
  param($RepoRoot, $OpencodePath)
  Set-Location -LiteralPath $RepoRoot
  $env:OPENCODE_SERVER_PORT = "4096"
  & $OpencodePath "serve" 2>&1 | Out-Null
} -ArgumentList $RepoRoot, $OpencodePath

# Wait for opencode serve to be ready (check port 4096)
$retry = 0
$maxRetry = 30
$serveReady = $false
while ($retry -lt $maxRetry) {
  try {
    $conn = Test-NetConnection -ComputerName "localhost" -Port 4096 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    if ($conn.TcpTestSucceeded) {
      $serveReady = $true
      break
    }
  } catch {}
  Start-Sleep -Seconds 1
  $retry++
}

if (-not $serveReady) {
  Write-Output "[opencode-lark] Warning: opencode serve may not be ready, proceeding anyway..."
} else {
  Write-Output "[opencode-lark] opencode serve is ready."
}

# Start the bridge
if ($ConfigId) {
    & $BunPath "run" "src/index.ts" "--config" $ConfigId
} else {
    & $BunPath "run" "src/index.ts"
}

# Cleanup
if ($opencodeServeJob) {
  Stop-Job -Job $opencodeServeJob -ErrorAction SilentlyContinue
  Remove-Job -Job $opencodeServeJob -ErrorAction SilentlyContinue
}
