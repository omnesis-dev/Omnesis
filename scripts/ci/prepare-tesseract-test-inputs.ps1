# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Extract the pinned upstream distribution without running its installer.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV -or -not $env:GITHUB_PATH) {
  throw 'Native OCR preparation requires a disposable hosted Windows job'
}
$ocrInstaller = Join-Path $env:RUNNER_TEMP 'tesseract-5.5.0.exe'
curl.exe --fail --location --silent --show-error --max-time 120 --max-filesize 30000000 https://github.com/tesseract-ocr/tesseract/releases/download/5.5.0/tesseract-ocr-w64-setup-5.5.0.20241111.exe --output $ocrInstaller
if ($LASTEXITCODE) { throw 'Pinned OCR engine download failed' }
if ((Get-FileHash -Algorithm SHA256 $ocrInstaller).Hash -ne 'f3fc4236425b690c8be756f35793f77394ee004be0a6460a440c754d892f68bc') { throw 'OCR engine hash mismatch' }
$ocrRoot = Join-Path $env:RUNNER_TEMP 'native OCR tools'
$sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
if (-not (Test-Path $sevenZip)) { throw 'The runner must provide 7-Zip for the pinned NSIS archive' }
& $sevenZip x -y "-o$ocrRoot" $ocrInstaller
if ($LASTEXITCODE) { throw 'Pinned OCR engine extraction failed' }
if (-not (Test-Path (Join-Path $ocrRoot 'tesseract.exe'))) { throw 'Native OCR binary is absent' }
$languageData = Join-Path $ocrRoot 'tessdata\eng.traineddata'
New-Item -ItemType Directory -Force (Split-Path $languageData) | Out-Null
curl.exe --fail --location --silent --show-error --max-time 120 --max-filesize 10000000 https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata --output $languageData
if ($LASTEXITCODE) { throw 'Pinned OCR English data download failed' }
if ((Get-FileHash -Algorithm SHA256 $languageData).Hash -ne '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2') { throw 'OCR English data hash mismatch' }
$ocrRoot | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
"TESSDATA_PREFIX=$(Join-Path $ocrRoot 'tessdata')" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
