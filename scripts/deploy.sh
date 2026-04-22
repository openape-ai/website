#!/usr/bin/env bash
#
# Deploy the static openape.ai site to a remote host via rsync + symlink swap.
# Host-agnostic: every deploy-target specific value comes from the environment.
#
# Required env:
#   DEPLOY_HOST     SSH alias or hostname of the target
#
# Optional env:
#   DEPLOY_USER     SSH user (default: "openape")
#   DEPLOY_BASE     Base directory on target (default: /home/${DEPLOY_USER}/projects/website)
#   DEPLOY_RELOAD   Reload command on target (default: "sudo systemctl reload nginx")
#
# Release layout on target:
#   ${DEPLOY_BASE}/
#     ├─ releases/<TS>/          timestamped, 3 most recent kept
#     └─ current -> releases/<TS>
#
# nginx serves `${DEPLOY_BASE}/current` directly. No app server, no systemd
# unit, no port. Nginx picks up new files instantly; the reload is only to
# flush FD caches after a symlink swap (safe, cheap, idempotent).

set -euo pipefail

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
DEPLOY_USER="${DEPLOY_USER:-openape}"
DEPLOY_BASE="${DEPLOY_BASE:-/home/${DEPLOY_USER}/projects/website}"
DEPLOY_RELOAD="${DEPLOY_RELOAD:-sudo systemctl reload nginx}"

TS=$(date -u +%Y-%m-%dT%H-%M-%S)
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "→ Ensure layout on target"
ssh "${TARGET}" "mkdir -p ${DEPLOY_BASE}/releases"

echo "→ Rsync to ${TARGET}:${DEPLOY_BASE}/releases/${TS}/"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.vercel/' \
  --exclude='.DS_Store' \
  --exclude='LICENSE' \
  --exclude='README.md' \
  --exclude='scripts/' \
  --exclude='CHANGELOG.md' \
  "${REPO_ROOT}/" \
  "${TARGET}:${DEPLOY_BASE}/releases/${TS}/"

echo "→ Swap current symlink"
ssh "${TARGET}" "ln -sfn ${DEPLOY_BASE}/releases/${TS} ${DEPLOY_BASE}/current"

echo "→ Reload nginx"
ssh "${TARGET}" "${DEPLOY_RELOAD}"

echo "→ Prune old releases (keep last 3)"
ssh "${TARGET}" "ls -1t ${DEPLOY_BASE}/releases/ | tail -n +4 | xargs -r -I{} rm -rf ${DEPLOY_BASE}/releases/{}"

echo
echo "✓ Deployed ${TS}"
