#!/bin/bash
#
# Build release zip for the newspack-nodes plugin.
#
# Produces a single zip containing the plugin directory at the root,
# ready for: wp plugin install --force --activate <url>.zip
#
# Usage: ./build-release.sh
# Output: release/newspack-nodes.zip
#

set -euo pipefail

# Stop macOS BSD tooling from emitting AppleDouble (._foo) sidecars when it
# can't preserve xattrs in the destination format. Without this, .zip and .tgz
# artifacts ship with ._<name>.php files that WordPress dutifully includes
# alongside the real plugin code, dumping AppleDouble bytes to stdout.
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="${SCRIPT_DIR}/release"
STAGING_DIR="${SCRIPT_DIR}/.release-staging"
PLUGIN="newspack-nodes"

# Clean previous builds.
rm -rf "${RELEASE_DIR}" "${STAGING_DIR}"
mkdir -p "${RELEASE_DIR}"

# Build React bundles. The rsync stage excludes `src/` but includes
# `build/`, so whatever's on disk at this point is what ships. Run
# `npm run build` here so the zip always carries fresh artifacts —
# previously, the script relied on whatever the developer had built
# locally, which is how v0.1.21 shipped without build/topology-console
# (the admin enqueue then silently bails on the missing asset.php and
# the React tree never mounts).
echo "=== Building React bundles ==="
(cd "${SCRIPT_DIR}" && npm run build --silent)

# Stage plugin into a clean directory.
echo "=== Staging plugin files ==="
mkdir -p "${STAGING_DIR}/${PLUGIN}"

# Copy plugin files, excluding dev artifacts per .distignore. Source
# `vendor/` is excluded there — we regenerate a production-only vendor
# inside staging below, so the developer's dev install (with phpunit
# etc.) is never disturbed by a release build. `composer.json` /
# `composer.lock` are NOT excluded by .distignore so they ride along
# for the in-staging install; they're removed before the zip step
# since the released plugin doesn't need them.
rsync -a --exclude-from="${SCRIPT_DIR}/.distignore" "${SCRIPT_DIR}/" "${STAGING_DIR}/${PLUGIN}/"

# Generate the production autoloader inside staging. Source vendor is
# untouched — the dev environment survives a release build.
echo "=== Building production autoloader in staging ==="
(cd "${STAGING_DIR}/${PLUGIN}" && composer install --no-dev --optimize-autoloader --quiet)

# Belt-and-suspenders: scrub anything the rsync excludes might've missed.
find "${STAGING_DIR}/${PLUGIN}" \( -name '._*' -o -name '.DS_Store' \) -delete

# Strip composer.* now (they had to ride along for the in-staging install,
# but the released plugin doesn't need them).
rm -f "${STAGING_DIR}/${PLUGIN}"/composer.*

# Create zip with plugin dir at root (required for wp plugin install).
# -X strips extra file attributes; -x patterns block AppleDouble re-entry.
echo "=== Creating release zip ==="
echo "  ${PLUGIN}.zip"
(cd "${STAGING_DIR}" && zip -rqX "${RELEASE_DIR}/${PLUGIN}.zip" "${PLUGIN}" --exclude '*/._*' --exclude '*/.DS_Store')

# Clean up.
rm -rf "${STAGING_DIR}"

echo ""
echo "=== Release artifacts ==="
ls -lh "${RELEASE_DIR}"/*
