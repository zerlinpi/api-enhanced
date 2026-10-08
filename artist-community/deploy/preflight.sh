#!/usr/bin/env bash
# Run from the production server before the first release or upgrade.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE is missing; copy and configure .env.production.example" >&2
  exit 1
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo 'ERROR: Docker and the Compose plugin must be installed' >&2
  exit 1
fi

# Fail early if sample settings were left in place.
for key in SITE_DOMAIN PUBLIC_BASE_URL DATABASE_URL POSTGRES_PASSWORD MAIL_HOST MAIL_USER MAIL_PASSWORD MAIL_FROM ARTIST_COMMUNITY_ADMIN_TOKEN ADMIN_BASIC_USER ADMIN_BASIC_HASH; do
  if ! grep -Eq "^${key}=[^[:space:]]+" "$ENV_FILE"; then
    echo "ERROR: missing production setting $key" >&2
    exit 1
  fi
done

if grep -Eiq '(replace-with|example\.com|change-me|your-unique-admin-password)' "$ENV_FILE"; then
  echo 'ERROR: example credentials or sample domain still present' >&2
  exit 1
fi

if ! grep -Eq '^PUBLIC_BASE_URL=https://[^/[:space:]]+/?$' "$ENV_FILE"; then
  echo 'ERROR: PUBLIC_BASE_URL must be an HTTPS site URL' >&2
  exit 1
fi

if grep -Eq '^MAIL_MODE=console' "$ENV_FILE"; then
  echo 'ERROR: console mode is not allowed for production user mail' >&2
  exit 1
fi

if [[ "$(stat -c '%a' "$ENV_FILE")" != '600' ]]; then
  echo "ERROR: $ENV_FILE should have mode 600" >&2
  exit 1
fi

ENV_FILE="$ENV_FILE" bash deploy/compose.sh config --quiet
docker info >/dev/null
echo 'Preflight passed: Compose variables and Docker are ready.'
echo 'Still confirm DNS, inbound ports 80/443, mail delivery and TLS issuance separately.'
