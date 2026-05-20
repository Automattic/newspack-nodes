#!/bin/bash
#
# Build release zip for the newspack-nodes plugin.
#
# Output: release/newspack-nodes.zip — the plugin dir at the archive
# root, ready for: wp plugin install --force --activate <url>.zip
#

set -euo pipefail

# Keep macOS from emitting AppleDouble (._foo) sidecars into the archive.
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="${SCRIPT_DIR}/release"
STAGING_DIR="${SCRIPT_DIR}/.release-staging"
PLUGIN="newspack-nodes"

rm -rf "${RELEASE_DIR}" "${STAGING_DIR}"
mkdir -p "${RELEASE_DIR}"

echo "=== Building assets ==="
(cd "${SCRIPT_DIR}" && npm run build --silent)

echo "=== Staging plugin files ==="
mkdir -p "${STAGING_DIR}/${PLUGIN}"
rsync -a --exclude-from="${SCRIPT_DIR}/.distignore" "${SCRIPT_DIR}/" "${STAGING_DIR}/${PLUGIN}/"

# Production autoloader is built in the staging copy, so the dev vendor/
# (phpunit etc.) is never disturbed.
echo "=== Building production autoloader in staging ==="
(cd "${STAGING_DIR}/${PLUGIN}" && composer install --no-dev --optimize-autoloader --quiet)

find "${STAGING_DIR}/${PLUGIN}" \( -name '._*' -o -name '.DS_Store' \) -delete
rm -f "${STAGING_DIR}/${PLUGIN}"/composer.*

echo "=== Creating release zip ==="
echo "  ${PLUGIN}.zip"
(cd "${STAGING_DIR}" && zip -rqX "${RELEASE_DIR}/${PLUGIN}.zip" "${PLUGIN}" --exclude '*/._*' --exclude '*/.DS_Store')

rm -rf "${STAGING_DIR}"

echo ""
echo "=== Release artifacts ==="
ls -lh "${RELEASE_DIR}"/*
