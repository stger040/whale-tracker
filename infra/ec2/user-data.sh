#!/usr/bin/env bash
# EC2 user data: fetch the release tarball and hand off to the repo's bootstrap script.
set -euxo pipefail
exec > /var/log/whale-bootstrap.log 2>&1
snap install aws-cli --classic || true
until aws s3 cp --region us-east-1 s3://whale-tracker-deploy-597341304953/releases/whale-tracker.tgz /tmp/whale-tracker.tgz; do sleep 10; done
mkdir -p /opt/whale-tracker && tar -xzf /tmp/whale-tracker.tgz -C /opt/whale-tracker
bash /opt/whale-tracker/infra/ec2/bootstrap.sh
