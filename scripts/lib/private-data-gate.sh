#!/bin/sh
#
# private-data-gate.sh — the private-data gate's switch, shared by the hooks.
#
# Sourced by pre-commit, commit-msg and pre-push; not executable. A plugin
# turns the gate on with one constant in its own scripts/pre-push.local,
# `readonly PRIVATE_DATA_GATE=1`, which the sync never touches.
#
# The .local is a bash file that pre-push sources whole, so the two sh hooks
# never source it: they read the one line instead, and so does pre-push, so
# all three hooks agree on what a setting means.

# private_data_gate LOCAL — prints 1 when LOCAL turns the gate on, 0 when it is
# unset or 0; any other setting, or a second one, fails naming both.
private_data_gate() {
	[ -f "$1" ] || { echo 0; return 0; }
	awk -v file="$1" '
		/^[[:space:]]*#/ { next }
		/PRIVATE_DATA_GATE/ {
			line = $0
			sub(/^[[:space:]]*(readonly[[:space:]]+)?/, "", line)
			if (line ~ /^PRIVATE_DATA_GATE=("[01]"|[01])[[:space:]]*$/) {
				seen++
				value = (line ~ /=("1"|1)/) ? 1 : 0
				next
			}
			odd = 1
		}
		END {
			if (odd || seen > 1) {
				printf "PRIVATE_DATA_GATE in %s must be one line setting 1 or 0\n", file > "/dev/stderr"
				exit 1
			}
			print seen ? value : 0
		}' "$1"
}
