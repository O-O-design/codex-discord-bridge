$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

function Stop-ManagedProcess {
  param(
    [string] $Name,
    [string] $PidFile
  )

  if (-not (Test-Path $PidFile)) {
    Write-Host "$Name is not running."
    return
  }

  $processId = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if ($processId) {
    $process = Get-Process -Id ([int] $processId) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Write-Host "Stopped $Name (PID $processId)."
    } else {
      Write-Host "$Name process was already gone."
    }
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-ManagedProcess -Name "monitor" -PidFile "state\windows-monitor.pid"
Stop-ManagedProcess -Name "Discord bridge" -PidFile "state\windows-bridge.pid"

Write-Host "Codex Discord Bridge stopped."
