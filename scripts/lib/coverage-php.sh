# shellcheck shell=bash
#
# coverage-php.sh — the one choice of coverage driver.
#
# Every plugin's tests/run-coverage.sh sources this, and pyrobase's pre-push
# for its WordPress suite. coverage_php ROOT turns Xdebug off and leaves in
# COVERAGE_PHP the php command that runs a suite under PCOV, scoped to the
# plugin at ROOT:
#
#   . "$root/scripts/lib/coverage-php.sh"
#   coverage_php "$root"
#   "${COVERAGE_PHP[@]}" vendor/bin/phpunit --coverage-clover "$clover"
#
# The images load PCOV with pcov.enabled=0, so a plain run pays nothing for it;
# only a command carrying these flags collects. PHPUnit's coverage library
# prefers PCOV whenever it is enabled, and hands these settings to a separate
# test process itself.

# Arms COVERAGE_PHP for the plugin at $1, or stops the caller naming what is missing.
coverage_php() {
	local root="$1"
	if [[ -z "$root" ]]; then
		echo "coverage_php: name the plugin root PCOV covers" >&2
		exit 1
	fi
	if ! php --ri pcov >/dev/null; then
		echo "coverage_php: php8.4-pcov is not loaded; the image installs it, so rebuild this container's image" >&2
		exit 1
	fi

	export XDEBUG_MODE=off
	# shellcheck disable=SC2034 # the caller runs this array
	COVERAGE_PHP=( php -d pcov.enabled=1 -d "pcov.directory=$root" -d 'pcov.exclude=~/(vendor|node_modules|tests)/~' )
}
