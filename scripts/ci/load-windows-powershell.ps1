# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# The native worker's owner check and bootstrap launch Windows PowerShell
# inside a thirty-second startup allowance. On a freshly provisioned runner
# the first launch can spend longer than that loading the engine, before it
# runs a single statement. Pay that one-time cost here, under the calling
# step's own limit, so the capped launches start from a loaded engine.
$ErrorActionPreference = 'Stop'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$elapsed = Measure-Command {
  & $powershell -NoLogo -NoProfile -NonInteractive -Command '[Diagnostics.Process]::GetCurrentProcess().StartTime | Out-Null'
}
if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell exited with $LASTEXITCODE" }
"Windows PowerShell first launch: $([int]$elapsed.TotalMilliseconds) ms"
