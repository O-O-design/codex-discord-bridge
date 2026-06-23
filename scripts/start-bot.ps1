$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot ".bot.pid"
$stdoutLog = Join-Path $projectRoot "bot.stdout.log"
$stderrLog = Join-Path $projectRoot "bot.stderr.log"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path -LiteralPath $pidFile) {
  $savedPid = [int](Get-Content -Raw -LiteralPath $pidFile)
  $existing = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Rin-Ye Bot is already online (PID $savedPid)."
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
} else {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "Node.js was not found."
  }
  $node = $nodeCommand.Source
}

$process = Start-Process `
  -FilePath $node `
  -ArgumentList "src\bot.js" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
Start-Sleep -Seconds 3
$process.Refresh()

if ($process.HasExited) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Rin-Ye Bot failed to start."
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 20
  }
  exit 1
}

Write-Host "Rin-Ye Bot is online (PID $($process.Id))."
