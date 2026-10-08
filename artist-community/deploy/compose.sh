#!/usr/bin/env bash
# Choose bundled Caddy or a server's existing reverse proxy based on local settings.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${ENV_FILE:-.env.production}"
files=(-f docker-compose.prod.yml)
if [[ -f "$env_file" ]] && grep -Eq '^PROXY_MODE=external$' "$env_file"; then
  files+=(-f docker-compose.external-proxy.yml)
fi
exec docker compose --env-file "$env_file" "${files[@]}" "$@"
