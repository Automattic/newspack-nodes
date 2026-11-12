#!/usr/bin/env bash
# Is this plugin's declared substrate floor high enough for the substrate APIs
# it reaches?
#
# A floor set too LOW is the failure this exists for: the handshake passes, the
# plugin wires itself up, and then fatals on a method, a constant, a static
# property or a class the older substrate does not have — where the whole point
# of the gate is that too-old means dormant.
#
# The API list comes from PHPStan, which resolves each access to its DECLARING
# class. Matching NAMES instead cannot tell `$wpdb->prepare()` from a substrate
# `prepare()`, and since the floor is the MAX over what is found, one false
# match would pin the plugin dormant against a substrate that runs it fine.
# substrate-floor-index.php then parses the substrate at each tag it probes and
# says where each API stands; this script reads the verdicts.
#
# Needs the substrate checked out at ../newspack-nodes WITH its tags — the same
# assumption sync-shared-scripts.sh makes. Skips cleanly without a checkout.
set -euo pipefail

cd "$( dirname "${BASH_SOURCE[0]}" )/.."
SUBSTRATE=../newspack-nodes

if [ ! -d "$SUBSTRATE/.git" ]; then
	echo "→ no substrate checkout at $SUBSTRATE — skipping floor check"
	exit 0
fi
if [ ! -x vendor/bin/phpstan ]; then
	echo "→ no phpstan — skipping floor check"
	exit 0
fi

declared=$( grep -hoE "version_at_least\( *'[0-9]+\.[0-9]+\.[0-9]+'" ./*.php \
	| grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true )
if [ -z "$declared" ]; then
	echo "✓ floor check: this plugin declares no substrate floor"
	exit 0
fi

tags=$( git -C "$SUBSTRATE" tag --list --sort=v:refname 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true )
if [ -z "$tags" ]; then
	echo "✗ floor check: $SUBSTRATE has no vX.Y.Z tags — a shallow clone? Fetch its tags."
	exit 1
fi
if ! printf '%s\n' "$tags" | grep -qxF "v$declared"; then
	echo "✗ floor check: the floor names no tag v$declared in $SUBSTRATE"
	exit 1
fi

out=$( mktemp )
err=$( mktemp )
trap 'rm -f "$out" "$err"' EXIT

# PHPStan exits 1 by design: the collected APIs are its "errors". Raw format
# puts one per line, where the default table wraps a long name in two.
status=0
./vendor/bin/phpstan analyse \
	-c scripts/phpstan-floor.neon \
	-a scripts/phpstan-substrate-floor.php \
	--error-format=raw --memory-limit=2G --no-progress > "$out" 2> "$err" || status=$?

# Every other line is an error, whatever its path: an API list can be partial.
others=$( grep -vF 'SUBSTRATE_API ' "$out" | grep -v '^[[:space:]]*$' || true )
if [ "$status" -gt 1 ] || [ -n "$others" ]; then
	echo "✗ floor check: PHPStan reported errors besides the substrate APIs (exit $status),"
	echo "  so its API list may be partial:"
	printf '%s\n' "$others" | sed 's/^/    /'
	sed 's/^/    /' "$err"
	exit 1
fi

apis=$( grep -oE 'SUBSTRATE_API [A-Za-z0-9_\\]+((::|->)[$]?[A-Za-z_0-9]+(\(\))?(#protected|#private)?)?' "$out" \
	| sed 's/^SUBSTRATE_API //' | sort -u || true )
if [ -z "$apis" ]; then
	echo "✗ floor check: PHPStan collected no substrate APIs — the collector is not running"
	sed 's/^/    /' "$err"
	exit 1
fi

# shellcheck disable=SC2086 # one argument per tag
if ! verdicts=$( printf '%s\n' "$apis" | php scripts/substrate-floor-index.php "$SUBSTRATE" "v$declared" $tags ); then
	echo "✗ floor check: the substrate index failed (see above)"
	exit 1
fi

asked=$( printf '%s\n' "$apis" | wc -l | tr -d ' ' )
answered=$( printf '%s\n' "$verdicts" | grep -cE '^(ok|newer|unreleased|dropped|unresolved) ' || true )
if [ "$answered" != "$asked" ]; then
	echo "✗ floor check: the substrate index answered for $answered of $asked APIs"
	exit 1
fi

# verdict KIND — the lines the index gave that verdict, less the KIND, each
# reach suffix said in words.
verdict() {
	printf '%s\n' "$verdicts" | awk -v kind="$1" '$1 == kind {
		line = $2
		for ( i = 3; i <= NF; i++ ) line = line "  " $i
		print line
	}' | sed 's/#protected$/ (from a subclass)/; s/#private$/ (from the class using its trait)/'
}
newer=$( verdict newer | sort -V )
dropped=$( verdict dropped )
unreleased=$( verdict unreleased )
unresolved=$( verdict unresolved )
broken=$( printf '%s\n' "$verdicts" | sed -n 's/^broken //p' )

# say_broken — name each file that would not parse, whose classes read as missing.
say_broken() {
	if [ -n "$broken" ]; then
		echo "  These substrate files would not parse, so what they declare reads as missing:"
		printf '%s\n' "$broken" | sed 's/^/    /'
	fi
}

# Absent from every tag and the working tree means the LOOKUP is broken, not
# that the API is old. Left silent, the gate becomes a green light that
# cannot fail.
if [ -n "$unresolved" ]; then
	echo "✗ floor check: $( printf '%s\n' "$unresolved" | wc -l | tr -d ' ' ) substrate APIs do not resolve to any tag or to the working tree:"
	printf '%s\n' "$unresolved" | head -10 | sed 's/^/    /'
	say_broken
	echo "  The tag lookup is broken, or a file above will not parse; fix it rather"
	echo "  than trusting the result."
	exit 1
fi

if [ -z "$newer$dropped$unreleased" ]; then
	echo "✓ floor check: $declared covers every substrate API reached ($( printf '%s\n' "$apis" | wc -l | tr -d ' ' ) resolved)"
	exit 0
fi

if [ -n "$newer" ]; then
	echo "✗ floor check: declared $declared, but these substrate APIs are newer:"
	printf '%s\n' "$newer" | sed 's/^/  /'
	echo
	echo "  Raise the floor to $( printf '%s\n' "$newer" | tail -1 | cut -d' ' -f1 ). A floor below what the code reaches does"
	echo "  not degrade — the plugin activates and then fatals on the missing API."
fi
if [ -n "$dropped" ]; then
	echo "✗ floor check: these substrate APIs resolve at an older tag but not at v$declared:"
	printf '%s\n' "$dropped" | sed 's/^/  /'
	echo
	echo "  The substrate dropped them, or the lookup misses where they moved; find"
	echo "  out which rather than trusting the result."
fi
if [ -n "$unreleased" ]; then
	echo "✗ floor check: these substrate APIs are in $SUBSTRATE's working tree but in no tag yet:"
	printf '%s\n' "$unreleased" | sed 's/^/  /'
	echo
	echo "  Release the substrate carrying them, then raise the floor to that release."
fi
say_broken
exit 1
