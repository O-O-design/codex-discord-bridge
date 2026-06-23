$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot ".bot.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "No tracked Rin-Ye Bot process was found."
  exit 0
}

$savedPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue

if ($process) {
  Stop-Process -Id $savedPid
  $process.WaitForExit(5000) | Out-Null
  Write-Host "Rin-Ye Bot is offline."
} else {
  Write-Host "Rin-Ye Bot was already offline."
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
