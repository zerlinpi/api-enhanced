#!/usr/bin/env bash
# Run as root on the production server AFTER Docker and .env.production are configured.
# Example:
# sudo APP_DIR=/home/deployer/apps/artist-platform/artist-community \
#   RUN_USER=deployer BACKUP_DIR=/srv/backups/artist-community \
#   bash deploy/install-backup-timer.sh
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root via sudo on the production server." >&2
  exit 1
fi
: "${APP_DIR:?Set APP_DIR to the deployed artist-community directory}"
: "${RUN_USER:?Set RUN_USER to a restricted deployment account}"
: "${BACKUP_DIR:?Set BACKUP_DIR to a persistent backup path outside Docker volumes}"
APP_DIR="$(realpath -e "$APP_DIR")"
case "$APP_DIR" in
  *[!a-zA-Z0-9_./-]*|'') echo 'ERROR: unsafe APP_DIR' >&2; exit 1 ;;
esac
case "$BACKUP_DIR" in
  /*) ;;
  *) echo 'ERROR: BACKUP_DIR must be an absolute path' >&2; exit 1 ;;
esac
case "$BACKUP_DIR" in
  *[!a-zA-Z0-9_./-]*|'/'|'') echo 'ERROR: unsafe BACKUP_DIR' >&2; exit 1 ;;
esac
[[ "$BACKUP_DIR" != "$APP_DIR" && "$BACKUP_DIR" != "$APP_DIR/"* ]] || {
  echo 'ERROR: Backups must be stored outside the application directory' >&2
  exit 1
}
id "$RUN_USER" >/dev/null
test -f "$APP_DIR/.env.production" || { echo 'ERROR: Missing .env.production' >&2; exit 1; }
test -f "$APP_DIR/backup.sh" || { echo 'ERROR: Missing backup.sh' >&2; exit 1; }
if ! runuser -u "$RUN_USER" -- test -r "$APP_DIR/.env.production"; then
  echo 'ERROR: RUN_USER cannot read .env.production; check directory and owner permissions' >&2
  exit 1
fi
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION" =~ ^[1-9][0-9]*$ ]] || { echo 'ERROR: invalid retention days' >&2; exit 1; }
RUN_GROUP="$(id -gn "$RUN_USER")"
install -d -m 0700 -o "$RUN_USER" -g "$RUN_GROUP" "$BACKUP_DIR"

cat > /etc/systemd/system/artist-community-backup.service <<EOF
[Unit]
Description=Artist Community PostgreSQL backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$APP_DIR
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=ENV_FILE=.env.production
Environment=BACKUP_RETENTION_DAYS=$RETENTION
ExecStart=/usr/bin/bash $APP_DIR/backup.sh
NoNewPrivileges=true
PrivateTmp=true
EOF
cat > /etc/systemd/system/artist-community-backup.timer <<'EOF'
[Unit]
Description=Run Artist Community database backup daily

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true
Unit=artist-community-backup.service

[Install]
WantedBy=timers.target
EOF
chmod 0644 /etc/systemd/system/artist-community-backup.service /etc/systemd/system/artist-community-backup.timer
systemctl daemon-reload
systemctl enable --now artist-community-backup.timer
echo 'Installed daily backup timer (server local time, ~03:30).'
echo 'Manually test with: sudo systemctl start artist-community-backup.service'
echo 'Inspect runs with: sudo journalctl -u artist-community-backup.service -n 50'
echo 'Test a restore to a separate database before relying on backups.'
