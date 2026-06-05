#!/bin/bash
#
# Build release zips for the newspack-nodes plugin and its bundled examples.
#
# Output:
#   release/newspack-nodes.zip   — the runtime plugin (examples/ excluded)
#   release/<example-dir>.zip    — each examples/*/ as its own installable plugin
# All at the archive root, ready for: wp plugin install --force --activate <url>.zip
#
set -euo pipefail
export COPYFILE_DISABLE=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="${SCRIPT_DIR}/release"
STAGING_DIR="${SCRIPT_DIR}/.release-staging"
PLUGIN="newspack-nodes"
rm -rf "${RELEASE_DIR}" "${STAGING_DIR}"
mkdir -p "${RELEASE_DIR}"

# Build one installable plugin zip from <source_dir> <slug>, with the same steps
# the main plugin uses: build JS/CSS (when the package ships a build), stage
# minus .distignore, build the production composer autoloader in staging, strip
# dev files, zip.
build_plugin_zip() {
	local src="$1" slug="$2"
	echo "=== ${slug} ==="
	if [ -f "${src}/package.json" ]; then
		echo "  assets (npm build)"
		( cd "${src}" && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent )
	fi
	echo "  staging"
	mkdir -p "${STAGING_DIR}/${slug}"
	rsync -a --exclude-from="${SCRIPT_DIR}/.distignore" "${src}/" "${STAGING_DIR}/${slug}/"
	if [ -f "${STAGING_DIR}/${slug}/composer.json" ]; then
		echo "  composer (production autoloader)"
		( cd "${STAGING_DIR}/${slug}" && composer install --no-dev --optimize-autoloader --quiet )
	fi
	find "${STAGING_DIR}/${slug}" \( -name '._*' -o -name '.DS_Store' \) -delete
	rm -f "${STAGING_DIR}/${slug}"/composer.*
	echo "  ${slug}.zip"
	( cd "${STAGING_DIR}" && zip -rqX "${RELEASE_DIR}/${slug}.zip" "${slug}" --exclude '*/._*' --exclude '*/.DS_Store' )
	rm -rf "${STAGING_DIR}/${slug}"
}

# Examples first — each builds into its own installable zip (dir name = slug).
if [ -d "${SCRIPT_DIR}/examples" ]; then
	for example_dir in "${SCRIPT_DIR}"/examples/*/; do
		[ -d "${example_dir}" ] || continue
		build_plugin_zip "${example_dir%/}" "$(basename "${example_dir}")"
	done
fi

# Main plugin last — .distignore excludes examples/ (shipped as their own zips).
build_plugin_zip "${SCRIPT_DIR}" "${PLUGIN}"

rm -rf "${STAGING_DIR}"
echo ""
echo "=== Release artifacts ==="
ls -lh "${RELEASE_DIR}"/*
