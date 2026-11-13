#!/usr/bin/env bash
# Publishes the app image to the ECR repository, where the Fargate recorder tasks start from.
# Run after building (install.sh / update.sh call it when ECR_REPOSITORY_URI is set in deploy/.env).
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

repo="$(grep '^ECR_REPOSITORY_URI=' .env | cut -d= -f2-)"
region="$(grep '^AWS_REGION=' .env | cut -d= -f2-)"
if [ -z "$repo" ]; then
  echo "ECR_REPOSITORY_URI is not set in deploy/.env - nothing to push."
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "Installing the AWS CLI"
  $SUDO snap install aws-cli --classic
fi

# The image docker compose built for the dashboard ("<project>-<service>")
local_image="lecture-recorder-app:latest"
if ! $SUDO docker image inspect "$local_image" >/dev/null 2>&1; then
  $SUDO docker compose build app
fi

aws ecr get-login-password --region "$region" | $SUDO docker login --username AWS --password-stdin "${repo%%/*}"
$SUDO docker tag "$local_image" "$repo:latest"
$SUDO docker push "$repo:latest"
echo "Recorder image published: $repo:latest (new recorders use it; running ones are not affected)"
