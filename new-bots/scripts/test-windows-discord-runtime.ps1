$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-discord-runtime.ps1')
$utc = [DateTime]::Parse('2026-10-02T06:00:00Z').ToUniversalTime()
$owner = @{ bot='forex'; host='test'; pid=123; nonce='00000000-0000-0000-0000-000000000000'; startedAt=$utc.ToString('o') }
$processInfo = @{ CreationDate=$utc; ExecutablePath='node.exe'; CommandLine='node.exe --env-file-if-exists=.env app.js' }
function Assert-Equal($Actual, $Expected) { if ($Actual -ne $Expected) { throw "Expected $Expected; got $Actual" } }
function Assert-Rejected([scriptblock]$Call) { $rejected=$false; try { & $Call | Out-Null } catch { $rejected=$true }; if (!$rejected) { throw 'Unsafe owner should have been rejected.' } }
Assert-Equal (Get-OmniModOwnerAction $null 'forex' 'test' $utc $null 'node.exe') 'start'
Assert-Equal (Get-OmniModOwnerAction $owner 'forex' 'test' $utc.AddHours(-1) $processInfo 'node.exe') 'adopt'
Assert-Equal (Get-OmniModOwnerAction $owner 'forex' 'test' $utc.AddHours(1) $null 'node.exe') 'archive_previous_boot_lock'
Assert-Rejected { Get-OmniModOwnerAction $owner 'forex' 'test' $utc.AddHours(-1) $null 'node.exe' }
Assert-Rejected { Get-OmniModOwnerAction $owner 'forex' 'other-host' $utc.AddHours(-1) $processInfo 'node.exe' }
Assert-Rejected { Get-OmniModOwnerAction $owner 'options' 'test' $utc.AddHours(-1) $processInfo 'node.exe' }
$processInfo.CreationDate = $utc.AddHours(1)
Assert-Rejected { Get-OmniModOwnerAction $owner 'forex' 'test' $utc.AddHours(-1) $processInfo 'node.exe' }
Assert-Equal (ConvertTo-OmniModUtc $utc) (ConvertTo-OmniModUtc $utc.ToString('o'))
$nodePath = (Get-Command node).Source
$child = Start-Process -FilePath $nodePath -ArgumentList '-e','setTimeout(()=>process.exit(7),100)' -PassThru -WindowStyle Hidden
Assert-Equal (Wait-OmniModChild $child) 7
Write-Output 'Windows launcher checks passed: 9 (including a real nonzero child exit).'
