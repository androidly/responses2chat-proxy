#!/usr/bin/env sh
set -eu

# Production defaults for completions-proxy
export PORT="${PORT:-3088}"
export REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-90000}"
export ALLOWED_UPSTREAM_HOSTS="${ALLOWED_UPSTREAM_HOSTS:-api.example.com}"

# Keep log in /tmp by default (override with PROXY_LOG)
LOG_FILE="${PROXY_LOG:-/tmp/proxy.log}"

exec node /root/completions-proxy/proxy.mjs >>"$LOG_FILE" 2>&1
