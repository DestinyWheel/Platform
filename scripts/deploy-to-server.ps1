# 把当前 HEAD 部署到 https://150.158.13.77/
#
# 用法（PowerShell，在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-to-server.ps1
#
# 会提示两次密码：
#   1. scp 上传部署包
#   2. ssh 执行远端部署
# 密码不会被脚本保存，也不会出现在命令行参数里。
#
# 远端约定（见 docs/tls.md）：
#   - 目录：/opt/boardgame
#   - 服务：boardgame（systemd，运行用户 boardgame）
#   - .env / .certs / .data / storage 不会被覆盖
#
# 回滚：远端 /opt/boardgame-backups/source-<时间>.tgz

param(
  [string]$Server = '150.158.13.77',
  [int]$SshPort = 22,
  [string]$User = 'root',
  [string]$RemoteDir = '/opt/boardgame',
  [string]$Service = 'boardgame'
)

$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "找不到命令：$Name。请先安装 OpenSSH 客户端 / Git。"
  }
}

Require-Command git
Require-Command ssh
Require-Command scp

# 必须用 Windows 自带的 bsdtar；Git Bash 的 GNU tar 会把 D: 当成远程主机
$tarExe = Join-Path $env:WINDIR 'System32\tar.exe'
if (-not (Test-Path $tarExe)) {
  throw '找不到 Windows 自带的 tar.exe（C:\Windows\System32\tar.exe）'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP "boardgame-stage-$stamp"
$srcTar = Join-Path $env:TEMP "boardgame-src-$stamp.tar"
$archive = Join-Path $env:TEMP "boardgame-deploy-$stamp.tgz"

try {
  Write-Host "==> 本地构建前端" -ForegroundColor Cyan
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm --filter @platform/web build
  } elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
    & corepack pnpm --filter @platform/web build
  } else {
    throw '本地既没有 pnpm 也没有 corepack，无法构建前端'
  }
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }

  $distSource = Join-Path $repoRoot 'apps\web\dist'
  if (-not (Test-Path (Join-Path $distSource 'index.html'))) {
    throw '前端构建产物不存在：apps\web\dist\index.html'
  }

  Write-Host "==> 打包当前提交 + 前端产物" -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  & git -C $repoRoot archive --format=tar -o $srcTar HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
  & $tarExe -xf $srcTar -C $stage
  if ($LASTEXITCODE -ne 0) { throw '解压源码包失败' }

  $distTarget = Join-Path $stage 'apps\web\dist'
  New-Item -ItemType Directory -Path $distTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $distSource '*') -Destination $distTarget -Recurse -Force
  if (-not (Test-Path (Join-Path $distTarget 'index.html'))) {
    throw '前端产物复制失败'
  }

  & $tarExe -czf $archive -C $stage .
  if ($LASTEXITCODE -ne 0) { throw '生成部署包失败' }
  $sizeKb = [math]::Round((Get-Item $archive).Length / 1KB, 1)
  Write-Host "    包大小：$sizeKb KB"

  Write-Host "==> 上传到 ${User}@${Server}:/tmp/boardgame-deploy.tgz（第一次密码）" -ForegroundColor Cyan
  & scp -P $SshPort -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 `
    $archive "${User}@${Server}:/tmp/boardgame-deploy.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'scp 上传失败' }

  $remote = @'
set -euo pipefail

APP="__APP__"
SERVICE="__SERVICE__"
ARCHIVE="/tmp/boardgame-deploy.tgz"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/boardgame-backups"
BACKUP="$BACKUP_DIR/source-$STAMP.tgz"
FAILED=1

rollback() {
  if [ "$FAILED" -eq 1 ] && [ -f "$BACKUP" ]; then
    echo "!! 部署失败，尝试恢复旧源码并重启服务"
    systemctl stop "$SERVICE" || true
    tar -xzf "$BACKUP" -C "$APP" || true
    chown -R boardgame:boardgame "$APP" 2>/dev/null || chown -R boardgame "$APP" || true
    systemctl start "$SERVICE" || true
    echo "!! 已尝试恢复；如果还起不来：journalctl -u $SERVICE -n 100 --no-pager"
  fi
}
trap rollback EXIT

echo "== 检查远端环境 =="
[ -f "$ARCHIVE" ] || { echo "找不到上传包：$ARCHIVE"; exit 1; }
[ -f "$APP/apps/server/src/main.ts" ] || { echo "找不到应用目录：$APP"; exit 1; }
systemctl cat "$SERVICE" >/dev/null 2>&1 || { echo "找不到 systemd 服务：$SERVICE"; exit 1; }

# 服务的 pnpm 可能不在 root 的非登录 PATH 里；常见位置补一下
for dir in \
  /usr/local/bin /usr/bin /bin \
  /root/.local/share/pnpm /home/boardgame/.local/share/pnpm \
  /root/.nvm/versions/node/*/bin /home/boardgame/.nvm/versions/node/*/bin; do
  [ -x "$dir/pnpm" ] && export PATH="$dir:$PATH"
done
echo "pnpm：$(command -v pnpm || echo '未找到（将使用上传的前端产物）')"

echo "== 备份当前源码 =="
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP" -C "$APP" \
  --exclude=node_modules --exclude=.git --exclude=.data --exclude=storage \
  --exclude=.certs --exclude=.env .
echo "备份：$BACKUP"

echo "== 停服务 =="
systemctl stop "$SERVICE"

echo "== 解压新代码（保留 .env / .certs / .data / storage）=="
tar -xzf "$ARCHIVE" -C "$APP"
chown -R boardgame:boardgame "$APP" 2>/dev/null || chown -R boardgame "$APP"

echo "== 安装依赖并构建前端 =="
BUILT=0
if command -v runuser >/dev/null 2>&1 && runuser -u boardgame -- bash -lc 'command -v pnpm >/dev/null 2>&1'; then
  if runuser -u boardgame -- bash -lc "cd '$APP' && pnpm install --frozen-lockfile && pnpm build"; then
    BUILT=1
  fi
elif command -v pnpm >/dev/null 2>&1; then
  if (cd "$APP" && pnpm install --frozen-lockfile && pnpm build); then
    BUILT=1
  fi
elif command -v corepack >/dev/null 2>&1; then
  if (cd "$APP" && corepack pnpm install --frozen-lockfile && corepack pnpm build); then
    BUILT=1
  fi
fi

if [ "$BUILT" -eq 0 ]; then
  if [ -f "$APP/apps/web/dist/index.html" ]; then
    echo "未找到可用的 pnpm（或构建失败），使用上传包里的前端产物，跳过 install/build"
  else
    echo "无法构建前端，且上传包里没有 apps/web/dist/index.html"
    exit 1
  fi
fi
chown -R boardgame:boardgame "$APP" 2>/dev/null || chown -R boardgame "$APP"

echo "== 启动服务 =="
systemctl start "$SERVICE"
sleep 3
systemctl --no-pager --full status "$SERVICE" | head -n 25 || true

echo "== 健康检查 =="
if curl -kfsS --max-time 10 https://127.0.0.1/api/health; then
  echo
  echo "部署完成：https://150.158.13.77/"
  FAILED=0
elif curl -fsS --max-time 10 http://127.0.0.1:8787/api/health; then
  echo
  echo "部署完成（8787 端口健康）：https://150.158.13.77/"
  FAILED=0
else
  echo "健康检查失败，最近日志："
  journalctl -u "$SERVICE" -n 100 --no-pager || true
  exit 1
fi
'@

  $remote = $remote.Replace('__APP__', $RemoteDir).Replace('__SERVICE__', $Service)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))

  Write-Host "==> 远端部署（第二次密码）" -ForegroundColor Cyan
  & ssh -p $SshPort -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 `
    "${User}@${Server}" "echo $b64 | base64 -d | bash -s"
  if ($LASTEXITCODE -ne 0) { throw '远端部署失败' }

  Write-Host "==> 完成" -ForegroundColor Green
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $srcTar) { Remove-Item $srcTar -Force -ErrorAction SilentlyContinue }
  if (Test-Path $archive) { Remove-Item $archive -Force -ErrorAction SilentlyContinue }
}
