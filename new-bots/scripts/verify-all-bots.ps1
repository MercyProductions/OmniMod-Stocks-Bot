$ErrorActionPreference = 'Continue'
$newBotsRoot = Split-Path -Parent $PSScriptRoot
$uploadRoot = Split-Path -Parent $newBotsRoot
$projects = @(
    @{ Name = 'new-bots workspace (shared + Forex + Futures + Options + ETFs/ETPs)'; Path = $newBotsRoot },
    @{ Name = 'Stocks'; Path = Join-Path $uploadRoot 'stocks-bot' },
    @{ Name = 'Crypto'; Path = Join-Path $uploadRoot 'crypto-bot' }
)
$failures = [System.Collections.Generic.List[string]]::new()

foreach ($project in $projects) {
    if (-not (Test-Path -LiteralPath (Join-Path $project.Path 'package.json'))) {
        $failures.Add("$($project.Name): project package.json is missing")
        continue
    }

    foreach ($scriptName in @('test', 'check')) {
        Write-Host "`n=== $($project.Name): npm run $scriptName ==="
        Push-Location -LiteralPath $project.Path
        try {
            if ($scriptName -eq 'test') {
                & npm test
            } else {
                & npm run check
            }
            if ($LASTEXITCODE -ne 0) {
                $failures.Add("$($project.Name): $scriptName exited with code $LASTEXITCODE")
            }
        } catch {
            $failures.Add("$($project.Name): $scriptName failed: $($_.Exception.Message)")
        } finally {
            Pop-Location
        }
    }
}

if ($env:OS -eq 'Windows_NT') {
    Write-Host "`n=== Windows Discord launcher policy and real child-exit checks ==="
    & (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'test-windows-discord-runtime.ps1')
    if ($LASTEXITCODE -ne 0) { $failures.Add("Windows Discord launcher checks exited with code $LASTEXITCODE") }
}

if ($failures.Count -gt 0) {
    Write-Host "`nSix-market verification failed:"
    $failures | ForEach-Object { Write-Host "- $_" }
    exit 1
}

Write-Host "`nSix-market verification passed: all configured test and syntax-check commands completed successfully."
