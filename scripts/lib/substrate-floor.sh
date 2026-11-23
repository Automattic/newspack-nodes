# shellcheck shell=bash
#
# substrate-floor.sh — the substrate floor a plugin declares, read one way.
#
# Sourced by check-substrate-floor.sh, which holds the floor to the APIs the
# plugin reaches, and by lint-docs.sh, which holds the prose to the floor.

# declared_floor — the floor the plugin in the working directory declares, or
# nothing: the version its plugin file hands version_at_least(), else the one a
# class under includes/ holds as NODES_FLOOR.
declared_floor() {
	{
		grep -hoE "version_at_least\( *'[0-9]+\.[0-9]+\.[0-9]+'" ./*.php
		if [ -d includes ]; then
			grep -rhoE --include='*.php' "const NODES_FLOOR += +'[0-9]+\.[0-9]+\.[0-9]+'" includes
		fi
	} | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true
}
