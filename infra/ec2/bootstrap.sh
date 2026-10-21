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

# Secrets → root-only env file read by systemd (never written into the app dir).
bash "$APP/infra/ec2/render-env.sh"

sudo -u whale -H bash -c "cd $APP && /usr/local/bin/npm ci --no-audit --no-fund"
systemd-run --wait --pipe --quiet -p User=whale -p EnvironmentFile=/etc/whale-tracker.env \
  -p WorkingDirectory="$APP/apps/collector" -p Environment=PATH=/usr/local/bin:/usr/bin:/bin \
  "$APP/node_modules/.bin/tsx" src/migrate.ts

for unit in whale-backfill.service whale-live.service whale-backfill-daily.service whale-backfill-daily.timer; do
  install -m 644 "$APP/infra/ec2/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable whale-backfill.service whale-live.service
systemctl enable --now whale-backfill-daily.timer
# Backfill is resumable; only start it if it isn't already running (or finished).
systemctl is-active --quiet whale-backfill.service || systemctl start whale-backfill.service
systemctl restart whale-live.service
echo "[bootstrap] done $(date -Is)"
