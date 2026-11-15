<#
.SYNOPSIS
  Instalace MT5 konektoru (JEN ČTENÍ) pro AT Trading deník na Windows. Spouštět v PowerShellu jako běžný uživatel (ne jako správce).

.DESCRIPTION
  1) najde/nainstaluje Python, 2) nainstaluje balíček MetaTrader5, 3) stáhne soubory konektoru z GitHubu,
  4) uloží token konektoru (ze schránky nebo ze zadání) do souboru jen pro tohoto uživatele, 5) vytvoří config.json,
  6) spustí diagnostiku (diag_report.json, nic se neodesílá), 7) jednou spustí konektor a 8) založí úlohu Plánovače „při přihlášení“.
  Skript NIKDY neobchoduje, nezadává hesla k účtu a nezapíná Algo Trading. Token se nevypisuje.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install_windows.ps1 -AccountName "FundingPips" -TerminalPath "C:\Program Files\MetaTrader 5\terminal64.exe"
#>
param(
  [Parameter(Mandatory = $true)][string]$AccountName,
  [Parameter(Mandatory = $true)][string]$TerminalPath,
  [string]$InstallRoot = (Join-Path $env:USERPROFILE "ATTradingMT5"),
  [switch]$DiagnoseOnly,
  [switch]$SkipScheduledTask
)
$ErrorActionPreference = "Stop"
$ApiUrl = "https://wdcvxfbhauwvwzbatkfh.supabase.co/functions/v1/mt5-ingest"
$RawBase = "https://raw.githubusercontent.com/PitrrV/Fx-Analyzer/main/Trading%20Denik/connector/"
$Files = @("main.py", "collector.py", "uploader.py", "mt5_readonly.py", "diagnose.py")
$Slug = ($AccountName -replace "[^A-Za-z0-9]", "_").ToUpper()
$Dir = Join-Path $InstallRoot $Slug

if (-not (Test-Path -LiteralPath $TerminalPath)) { throw "Terminál MT5 nenalezen: $TerminalPath (zkontroluj cestu k terminal64.exe)." }

# --- Python
function Find-Python {
  foreach ($c in @(@("py", "-3"), @("python"))) {
    try { $exe = $c[0]; $a = @($c | Select-Object -Skip 1) + @("-c", "import sys;print(sys.executable)"); $p = (& $exe @a 2>$null | Select-Object -First 1); if ($p -and (Test-Path -LiteralPath $p)) { return $p } } catch {}
  }
  return $null
}
$Py = Find-Python
if (-not $Py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Python nenalezen, instaluji přes winget…"
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements | Out-Host
    throw "Python je nainstalovaný. Zavři toto okno PowerShellu, otevři nové a spusť skript znovu."
  }
  throw "Python 3 nenalezen. Nainstaluj ho z python.org (64bit) a spusť skript znovu."
}
Write-Host "Python: $Py"
& $Py -m pip install --upgrade --quiet MetaTrader5
if ($LASTEXITCODE -ne 0) { throw "Instalace balíčku MetaTrader5 selhala (je Python 64bit? MT5 balíček je jen pro Windows)." }

# --- soubory konektoru
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
foreach ($f in $Files) { Invoke-WebRequest -UseBasicParsing -Uri ($RawBase + $f) -OutFile (Join-Path $Dir $f) }
Write-Host "Soubory konektoru stažené do $Dir"

# --- token: schránka, jinak zadání (skryté). Uloží se do souboru s právy jen pro tohoto uživatele.
$TokenFile = Join-Path $Dir "account.token"
if (-not (Test-Path -LiteralPath $TokenFile)) {
  $tok = ""
  try { $tok = (Get-Clipboard -Raw).Trim() } catch {}
  if ($tok -notmatch "^mt5_[0-9a-f]{64}$") {
    $sec = Read-Host "Vlož token konektoru (začíná mt5_)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $tok = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if ($tok -notmatch "^mt5_[0-9a-f]{64}$") { throw "Token nemá správný tvar (mt5_ + 64 znaků 0-9a-f)." }
  Set-Content -LiteralPath $TokenFile -Value $tok -NoNewline -Encoding ascii
  icacls $TokenFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  try { Set-Clipboard -Value " " } catch {}
  Write-Host "Token uložen (soubor jen pro tvého uživatele), schránka vyčištěna."
} else { Write-Host "Token už existuje: $TokenFile (ponechán)." }

# --- config
$cfg = [ordered]@{ api_url = $ApiUrl; token_env = "MT5_JOURNAL_TOKEN"; token_file = $TokenFile; terminal_path = $TerminalPath; poll_seconds = 10; history_days_initial = 365; state_file = (Join-Path $Dir "state.json") }
$cfg | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Dir "config.json") -Encoding utf8
Push-Location $Dir
try {
  Write-Host "`n== Diagnostika (jen čtení, nic se neodesílá) =="
  & $Py diagnose.py --config config.json --out diag_report.json
  if ($LASTEXITCODE -ne 0) { throw "Diagnostika selhala. Je MT5 terminál spuštěný a přihlášený na účet? (Soubor: $Dir)" }
  if ($DiagnoseOnly) { Write-Host "Hotovo (DiagnoseOnly). Report: $(Join-Path $Dir 'diag_report.json')"; return }
  Write-Host "`n== Jednorázové odeslání =="
  & $Py main.py --config config.json --once
  if ($LASTEXITCODE -ne 0) { throw "Odeslání selhalo." }
} finally { Pop-Location }

# --- Plánovač úloh (při přihlášení, restart při pádu, bez časového limitu)
if (-not $SkipScheduledTask) {
  $name = "ATTradingMT5-$Slug"
  $action = New-ScheduledTaskAction -Execute $Py -Argument "main.py --config config.json" -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "Úloha '$name' založena a spuštěna (poběží při každém přihlášení)."
}
Write-Host "`nHotovo. Složka: $Dir`nPozor: terminál MT5 musí běžet a být přihlášený na účet. Algo Trading nech vypnuté."
