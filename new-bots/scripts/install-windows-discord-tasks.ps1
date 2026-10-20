[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$shellPath = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$launcher = Join-Path $PSScriptRoot 'run-windows-discord-bot.ps1'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$version = & $nodePath --version
if ([version]$version.TrimStart('v') -lt [version]'22.9.0') { throw 'These applications require Node 22.9 or newer.' }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
foreach ($botName in @('forex','futures','options','etfs-etps')) {
    $name = "OmniMod-$botName-Discord"
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '" -Bot ' + $botName + ' -NodePath "' + $nodePath + '"'
    $action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $workspace
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $shellPath -or $existing.Actions[0].Arguments -ne $arguments) {
            throw "Existing task $name differs; inspect before replacing it."
        }
        Write-Output "$name already has the expected action; inspect settings before updating."
        continue
    }
    if ($PSCmdlet.ShouldProcess($name, 'Register a separate limited-user Discord application task at sign-in')) {
        Register-ScheduledTask -TaskName $name -Description "OmniMod $botName paper-research Discord application. User sign-in required; no live trading. Use the project shutdown command before maintenance." `
            -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
        Write-Output "$name registered for current-user sign-in."
    }
}
