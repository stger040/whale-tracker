#!/usr/bin/env bash
# Provisions / redeploys the whale-tracker EC2 box (Ubuntu 24.04 arm64). Idempotent; runs as root.
#   - code:    s3://$BUCKET/releases/whale-tracker.tgz  (git archive, no GitHub token needed)
#   - secrets: SSM Parameter Store /whale-tracker/*      (SecureString)
# Re-run after uploading a new tarball:  sudo /opt/whale-tracker/infra/ec2/bootstrap.sh
set -euo pipefail
BUCKET="${BUCKET:-whale-tracker-deploy-597341304953}"
REGION=us-east-1
APP=/opt/whale-tracker
NODE_VERSION=v22.12.0

command -v aws >/dev/null || snap install aws-cli --classic
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi

id whale >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin whale
mkdir -p "$APP" /var/log/whale-tracker
aws s3 cp --region "$REGION" "s3://$BUCKET/releases/whale-tracker.tgz" /tmp/whale-tracker.tgz
tar -xzf /tmp/whale-tracker.tgz -C "$APP"
chown -R whale:whale "$APP" /var/log/whale-tracker

# Secrets → root-only env file read by systemd. Never written into the app dir.
{
  echo "WHALE_DATABASE_URL=$(aws ssm get-parameter --region "$REGION" --name /whale-tracker/WHALE_DATABASE_URL --with-decryption --query Parameter.Value --output text)"
  echo "WHALE_DB_DRIVER=pg"
  echo "KALSHI_REQ_PER_SEC=8"
  echo "MIN_STORE_USD=500"
  echo "TZ=America/Chicago"
} > /etc/whale-tracker.env
chmod 600 /etc/whale-tracker.env

sudo -u whale -H bash -c "cd $APP && /usr/local/bin/npm ci --no-audit --no-fund"
systemd-run --wait --pipe --quiet -p User=whale -p EnvironmentFile=/etc/whale-tracker.env \
  -p WorkingDirectory="$APP/apps/collector" -p Environment=PATH=/usr/local/bin:/usr/bin:/bin \
  "$APP/node_modules/.bin/tsx" src/migrate.ts

install -m 644 "$APP/infra/ec2/whale-backfill.service" /etc/systemd/system/whale-backfill.service
systemctl daemon-reload
systemctl enable whale-backfill.service
systemctl restart whale-backfill.service
echo "[bootstrap] done $(date -Is)"
