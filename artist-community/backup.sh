#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
: "${BACKUP_DIR:?Set BACKUP_DIR to an external, protected, persistent path}"
: "${ENV_FILE:=.env.production}"
mkdir -p -- "$BACKUP_DIR"
chmod 700 -- "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$BACKUP_DIR/artist-community-$stamp.dump"
temporary="$(mktemp "$BACKUP_DIR/.artist-backup.XXXXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T db \
  pg_dump -U community -d artist_community --format=custom --no-owner --no-acl > "$temporary"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T db \
  pg_restore --list < "$temporary" > /dev/null
test -s "$temporary"
mv -n -- "$temporary" "$destination"
trap - EXIT
echo "Backup verified: $destination"
# Retention is opt-in and applies ONLY to files with the exact backup pattern in BACKUP_DIR.
if [[ "${BACKUP_RETENTION_DAYS:-0}" =~ ^[1-9][0-9]*$ ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'artist-community-????????T??????Z.dump' \
    -mtime +"$BACKUP_RETENTION_DAYS" -delete
fi
