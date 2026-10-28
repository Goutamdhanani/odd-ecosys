[CmdletBinding()]
param(
    [switch]$EnableApprovedProspectingIntegration,
    [switch]$SelfCheckStatusProfiles
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$fixtureDir = Join-Path $repo '.runner/astra-qa/r18-customer-preview'
$privateStatePath = Join-Path $fixtureDir 'preview-state-3212.json'
$publicStatePath = Join-Path $repo '.superpowers/r18/preview/local-preview-r18.json'
$fixturePath = Join-Path $fixtureDir 'pg.json'
$statusUri = 'http://127.0.0.1:3212/__preview/status'
$previewScript = [System.IO.Path]::GetFullPath((Join-Path $repo 'tools/astra/local-preview.mjs'))
$runtimeDir = Join-Path $fixtureDir 'launcher'
$readbackPath = Join-Path $repo '.superpowers/astra-discovery-runtime/latest-provider-response.json'

function Read-JsonFile([string]$Path, [string]$Failure) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw $Failure
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw $Failure
    }
}

function Test-PreviewListener {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', 3212)
        return $pending.Wait(600) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Get-PreviewStatus {
    try {
        return Invoke-RestMethod -Method Get -Uri $statusUri -TimeoutSec 2
    }
    catch {
        return $null
    }
}

function Convert-ApprovalExpiry($Value) {
    if ($Value -is [DateTimeOffset]) {
        return $Value.ToUniversalTime()
    }
    if ($Value -is [DateTime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
            throw 'The approval expiry has no timezone.'
        }
        return ([DateTimeOffset]$Value).ToUniversalTime()
    }
    if ($Value -is [string]) {
        $text = $Value.Trim()
        if ($text -notmatch '(?i)(?:Z|[+-]\d{2}:\d{2})$') {
            throw 'The approval expiry has no timezone.'
        }
        return [DateTimeOffset]::Parse(
            $text,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AdjustToUniversal
        )
    }
    throw 'The approval expiry type is unsupported.'
}

function Test-PreviewStatusProfile($Status, [string]$Profile) {
    if ($null -eq $Status -or $Status.tenantDatabase -ne 'disposable_fixture' -or $Status.outreach -ne 'disabled') {
        return $false
    }
    if ($Profile -eq 'offline') {
        return $Status.mode -eq 'synthetic-local-preview' -and
            $Status.externalActions -eq 'disabled' -and
            $Status.realData -eq $false
    }
    if ($Profile -eq 'restricted-prospecting') {
        return $Status.mode -eq 'isolated-prospecting-integration' -and
            $Status.externalActions -eq 'scoped_research_only' -and
            $Status.realData -eq $true
    }
    return $false
}

function Test-ExistingPreviewIdentity($Status, [string]$ExpectedProfile) {
    if ($null -eq $Status) {
        return $false
    }
    try {
        $private = Read-JsonFile $privateStatePath 'The private preview state is unavailable.'
        $public = Read-JsonFile $publicStatePath 'The public preview state is unavailable.'
        $fixture = Read-JsonFile $fixturePath 'The R18 preview fixture is unavailable.'
        $pidValue = [int]$public.pid
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
        $commandLine = [string]$processInfo.CommandLine
        $hasEntryPoint = $commandLine.IndexOf($previewScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $publicUrl = [Uri]$public.url
        return (
            $private.mode -eq 'synthetic-local-preview' -and
            $private.clusterFixture -eq $fixture.clusterFixture -and
            -not [string]::IsNullOrWhiteSpace([string]$private.tenant.tenantId) -and
            [string]$public.tenantId -eq [string]$private.tenant.tenantId -and
            [int]$public.pid -gt 0 -and
            $publicUrl.Host -eq '127.0.0.1' -and
            $publicUrl.Port -eq 3212 -and
            $publicUrl.AbsolutePath -eq '/growth.html' -and
            $null -ne $processInfo -and
            $hasEntryPoint -and
            $public.externalActions -eq $Status.externalActions -and
            (Test-PreviewStatusProfile $Status $ExpectedProfile)
        )
    }
    catch {
        return $false
    }
}

if ($SelfCheckStatusProfiles) {
    $cases = @(
        @{ Name = 'offline accepted'; Profile = 'offline'; Expected = $true; Status = [pscustomobject]@{ mode = 'synthetic-local-preview'; externalActions = 'disabled'; outreach = 'disabled'; tenantDatabase = 'disposable_fixture'; realData = $false } },
        @{ Name = 'restricted profile accepted'; Profile = 'restricted-prospecting'; Expected = $true; Status = [pscustomobject]@{ mode = 'isolated-prospecting-integration'; externalActions = 'scoped_research_only'; outreach = 'disabled'; tenantDatabase = 'disposable_fixture'; realData = $true } },
        @{ Name = 'restricted profile requires realData'; Profile = 'restricted-prospecting'; Expected = $false; Status = [pscustomobject]@{ mode = 'isolated-prospecting-integration'; externalActions = 'scoped_research_only'; outreach = 'disabled'; tenantDatabase = 'disposable_fixture'; realData = $false } },
        @{ Name = 'offline profile requires disabled actions'; Profile = 'offline'; Expected = $false; Status = [pscustomobject]@{ mode = 'synthetic-local-preview'; externalActions = 'scoped_research_only'; outreach = 'disabled'; tenantDatabase = 'disposable_fixture'; realData = $true } },
        @{ Name = 'outreach must stay disabled'; Profile = 'restricted-prospecting'; Expected = $false; Status = [pscustomobject]@{ mode = 'isolated-prospecting-integration'; externalActions = 'scoped_research_only'; outreach = 'enabled'; tenantDatabase = 'disposable_fixture'; realData = $true } }
    )
    foreach ($case in $cases) {
        $actual = Test-PreviewStatusProfile $case.Status $case.Profile
        if ($actual -ne $case.Expected) {
            throw "Status profile sanity case failed: $($case.Name)"
        }
    }
    $isoGrant = '{"expiresAt":"2031-04-05T12:13:14.1234567Z"}' | ConvertFrom-Json
    if ($isoGrant.expiresAt -isnot [DateTime] -and
        $isoGrant.expiresAt -isnot [DateTimeOffset] -and
        $isoGrant.expiresAt -isnot [string]) {
        throw "Expiry sanity case produced unsupported JSON type: $($isoGrant.expiresAt.GetType().FullName)"
    }
    $parsedExpiry = Convert-ApprovalExpiry $isoGrant.expiresAt
    if ($parsedExpiry.ToString('o') -ne '2031-04-05T12:13:14.1234567+00:00') {
        throw 'ISO expiry sanity case did not preserve its UTC instant.'
    }
    $naiveGrant = '{"expiresAt":"2031-04-05T12:13:14"}' | ConvertFrom-Json
    $naiveRejected = $false
    try {
        $null = Convert-ApprovalExpiry $naiveGrant.expiresAt
    }
    catch {
        $naiveRejected = $true
    }
    if (-not $naiveRejected) {
        throw 'Timezone-free expiry was unexpectedly accepted.'
    }
    Write-Output "Status/profile expiry sanity check passed: $($cases.Count) profile cases and 2 expiry cases."
    return
}

function Get-IntegrationBlockers {
    $blockers = [System.Collections.Generic.List[string]]::new()
    $profilePath = Join-Path $repo '.superpowers/astra-discovery-runtime/authorization.json'
    $usagePath = Join-Path $repo '.superpowers/astra-discovery-runtime/request-usage.json'
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
        $blockers.Add('The previously approved restricted prospecting profile is unavailable (authorization file missing).')
        return $blockers
    }
    if (-not (Test-Path -LiteralPath $usagePath -PathType Leaf)) {
        $blockers.Add('The restricted prospecting request ledger is unavailable; the launcher will not initialize or reset it.')
        return $blockers
    }
    try {
        $grant = Read-JsonFile $profilePath 'The previously approved restricted prospecting profile is invalid.'
        $usage = Read-JsonFile $usagePath 'The restricted prospecting request ledger is invalid.'
        $preview = Read-JsonFile $privateStatePath 'The existing isolated preview tenant is unavailable.'
        $now = [DateTimeOffset]::UtcNow
        try {
            $expires = Convert-ApprovalExpiry $grant.expiresAt
        }
        catch {
            $blockers.Add('The saved restricted prospecting approval expiry is invalid or has no timezone.')
            return $blockers
        }
        if ($grant.environment -ne 'isolated-integration') {
            $blockers.Add('The saved authorization is not for the isolated integration environment.')
        }
        if ($expires -le $now) {
            $blockers.Add('The saved restricted prospecting approval has expired.')
        }
        if ([int]$grant.maxRequests -ne 3) {
            $blockers.Add('The saved restricted prospecting approval does not match its pinned three-request limit.')
        }
        if ([string]::IsNullOrWhiteSpace([string]$preview.tenant.tenantId) -or
            @($grant.tenantIds) -notcontains [string]$preview.tenant.tenantId) {
            $blockers.Add('The saved approval does not include the existing isolated preview tenant.')
        }
        if (@($grant.sourceOrigins).Count -eq 0 -or
            @($grant.sourceOrigins | Where-Object { -not ([string]$_).StartsWith('https://') }).Count -gt 0) {
            $blockers.Add('The saved approval does not contain a valid HTTPS-only source allowlist.')
        }
        $budgets = @(
            @{ Name = 'catalog'; Maximum = 1 },
            @{ Name = 'inference'; Maximum = [int]$grant.maxRequests },
            @{ Name = 'search'; Maximum = 1 },
            @{ Name = 'websites'; Maximum = 6 }
        )
        foreach ($budget in $budgets) {
            $used = 0
            if ($null -ne $usage.($budget.Name)) {
                $used = [int]$usage.($budget.Name)
            }
            if ($used -lt 0 -or $used -gt $budget.Maximum) {
                $blockers.Add("The saved $($budget.Name) request ledger is outside its approved range.")
            }
            elseif ($used -eq $budget.Maximum) {
                Write-Warning "The approved $($budget.Name) request allowance is exhausted ($used of $($budget.Maximum)). The saved readback remains available; reserve() continues to deny new requests. The launcher will not increase or reset the allowance."
            }
        }
    }
    catch {
        $blockers.Add('The saved restricted prospecting approval or request ledger could not be validated.')
    }
    return $blockers
}

function Start-PreviewDatabaseKeeper([string]$RunDir) {
    $wslPathInput = $repo -replace '\\', '/'
    $wslRepoOutput = & wsl.exe -d Ubuntu-24.04 -- wslpath -a $wslPathInput 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($wslRepoOutput -join ''))) {
        throw 'Ubuntu-24.04 WSL is unavailable or could not resolve this repository path.'
    }
    $wslRepo = ($wslRepoOutput -join '').Trim()
    $helper = "$wslRepo/tools/astra/restore-customer-preview.py"
    $keeper = $null
    $keeperRecordPath = $null
    $stdoutLog = $null
    $stderrLog = $null
    if (Test-Path -LiteralPath $runtimeDir -PathType Container) {
        $records = Get-ChildItem -LiteralPath $runtimeDir -Filter 'postgres-keeper.json' -File -Recurse |
            Sort-Object LastWriteTime -Descending
        foreach ($candidate in $records) {
            try {
                $saved = Get-Content -LiteralPath $candidate.FullName -Raw | ConvertFrom-Json
                $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$saved.processId)" -ErrorAction Stop
                $commandLine = [string]$processInfo.CommandLine
                if ($processInfo.Name -eq 'wsl.exe' -and
                    $saved.fixtureLabel -eq 'r18-customer-preview' -and
                    $commandLine.Contains($helper) -and $commandLine.Contains('--keepalive') -and
                    $commandLine.Contains($wslRepo)) {
                    $keeper = Get-Process -Id ([int]$saved.processId) -ErrorAction Stop
                    $keeperRecordPath = $candidate.FullName
                    $stdoutLog = [string]$saved.stdoutLog
                    $stderrLog = [string]$saved.stderrLog
                    break
                }
            }
            catch {
                continue
            }
        }
    }
    if ($null -eq $keeper) {
        $stdoutLog = Join-Path $RunDir 'postgres-keeper.stdout.log'
        $stderrLog = Join-Path $RunDir 'postgres-keeper.stderr.log'
        $startArguments = @{
            FilePath = (Get-Command wsl.exe -ErrorAction Stop).Source
            ArgumentList = @('-d', 'Ubuntu-24.04', '--user', 'root', '--',
                'python3', $helper, '--repo', $wslRepo, '--keepalive')
            WindowStyle = 'Hidden'
            PassThru = $true
            RedirectStandardOutput = $stdoutLog
            RedirectStandardError = $stderrLog
        }
        $keeper = Start-Process @startArguments
        $keeperRecord = [ordered]@{
            fixtureLabel = 'r18-customer-preview'
            processId = $keeper.Id
            helper = 'tools/astra/restore-customer-preview.py'
            keepalive = $true
            startedAt = [DateTimeOffset]::Now.ToString('o')
            stdoutLog = $stdoutLog
            stderrLog = $stderrLog
        }
        $keeperRecordPath = Join-Path $RunDir 'postgres-keeper.json'
        $keeperRecord | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $keeperRecordPath -Encoding utf8
    }

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        $result = & wsl.exe -d Ubuntu-24.04 --user root -- python3 $helper --repo $wslRepo --check-only 2>$null
        $checkExit = $LASTEXITCODE
        if ($checkExit -eq 0) {
            $jsonLine = $result | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1
            if ($jsonLine) {
                $check = $jsonLine | ConvertFrom-Json
                if ($check.valid -and $check.alreadyRunning -and $check.loopbackReady -and $check.clockAligned -and
                    $check.realData -eq $false -and $check.migrationsRun -eq $false -and
                    $check.systemClockChanged -eq $false) {
                    return [pscustomobject]@{
                        ProcessId = $keeper.Id
                        RecordPath = $keeperRecordPath
                        StdoutLog = $stdoutLog
                        StderrLog = $stderrLog
                        LoopbackReady = $true
                    }
                }
            }
        }
        $keeper.Refresh()
        if ($keeper.HasExited) {
            break
        }
    }
    throw "The hidden WSL PostgreSQL keeper did not confirm fixture readiness. Its process record and private logs are retained under $RunDir; no process was killed."
}

function Write-LaunchRecord([int]$ProcessId, [string]$Mode, [string]$RunDir, $DatabaseKeeper) {
    $record = [ordered]@{
        mode = if ($Mode -eq 'restricted-prospecting') { 'isolated-prospecting-integration' } else { 'synthetic-local-preview' }
        fixtureLabel = 'r18-customer-preview'
        processId = $ProcessId
        previewPort = 3212
        integrationProfileRequested = ($Mode -eq 'restricted-prospecting')
        externalActions = if ($Mode -eq 'restricted-prospecting') { 'scoped_research_only' } else { 'disabled' }
        outreach = 'disabled'
        realData = ($Mode -eq 'restricted-prospecting')
        databaseKeeperProcessId = $DatabaseKeeper.ProcessId
        databaseKeeperRecord = $DatabaseKeeper.RecordPath
        databaseKeeperStdoutLog = $DatabaseKeeper.StdoutLog
        databaseKeeperStderrLog = $DatabaseKeeper.StderrLog
        startedAt = [DateTimeOffset]::Now.ToString('o')
        stdoutLog = Join-Path $RunDir 'preview.stdout.log'
        stderrLog = Join-Path $RunDir 'preview.stderr.log'
    }
    $recordPath = Join-Path $RunDir 'launch.json'
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $recordPath -Encoding utf8
    return $recordPath
}

if (-not (Test-Path -LiteralPath $previewScript -PathType Leaf)) {
    throw 'The existing local-preview entry point is unavailable.'
}
if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
    throw 'The recognized R18 customer-preview fixture is unavailable.'
}

$existingStatus = Get-PreviewStatus
if (Test-PreviewListener) {
    $activeProfile = if ($existingStatus.mode -eq 'isolated-prospecting-integration') { 'restricted-prospecting' } else { 'offline' }
    if (Test-ExistingPreviewIdentity $existingStatus $activeProfile) {
        if ($EnableApprovedProspectingIntegration -and $activeProfile -ne 'restricted-prospecting') {
            throw 'A recognized offline R18 preview already occupies port 3212. The launcher will not replace or stop it to change profiles.'
        }
        if (-not $EnableApprovedProspectingIntegration -and $activeProfile -eq 'restricted-prospecting') {
            Write-Output 'The recognized R18 preview is already healthy in its previously enabled restricted integration profile. No process or request was changed.'
        }
        else {
            Write-Output 'The recognized R18 customer prototype is already healthy at http://127.0.0.1:3212/growth.html. No process or request was changed.'
        }
        return
    }
    throw 'Port 3212 is occupied by a process whose preview identity cannot be proven. It was left untouched.'
}

$mode = 'offline'
if ($EnableApprovedProspectingIntegration) {
    $blockers = @(Get-IntegrationBlockers)
    if ($blockers.Count -gt 0) {
        $detail = $blockers -join ' '
        if (Test-Path -LiteralPath $readbackPath -PathType Leaf) {
            $detail += " Existing sanitized provider readback is preserved at $readbackPath."
        }
        throw $detail
    }
    $mode = 'restricted-prospecting'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $runtimeDir "launch-$stamp"
New-Item -ItemType Directory -Path $runDir -ErrorAction Stop | Out-Null
$stdoutLog = Join-Path $runDir 'preview.stdout.log'
$stderrLog = Join-Path $runDir 'preview.stderr.log'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'node.exe is unavailable; no database keeper or preview process was started.'
}
$databaseKeeper = Start-PreviewDatabaseKeeper $runDir

# Give the existing preview process only its documented minimal runtime
# environment and explicit fixture selectors. Restore this PowerShell process'
# environment immediately after the detached child has inherited the values.
$savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
$allowedEnvironment = @('PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP')
try {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ($allowedEnvironment -notcontains [string]$name) {
            [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
        }
    }
    [Environment]::SetEnvironmentVariable('ODD_PREVIEW_PORT', '3212', 'Process')
    [Environment]::SetEnvironmentVariable('ODD_PREVIEW_TENANT', '1', 'Process')
    [Environment]::SetEnvironmentVariable('ODD_PREVIEW_FIXTURE_LABEL', 'r18-customer-preview', 'Process')
    if ($mode -eq 'restricted-prospecting') {
        [Environment]::SetEnvironmentVariable('ODD_PREVIEW_PROSPECTING_INTEGRATION', 'true', 'Process')
    }
    else {
        [Environment]::SetEnvironmentVariable('ODD_PREVIEW_PROSPECTING_INTEGRATION', $null, 'Process')
    }
    $startArguments = @{
        FilePath = $nodeCommand.Source
        ArgumentList = @($previewScript)
        WorkingDirectory = $repo
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = $stdoutLog
        RedirectStandardError = $stderrLog
    }
    $process = Start-Process @startArguments
}
finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    $status = Get-PreviewStatus
    if ($null -ne $status -and
        (Test-ExistingPreviewIdentity $status $mode)) {
        $ready = $true
        break
    }
    $process.Refresh()
    if ($process.HasExited) {
        break
    }
}

if (-not $ready) {
    throw "The hidden preview process did not reach a provable healthy status. Process ID $($process.Id) and its private logs are retained under $runDir; no process was killed."
}

$recordPath = Write-LaunchRecord $process.Id $mode $runDir $databaseKeeper
Write-Output 'R18 customer prototype is healthy at http://127.0.0.1:3212/growth.html.'
Write-Output "Detached process ID: $($process.Id). Private launch record: $recordPath."
Write-Output "Hidden WSL PostgreSQL keeper process ID: $($databaseKeeper.ProcessId)."
Write-Output 'Outreach remains disabled. In offline mode, external actions remain disabled.'
if ($mode -eq 'restricted-prospecting') {
    Write-Output 'The restricted integration profile is active with realData=true. Outreach remains disabled; exhausted request categories remain blocked by existing reserve() guards while saved readbacks and campaign preparation remain available.'
}
