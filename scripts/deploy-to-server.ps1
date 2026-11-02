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

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = Join-Path $env:TEMP "boardgame-deploy-$stamp.tgz"

try {
  Write-Host "==> 打包当前提交（git archive HEAD）" -ForegroundColor Cyan
  & git archive --format=tar.gz -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
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
if ! command -v pnpm >/dev/null 2>&1 && ! command -v corepack >/dev/null 2>&1; then
  echo "服务器既没有 pnpm 也没有 corepack"; exit 1
fi

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
if command -v runuser >/dev/null 2>&1 && runuser -u boardgame -- bash -lc 'command -v pnpm >/dev/null 2>&1'; then
  runuser -u boardgame -- bash -lc "cd '$APP' && pnpm install --frozen-lockfile && pnpm build"
elif command -v pnpm >/dev/null 2>&1; then
  (cd "$APP" && pnpm install --frozen-lockfile && pnpm build)
elif command -v corepack >/dev/null 2>&1; then
  (cd "$APP" && corepack pnpm install --frozen-lockfile && corepack pnpm build)
else
  echo "找不到可用的 pnpm"; exit 1
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
  if (Test-Path $archive) { Remove-Item $archive -Force -ErrorAction SilentlyContinue }
}
