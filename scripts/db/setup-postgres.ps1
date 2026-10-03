# =============================================================
# scripts/db/setup-postgres.ps1
# PostgreSQL 16 便携版供给脚本（幂等：可重复执行，已完成的步骤自动跳过）
#
# 用途：为本机自托管会议 AI 项目提供 PostgreSQL 16 实例
#   - 安装目录：D:\myProject\hemi\runtime\pgsql （项目目录之外，避免 Next dev 文件监听误触发）
#   - 数据目录：D:\myProject\hemi\runtime\pgdata
#   - 实例参数：用户 meetingai / 密码 meetingai_2026 / 端口 5432 / 编码 UTF8 / 校验 scram-sha-256
#   - 业务库：meeting_ai
#
# 执行前检测已有实例：若本机已有可用 PostgreSQL（PATH 或常见安装位置），
# 仅创建 meeting_ai 库后退出，不做便携部署。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\db\setup-postgres.ps1
#       （zip 已存在时自动跳过下载；全部步骤完成后自动执行 psql select 1 验证）
# =============================================================

$ErrorActionPreference = "Stop"

$RuntimeRoot = "D:\myProject\hemi\runtime"
$PgHome      = Join-Path $RuntimeRoot "pgsql"
$PgData      = Join-Path $RuntimeRoot "pgdata"
$PgZip       = Join-Path $RuntimeRoot "pg16-binaries.zip"
$PgLog       = Join-Path $RuntimeRoot "pg.log"
$PwdFile     = Join-Path $RuntimeRoot ".pgpwd"
$PgUser      = "meetingai"
$PgPassword  = "meetingai_2026"
$PgPort      = 5432
$DbName      = "meeting_ai"
$ZipUrl      = "https://get.enterprisedb.com/postgresql/postgresql-16.10-1-windows-x64-binaries.zip"

function Test-PgPortListening {
    param([int]$Port = 5432)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $Port)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# ---------- 第零步：检测本机已有 PostgreSQL ----------
$existingPsql = Get-Command psql -ErrorAction SilentlyContinue
$existingHome = Test-Path "C:\Program Files\PostgreSQL"
if ($existingPsql -or $existingHome) {
    Write-Host "[检测] 本机已有 PostgreSQL 安装，尝试复用（仅建库）..."
    $env:PATH += ";C:\Program Files\PostgreSQL\*\bin"
    if (-not (Test-PgPortListening -Port $PgPort)) {
        Write-Host "[检测] 端口 $PgPort 未监听，尝试启动已有服务（请人工确认服务名）..."
        Get-Service | Where-Object { $_.Name -match "postgres" } | ForEach-Object {
            Start-Service $_.Name -ErrorAction SilentlyContinue
        }
    }
    # 用信任的超级用户建库（默认 postgres，密码交互输入）
    $env:PGPASSWORD = Read-Host "请输入已有实例超级用户密码"
    & psql -U postgres -h 127.0.0.1 -p $PgPort -c "SELECT 1"
    if ($LASTEXITCODE -eq 0) {
        & psql -U postgres -h 127.0.0.1 -p $PgPort -c "CREATE DATABASE $DbName" 2>$null
        Write-Host "[完成] 已确保数据库 $DbName 存在（复用已有实例）。"
        exit 0
    }
    Write-Warning "已有实例连接失败，转入便携部署流程..."
}

# ---------- 第一步：下载 binaries zip（已存在则跳过） ----------
if (-not (Test-Path $PgZip)) {
    if (-not (Test-Path $RuntimeRoot)) { New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null }
    Write-Host "[下载] $ZipUrl"
    Invoke-WebRequest -Uri $ZipUrl -OutFile $PgZip -UseBasicParsing
} else {
    Write-Host "[跳过] zip 已存在：$PgZip"
}

# ---------- 第二步：解压到 pgsql（已存在则跳过） ----------
if (-not (Test-Path (Join-Path $PgHome "bin\initdb.exe"))) {
    Write-Host "[解压] $PgZip -> $RuntimeRoot"
    Expand-Archive -Path $PgZip -DestinationPath $RuntimeRoot -Force
    # EDB zip 解压后根目录名形如 pgsql；若不同则归位
    if (-not (Test-Path (Join-Path $PgHome "bin\initdb.exe"))) {
        $extracted = Get-ChildItem $RuntimeRoot -Directory | Where-Object {
            Test-Path (Join-Path $_.FullName "bin\initdb.exe")
        } | Select-Object -First 1
        if ($extracted -and $extracted.FullName -ne $PgHome) {
            Move-Item $extracted.FullName $PgHome
        }
    }
} else {
    Write-Host "[跳过] 已解压：$PgHome"
}
$env:PATH = "$PgHome\bin;$env:PATH"

# ---------- 第三步：initdb（pgdata 已存在则跳过） ----------
if (-not (Test-Path (Join-Path $PgData "PG_VERSION"))) {
    Write-Host "[初始化] initdb -> $PgData"
    if (Test-Path $PwdFile) { Remove-Item $PwdFile -Force }
    [System.IO.File]::WriteAllText($PwdFile, $PgPassword, [System.Text.Encoding]::ASCII)
    & initdb -D $PgData -U $PgUser --pwfile=$PwdFile -E UTF8 -A scram-sha-256 --locale=C
    if ($LASTEXITCODE -ne 0) { throw "initdb 失败" }
} else {
    Write-Host "[跳过] 数据目录已初始化：$PgData"
}

# ---------- 第四步：启动实例（端口已监听则跳过） ----------
if (-not (Test-PgPortListening -Port $PgPort)) {
    Write-Host "[启动] pg_ctl start（端口 $PgPort，日志 $PgLog）"
    & pg_ctl -D $PgData -l $PgLog -o "-p $PgPort" start
    if ($LASTEXITCODE -ne 0) { throw "pg_ctl start 失败，请查看 $PgLog" }
    # 等待就绪
    $ready = $false
    foreach ($i in 1..15) {
        if (Test-PgPortListening -Port $PgPort) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "端口 $PgPort 未就绪，请查看 $PgLog" }
} else {
    Write-Host "[跳过] 端口 $PgPort 已在监听"
}

# ---------- 第五步：建业务库（已存在则跳过） ----------
$env:PGPASSWORD = $PgPassword
$dbExists = & psql -U $PgUser -h 127.0.0.1 -p $PgPort -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'"
if ($dbExists -ne "1") {
    Write-Host "[建库] CREATE DATABASE $DbName"
    & createdb -U $PgUser -h 127.0.0.1 -p $PgPort $DbName
    if ($LASTEXITCODE -ne 0) { throw "createdb 失败" }
} else {
    Write-Host "[跳过] 数据库 $DbName 已存在"
}

# ---------- 第六步：验证 ----------
Write-Host "[验证] psql select 1"
& psql -U $PgUser -h 127.0.0.1 -p $PgPort -d $DbName -c "select version(); select 1 as ok;"
if ($LASTEXITCODE -ne 0) { throw "psql 验证失败" }

Write-Host ""
Write-Host "==================== 供给完成 ===================="
Write-Host "连接串（写入项目 .env.local）："
Write-Host "DATABASE_URL=postgresql://${PgUser}:$PgPassword@127.0.0.1:$PgPort/$DbName"
Write-Host "停止实例：pg_ctl -D $PgData stop"
Write-Host "=================================================="
