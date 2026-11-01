#!/usr/bin/env bash
# Установка и обновление сайта на сервере с Ubuntu 22.04/24.04 или Debian 12.
# Запускается от root из deploy.ps1; можно запускать повторно.
#   bash /opt/farm-otdel/deploy/setup.sh farm.example.com
set -euo pipefail

DOMAIN="${1:?Укажите домен сайта, например: bash setup.sh farm.example.com}"
APP=/opt/farm-otdel
BACKUPS=/var/backups/farm-otdel
export DEBIAN_FRONTEND=noninteractive

echo "==> Пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg sqlite3 ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy (HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> Приложение"
id farm >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin farm
mkdir -p "$APP/data" "$BACKUPS"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<EOF
BASE_URL=https://$DOMAIN
HOST=127.0.0.1
PORT=3000
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
OWNER_DISCORD_IDS=
DEV_LOGIN=0
EOF
fi
chown -R farm:farm "$APP"
chmod 600 "$APP/.env"

install -m 644 "$APP/deploy/farm-otdel.service" /etc/systemd/system/farm-otdel.service
systemctl daemon-reload
systemctl enable farm-otdel >/dev/null
systemctl restart farm-otdel

echo "==> HTTPS для $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Ежедневная копия базы (хранится 14 дней)"
cat > /etc/cron.daily/farm-otdel-backup <<EOF
#!/bin/sh
[ -f $APP/data/farm.db ] || exit 0
sqlite3 $APP/data/farm.db ".backup '$BACKUPS/farm-\$(date +%F).db'"
find $BACKUPS -name 'farm-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/farm-otdel-backup

echo "==> Файрвол: открыты только SSH и веб"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 2
if systemctl is-active --quiet farm-otdel; then
  echo "Готово: https://$DOMAIN"
else
  echo "Сайт не запустился. Журнал:"
  journalctl -u farm-otdel -n 30 --no-pager
  exit 1
fi
