param(
    [Parameter(Mandatory=$true)][ValidateSet('forex','futures','options','etfs-etps')][string]$Bot,
    [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-discord-runtime.ps1')
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$botDirectory = Join-Path $workspace $Bot
$dataDirectory = Join-Path $botDirectory 'data'
$lockPath = Join-Path $dataDirectory 'discord-application.lock'
$launcherLock = $null
$launcherLog = Join-Path $dataDirectory 'windows-launcher.log'
function Write-LauncherLog([string]$Event, [string]$Detail) {
    if ((Test-Path -LiteralPath $launcherLog) -and (Get-Item -LiteralPath $launcherLog).Length -gt 1048576) {
        $previous = "$launcherLog.previous"
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous }
        Move-Item -LiteralPath $launcherLog -Destination $previous
    }
    @{ at=[DateTime]::UtcNow.ToString('o'); bot=$Bot; event=$Event; detail=$Detail } | ConvertTo-Json -Compress | Add-Content -LiteralPath $launcherLog -Encoding UTF8
}
try {
    if (!(Test-Path -LiteralPath $NodePath -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $botDirectory 'app.js') -PathType Leaf)) { throw 'Configured executable or application entry is missing.' }
    [void][IO.Directory]::CreateDirectory($dataDirectory)
    # FileShare.None is an OS lock. A dead launcher cannot leave it held after reboot.
    try { $launcherLock = [IO.File]::Open((Join-Path $dataDirectory 'windows-launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { exit 0 } # An existing launcher already supervises this market.
    $owner = if (Test-Path -LiteralPath $lockPath) { Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } else { $null }
    $processInfo = if ($owner) { Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$owner.pid)" } else { $null }
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    $action = Get-OmniModOwnerAction -Owner $owner -Bot $Bot -Machine $env:COMPUTERNAME -BootTime $boot -ProcessInfo $processInfo -NodePath $NodePath
    if ($action -eq 'adopt') {
        $existing = Get-Process -Id $owner.pid
        if ([Math]::Abs(((ConvertTo-OmniModUtc $existing.StartTime) - (ConvertTo-OmniModUtc $owner.startedAt)).TotalSeconds) -gt 5) { throw 'Owner changed before adoption.' }
        Write-LauncherLog 'adopted_existing_process' ([string]$owner.pid)
        $existing.WaitForExit()
        if (Test-Path -LiteralPath $lockPath) { throw 'Adopted process exited without releasing its lock; manual recovery required.' }
        Write-LauncherLog 'adopted_process_stopped' ([string]$owner.pid)
        exit 0
    }
    if ($action -eq 'archive_previous_boot_lock') {
        $current = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if ($current.nonce -ne $owner.nonce) { throw 'Lock owner changed before previous-boot recovery.' }
        $archive = Join-Path $dataDirectory ("discord-application.previous-boot-" + $owner.nonce + '.json')
        if (Test-Path -LiteralPath $archive) { throw 'Prior recovery archive already exists; inspect state.' }
        Move-Item -LiteralPath $lockPath -Destination $archive
        Write-LauncherLog 'previous_boot_lock_archived' 'No paper ledger lock or position was modified.'
    }
    Write-LauncherLog 'starting' 'Separate Discord gateway and existing scanner scheduler.'
    $child = Start-Process -FilePath $NodePath -ArgumentList '--env-file-if-exists=.env app.js' -WorkingDirectory $botDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $dataDirectory 'discord-stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'discord-stderr.log')
    @{ bot=$Bot; pid=$child.Id; startedAt=[DateTime]::UtcNow.ToString('o'); launcher='windows-task' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDirectory 'discord-launch.json') -Encoding UTF8
    $code = Wait-OmniModChild $child
    Write-LauncherLog 'process_exited' ([string]$code)
    exit $code
} catch {
    if (Test-Path -LiteralPath $dataDirectory) { Write-LauncherLog 'failed' $_.Exception.Message }
    exit 1
} finally { if ($launcherLock) { $launcherLock.Dispose() } }
