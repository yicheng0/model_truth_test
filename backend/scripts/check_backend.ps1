param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$PytestArgs
)

$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path -Parent $PSScriptRoot
Set-Location $BackendRoot

$PythonCandidates = @(
    (Join-Path $BackendRoot ".venv\Scripts\python.exe"),
    (Join-Path $BackendRoot "venv\Scripts\python.exe"),
    "python"
)

$Python = $null
foreach ($Candidate in $PythonCandidates) {
    if ($Candidate -eq "python") {
        $Python = $Candidate
        break
    }
    if (Test-Path $Candidate) {
        $Python = $Candidate
        break
    }
}

if (-not $Python) {
    throw "No Python executable found. Create backend/.venv or install Python on PATH."
}

if (-not $PytestArgs -or $PytestArgs.Count -eq 0) {
    $PytestArgs = @("-q")
}

$CreatedTempDatabase = $false
$TempDatabasePath = $null
if (-not $env:DATABASE_URL) {
    $TempDatabasePath = Join-Path $BackendRoot "test_check_backend_$PID.db"
    $env:DATABASE_URL = "sqlite:///./$([System.IO.Path]::GetFileName($TempDatabasePath))"
    $CreatedTempDatabase = $true
}

try {
    & $Python -m pytest @PytestArgs
    $ExitCode = $LASTEXITCODE
} finally {
    if ($CreatedTempDatabase -and $TempDatabasePath) {
        foreach ($Path in @($TempDatabasePath, "$TempDatabasePath-journal", "$TempDatabasePath-wal", "$TempDatabasePath-shm")) {
            if (Test-Path -LiteralPath $Path) {
                Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
exit $ExitCode
