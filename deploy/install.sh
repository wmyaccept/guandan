#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 node。请先安装 Node.js 18 或以上。"
  exit 1
fi

NODE_BIN="$(command -v node)"
APP_USER="$(id -un)"
SERVICE_PATH="/etc/systemd/system/guandan.service"

echo "安装目录: $ROOT"
echo "运行用户: $APP_USER"
echo "Node: $NODE_BIN $($NODE_BIN -v)"

rm -rf node_modules
npm install --omit=dev

write_service() {
  cat <<EOF
[Unit]
Description=Guandan table
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$ROOT
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$(id -u)" -eq 0 ]; then
  write_service > "$SERVICE_PATH"
  systemctl daemon-reload
  systemctl enable --now guandan
  systemctl --no-pager --full status guandan || true
else
  TMP_SERVICE="$(mktemp)"
  write_service > "$TMP_SERVICE"
  echo "需要 sudo 才能写成开机自启："
  sudo cp "$TMP_SERVICE" "$SERVICE_PATH"
  rm -f "$TMP_SERVICE"
  sudo systemctl daemon-reload
  sudo systemctl enable --now guandan
  sudo systemctl --no-pager --full status guandan || true
fi

echo
echo "程序已在 127.0.0.1:3000 运行。"
echo "接下来把 deploy/nginx.subdomain.conf 里的域名改成 guandan.你的域名，"
echo "再作为新站点加入 Nginx，不要覆盖现有网站。"
