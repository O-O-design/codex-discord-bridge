param(
  [ValidateSet("monitor", "widget", "none")]
  [string] $View = "monitor"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
New-Item -ItemType Directory -Force -Path "state" | Out-Null

function Require-Command {
  param([string] $Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Read-DotEnv {
  param([string] $Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }

    $index = $trimmed.IndexOf("=")
    if ($index -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim().Trim('"').Trim("'")
    $values[$key] = $value
  }

  return $values
}

function Get-MonitorPort {
  $envValues = Read-DotEnv ".env"

  if ($envValues.ContainsKey("MONITOR_PORT") -and $envValues["MONITOR_PORT"]) {
    return $envValues["MONITOR_PORT"]
  }

  return "3899"
}

function Test-PidFileRunning {
  param([string] $Path)

  if (-not (Test-Path $Path)) {
    return $false
  }

  $processId = (Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if (-not $processId) {
    return $false
  }

  return [bool](Get-Process -Id ([int] $processId) -ErrorAction SilentlyContinue)
}

function Start-ManagedProcess {
  param(
    [string] $Name,
    [string] $Command,
    [string[]] $Arguments,
    [string] $PidFile,
    [string] $StdoutFile,
    [string] $StderrFile
  )

  if (Test-PidFileRunning $PidFile) {
    Write-Host "$Name is already running."
    return
  }

  $process = Start-Process `
    -FilePath $Command `
    -ArgumentList $Arguments `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $StdoutFile `
    -RedirectStandardError $StderrFile `
    -WindowStyle Minimized `
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id
  Write-Host "Started $Name (PID $($process.Id))."
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example."
  Write-Host "Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, and channel allowlists, then run this script again."
  exit 1
}

Require-Command "node"
Require-Command "npm.cmd"

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
}

if (-not (Test-Path "state\codex-session")) {
  Write-Host "Seeding Codex session..."
  & npm.cmd run seed
  if ($LASTEXITCODE -ne 0) {
    throw "npm run seed failed. Make sure Codex CLI is installed and signed in."
  }
}

Start-ManagedProcess `
  -Name "Discord bridge" `
  -Command "npm.cmd" `
  -Arguments @("start") `
  -PidFile "state\windows-bridge.pid" `
  -StdoutFile "logs\bridge.out" `
  -StderrFile "logs\bridge.err"

Start-ManagedProcess `
  -Name "monitor" `
  -Command "npm.cmd" `
  -Arguments @("run", "monitor") `
  -PidFile "state\windows-monitor.pid" `
  -StdoutFile "logs\monitor.out" `
  -StderrFile "logs\monitor.err"

if ($View -ne "none") {
  $path = if ($View -eq "widget") { "/widget" } else { "" }
  $url = "http://127.0.0.1:$(Get-MonitorPort)$path"
  Write-Host "Opening $url"
  Start-Process $url
}

Write-Host "Codex Discord Bridge is running."
Write-Host "Use Stop-Windows-Bridge.cmd to stop it."
