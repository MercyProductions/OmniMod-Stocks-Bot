function ConvertTo-OmniModUtc($Value) {
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    return [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Wait-OmniModChild($Child) {
    # Start-Process can otherwise lose access to ExitCode after a short-lived child.
    $null = $Child.Handle
    $Child.WaitForExit()
    $Child.Refresh()
    if ($null -eq $Child.ExitCode) { throw 'Child exit code is unavailable; cannot report successful execution.' }
    return [int]$Child.ExitCode
}

function Get-OmniModOwnerAction($Owner, [string]$Bot, [string]$Machine, [DateTime]$BootTime, $ProcessInfo, [string]$NodePath) {
    if (!$Owner) { return 'start' }
    if ($Owner.bot -ne $Bot -or $Owner.host -ne $Machine -or [string]$Owner.nonce -notmatch '^[a-fA-F0-9-]{36}$' -or [long]$Owner.pid -le 0) {
        throw 'Lock identity is invalid or belongs to another host; manual inspection required.'
    }
    $ownerStarted = ConvertTo-OmniModUtc $Owner.startedAt
    if ($ownerStarted -lt $BootTime.ToUniversalTime()) {
        # A proven intervening OS boot establishes that this old owner and its children
        # cannot still be running. Never use mere heartbeat age as that evidence.
        return 'archive_previous_boot_lock'
    }
    if (!$ProcessInfo) { throw 'Owner disappeared during this OS boot; inspect possible scanner children and paper state before recovery.' }
    $birthDelta = [Math]::Abs(((ConvertTo-OmniModUtc $ProcessInfo.CreationDate) - $ownerStarted).TotalSeconds)
    if ($birthDelta -gt 5 -or $ProcessInfo.ExecutablePath -ne $NodePath -or $ProcessInfo.CommandLine -notmatch ' --env-file-if-exists=\.env app\.js\s*$') {
        throw 'Recorded PID is not the verified bot process; no process was stopped or launched.'
    }
    return 'adopt'
}
