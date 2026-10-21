#!/usr/bin/env bash
# Renders /etc/whale-tracker.env from SSM Parameter Store /whale-tracker/* (+ static settings).
# MUST run under bash: SSM's AWS-RunShellScript uses sh/dash, whose `echo` expands "\n" in the
# Kalshi PEM and which doesn't understand $'\t'. Invoke as: bash infra/ec2/render-env.sh
# Never print this file's contents — it holds private keys.
set -euo pipefail
REGION=us-east-1
OUT=/etc/whale-tracker.env
TMP="$(mktemp /etc/whale-tracker.env.XXXXXX)"
chmod 600 "$TMP"
{
  aws ssm get-parameters-by-path --region "$REGION" --path /whale-tracker/ --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do printf "%s='%s'\n" "${name##*/}" "$value"; done
  printf '%s\n' WHALE_DB_DRIVER=pg KALSHI_REQ_PER_SEC=8 MIN_STORE_USD=500 WHALE_LOG_MIN_USD=5000 TZ=America/Chicago WHALE_LEAGUES=NBA,NFL
} > "$TMP"
# Sanity: every line must be NAME=... (catches mangled multi-line values) — report names only.
if bad=$(grep -vcE '^[A-Z][A-Z0-9_]*=' "$TMP"); [ "$bad" -ne 0 ]; then
  echo "[render-env] $bad malformed line(s); keeping existing $OUT" >&2
  rm -f "$TMP"; exit 1
fi
mv "$TMP" "$OUT"
echo "[render-env] wrote $(wc -l < "$OUT") vars: $(cut -d= -f1 "$OUT" | tr '\n' ' ')"
