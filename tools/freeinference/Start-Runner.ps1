param([switch]$Resume)
$ErrorActionPreference = 'Stop'
$taskProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskRuntime = Join-Path $env:USERPROFILE '.codex\odd-ecosys-runtime'
$taskLocationFile = Join-Path $env:USERPROFILE '.codex\odd-ecosys-runtime-location.json'
if (Test-Path -LiteralPath $taskLocationFile) { $taskRuntime = (Get-Content -LiteralPath $taskLocationFile -Raw | ConvertFrom-Json).runtime }
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskArguments = @('"' + (Join-Path $PSScriptRoot 'runner.mjs') + '"')
if ($Resume) { $taskArguments += '--resume' }
Start-Process -FilePath $taskNode -ArgumentList $taskArguments -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRuntime 'supervisor.stdout.log') -RedirectStandardError (Join-Path $taskRuntime 'supervisor.stderr.log')
Write-Output 'Runner started in background. Use npm run runner:status for progress.'
