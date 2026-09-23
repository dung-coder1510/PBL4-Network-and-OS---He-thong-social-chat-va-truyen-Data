param([string]$Instance = 'MSSQLLocalDB')

$ErrorActionPreference = 'Stop'
$testDatabase = 'PBL4_Review_Test'
$serverName = '(localdb)\' + $Instance
$testDirectory = Join-Path $PSScriptRoot '.local'
$schemaPath = Join-Path $PSScriptRoot '..\01_schema.sql'
$verifyPath = Join-Path $PSScriptRoot 'verify.sql'
$queriesPath = Join-Path $PSScriptRoot '..\02_queries.sql'

if (-not (Test-Path -LiteralPath $verifyPath)) { throw 'verify.sql is missing.' }
Get-Command SqlLocalDB, sqlcmd -ErrorAction Stop | Out-Null

# LocalDB maintains its instance files in the Windows user profile.
# This script never starts the machine-wide MSSQLSERVER service.
& SqlLocalDB start $Instance
if ($LASTEXITCODE -ne 0) { throw 'Could not start LocalDB.' }

# Never overwrite an existing database, including a previous test run.
& sqlcmd -S $serverName -E -b -l 15 -d master -Q "IF DB_ID(N'$testDatabase') IS NOT NULL THROW 51200, 'Test database already exists. Inspect it; this runner never overwrites it.', 1;"
if ($LASTEXITCODE -ne 0) { throw 'Existing test database or connection error; stopped.' }

New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
$dataPath = Join-Path $testDirectory 'PBL4_Review_Test.mdf'
$logPath = Join-Path $testDirectory 'PBL4_Review_Test_log.ldf'
if ((Test-Path -LiteralPath $dataPath) -or (Test-Path -LiteralPath $logPath)) {
    throw 'Test database files already exist. Inspect them before creating another database.'
}
$sqlDataPath = $dataPath.Replace("'", "''")
$sqlLogPath = $logPath.Replace("'", "''")
$createSql = "CREATE DATABASE [$testDatabase] ON PRIMARY (NAME=N'PBL4_Review_Test', FILENAME=N'$sqlDataPath') LOG ON (NAME=N'PBL4_Review_Test_log', FILENAME=N'$sqlLogPath');"
& sqlcmd -S $serverName -E -b -l 15 -d master -Q $createSql
if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated test database.' }

& sqlcmd -S $serverName -E -b -l 15 -f 65001 -d $testDatabase -i $schemaPath
if ($LASTEXITCODE -ne 0) { throw 'Schema installation failed.' }
& sqlcmd -S $serverName -E -b -l 15 -f 65001 -d $testDatabase -i $verifyPath
if ($LASTEXITCODE -ne 0) { throw 'Database verification failed.' }
& sqlcmd -S $serverName -E -b -l 15 -f 65001 -d $testDatabase -i $queriesPath -o (Join-Path $testDirectory 'query-results.txt')
if ($LASTEXITCODE -ne 0) { throw 'Read-only query verification failed.' }

Write-Output "PASS: schema, constraints and sample queries verified in $testDatabase."
Write-Output "Test data is retained for inspection. Query output: $testDirectory\query-results.txt"
