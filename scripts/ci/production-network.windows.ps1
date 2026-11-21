# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
param([ValidateSet('isolate', 'verify', 'negative-control')][string]$Action)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable hosted Windows runners only' }
$state = Join-Path $env:RUNNER_TEMP 'production-network'
$record = Join-Path $state 'dns-sink.log'
$baseline = Join-Path $state 'baseline.json'
$group = 'Omnesis disposable CI DNS isolation'
$firewallLog = Join-Path $env:SystemRoot 'System32/LogFiles/Firewall/omnesis-ci.log'
function Count-Refusals {
  if (Test-Path $record) { return @(Get-Content $record).Count }
  return 0
}
function Count-Drops {
  if (-not (Test-Path $firewallLog)) { return 0 }
  return @((Get-Content $firewallLog) | Where-Object { $_ -match '\sDROP\s+(UDP|TCP)\s+\S+\s+\S+\s+\d+\s+53\s' }).Count
}
if ($Action -eq 'verify') {
  if (-not (Test-Path $baseline)) { throw 'No production network baseline; was the job isolated?' }
  $saved = Get-Content $baseline -Raw | ConvertFrom-Json
  $process = Get-Process -Id $saved.pid
  if ($process.StartTime.ToUniversalTime().Ticks -ne $saved.start) { throw 'DNS proxy process identity changed' }
  if ((Count-Refusals) -ne $saved.refusals -or (Count-Drops) -ne $saved.drops) { throw 'DNS_ISOLATION_VIOLATION: a protected question or a direct DNS bypass was attempted' }
  if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled -or $_.DefaultOutboundAction -ne 'Block' }).Count) { throw 'DNS bypass firewall policy changed' }
  Write-Output 'No protected questions or direct DNS bypass attempts after baseline'
  exit 0
}
if ($Action -eq 'negative-control') {
  $config = Get-Content (Join-Path $state 'proxy.json') -Raw | ConvertFrom-Json
  $before = Count-Drops
  $query = 'const {Resolver}=require("node:dns");const r=new Resolver({timeout:1000,tries:1});r.setServers([process.argv[1]]);r.resolve4("bypass.windows-network-probe.example.test",e=>process.exit(e?0:1));setTimeout(()=>process.exit(2),4000).unref();'
  & node -e $query $config.upstream[0]
  if ($LASTEXITCODE -ne 0) { throw 'Explicit foreign DNS was not refused promptly' }
  $limit = [DateTime]::UtcNow.AddSeconds(65)
  while ((Count-Drops) -le $before -and [DateTime]::UtcNow -lt $limit) { Start-Sleep -Milliseconds 250 }
  if ((Count-Drops) -le $before) { throw 'Foreign DNS refusal was not recorded by the firewall' }
  Write-Output 'Explicit foreign DNS refused and its attempted bypass recorded'
  exit 0
}
if (Test-Path $state) { throw 'Refuse to erase an existing isolation record' }
New-Item -ItemType Directory -Path $state | Out-Null
$addresses = @(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses.Count -gt 0 })
$upstream = @($addresses.ServerAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '127.0.0.1' } | Select-Object -Unique)
if ($upstream.Count -eq 0) { throw 'No upstream IPv4 DNS server was recorded' }
$python = (Get-Command python).Source
$configFile = Join-Path $state 'proxy.json'
@{ upstream=$upstream; record=$record; deny=@('omnesis.app','omnesis.dev','windows-network-probe.example.test') } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $configFile
$ready = Join-Path $state 'proxy-ready.txt'
$errors = Join-Path $state 'proxy-errors.txt'
$proxyFile = Join-Path $PSScriptRoot 'production-dns-proxy.py'
# This DNS infrastructure belongs to the disposable VM, including runner post-job reporting.
# Per-command orphan cleanup must not remove the runner's resolver before it reports its result.
$tracking = $env:RUNNER_TRACKING_ID
try {
  $env:RUNNER_TRACKING_ID = ''
  $sink = Start-Process -FilePath $python -ArgumentList @('-u', ('"'+$proxyFile+'"'), ('"'+$configFile+'"')) -PassThru -RedirectStandardOutput $ready -RedirectStandardError $errors
  # Opening the handle now keeps the exit code readable if the proxy ends early.
  $null = $sink.Handle
} finally {
  if ($null -eq $tracking) { Remove-Item Env:RUNNER_TRACKING_ID -ErrorAction SilentlyContinue }
  else { $env:RUNNER_TRACKING_ID = $tracking }
}
# A freshly booted runner starts Python cold, which can take well over ten seconds.
# Wait for the proxy itself: it either reports ready or exits. The ceiling only ends a hang.
$starting = [Diagnostics.Stopwatch]::StartNew()
while (-not ((Test-Path $ready) -and ((Get-Content $ready -Raw) -match 'ready'))) {
  $sink.Refresh()
  if ($sink.HasExited -or $starting.Elapsed.TotalSeconds -ge 120) {
    $outcome = if ($sink.HasExited) { "exited with code $($sink.ExitCode)" } else { 'still starting after 120 s' }
    $stderr = if (Test-Path $errors) { Get-Content $errors -Raw } else { '' }
    throw "DNS proxy did not become ready ($outcome); no adapter or production lookup was attempted. $stderr"
  }
  Start-Sleep -Milliseconds 100
}
Write-Output ('DNS proxy ready after {0:N1} s' -f $starting.Elapsed.TotalSeconds)
# Existing resolver state is retained as forwarding input, never overwritten in source.
foreach ($adapter in $addresses) { Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ServerAddresses '127.0.0.1' }
Add-DnsClientNrptRule -Namespace @('windows-network-probe.example.test','.windows-network-probe.example.test','omnesis.app','.omnesis.app','omnesis.dev','.omnesis.dev') -NameServers '127.0.0.1' -Comment $group | Out-Null
Clear-DnsClientCache
# Allow every ordinary port before tightening the default; only the proxy may ask external DNS.
foreach ($protocol in @('TCP','UDP')) {
  New-NetFirewallRule -DisplayName "$group ordinary $protocol" -Group $group -Direction Outbound -Action Allow -Protocol $protocol -RemotePort @('1-52','54-65535') -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName "$group loopback $protocol" -Group $group -Direction Outbound -Action Allow -Protocol $protocol -RemotePort 53 -RemoteAddress '127.0.0.1' -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName "$group proxy $protocol" -Group $group -Direction Outbound -Action Allow -Protocol $protocol -RemotePort 53 -Program $python -Profile Any | Out-Null
}
foreach ($protocol in @('ICMPv4','ICMPv6')) { New-NetFirewallRule -DisplayName "$group $protocol" -Group $group -Direction Outbound -Action Allow -Protocol $protocol -Profile Any | Out-Null }
Get-NetFirewallRule -Direction Outbound -Enabled True -Action Allow | Where-Object { $_.Group -ne $group } | Disable-NetFirewallRule
Set-NetFirewallProfile -Profile @('Domain','Private','Public') -Enabled True -DefaultOutboundAction Block -LogBlocked True -LogFileName $firewallLog -LogMaxSizeKilobytes 32767
$lookup = 'require("node:dns").lookup(process.argv[1],e=>process.exit(e?0:1));setTimeout(()=>process.exit(2),5000).unref();'
$resolve = 'require("node:dns").resolve4(process.argv[1],e=>process.exit(e?0:1));setTimeout(()=>process.exit(2),5000).unref();'
function Require-RecordedRefusal([string]$queryName,[string]$program) {
  $count = Count-Refusals
  & node -e $program $queryName
  if ($LASTEXITCODE -ne 0) { throw 'DNS capability probe did not refuse promptly' }
  if ((Count-Refusals) -le $count) { throw ('CAPABILITY_GAP: '+$queryName+' bypassed the controlled resolver') }
  Write-Output ('Recorded refusal: '+$queryName)
}
# Reserved names prove both APIs before any production-name probe.
Require-RecordedRefusal 'native.windows-network-probe.example.test' $lookup
Require-RecordedRefusal 'cares.windows-network-probe.example.test' $resolve
Require-RecordedRefusal 'relay.omnesis.app' $lookup
Require-RecordedRefusal 'omnesis.dev' $lookup
& node -e 'require("node:dns").lookup("github.com",e=>process.exit(e?1:0));setTimeout(()=>process.exit(2),5000).unref();'
if ($LASTEXITCODE -ne 0) { throw 'Unrelated DNS stopped working' }
& node -e 'require("node:dns").resolve4("github.com",e=>process.exit(e?1:0));setTimeout(()=>process.exit(2),5000).unref();'
if ($LASTEXITCODE -ne 0) { throw 'Unrelated direct DNS stopped working' }
& pwsh -NoLogo -NoProfile -NonInteractive -File $PSCommandPath negative-control
if ($LASTEXITCODE) { throw 'DNS bypass refusal was not proven before tests' }
@{ pid=$sink.Id; start=$sink.StartTime.ToUniversalTime().Ticks; refusals=(Count-Refusals); drops=(Count-Drops) } | ConvertTo-Json | Set-Content $baseline
Write-Output 'System and direct default resolvers refused protected names; unrelated DNS works; foreign DNS blocked and audited'
