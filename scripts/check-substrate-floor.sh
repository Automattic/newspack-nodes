#!/usr/bin/env bash
# Is this plugin's declared substrate floor high enough for the substrate APIs
# it actually calls?
#
# A floor set too LOW is the failure this exists for: the handshake passes, the
# plugin wires itself up, and then fatals on a method the older substrate does
# not have — where the whole point of the gate is that too-old means dormant.
#
# The API list comes from PHPStan, which resolves each call to its DECLARING
# class. Matching method NAMES instead cannot tell `$wpdb->prepare()` from a
# substrate `prepare()`, and since the floor is the MAX over what is found, one
# false match would pin the plugin dormant against a substrate that runs it fine.
#
# Needs the substrate checked out at ../newspack-nodes WITH its tags — the same
# assumption sync-shared-scripts.sh makes. Skips cleanly without one.
set -euo pipefail

cd "$( dirname "${BASH_SOURCE[0]}" )/.."
PLUGIN_DIR=$PWD
SUBSTRATE=../newspack-nodes

if [ ! -d "$SUBSTRATE/.git" ]; then
	echo "→ no substrate checkout at $SUBSTRATE — skipping floor check"
	exit 0
fi
if [ ! -x vendor/bin/phpstan ]; then
	echo "→ no phpstan — skipping floor check"
	exit 0
fi

declared=$( grep -rhoE "version_at_least\( *'[0-9]+\.[0-9]+\.[0-9]+'" ./*.php 2>/dev/null \
	| grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true )
if [ -z "$declared" ]; then
	echo "✓ floor check: this plugin declares no substrate floor"
	exit 0
fi

# PHPStan exits nonzero here by design: the collected APIs are its "errors".
apis=$( ./vendor/bin/phpstan analyse \
	-c scripts/phpstan-floor.neon \
	-a scripts/phpstan-substrate-floor.php \
	--memory-limit=2G --no-progress 2>/dev/null \
	| grep -oE 'SUBSTRATE_API [A-Za-z_\\]+::[a-zA-Z_0-9]+' | sed 's/^SUBSTRATE_API //' | sort -u || true )

if [ -z "$apis" ]; then
	echo "✗ floor check: PHPStan collected no substrate calls — the collector is not running"
	exit 1
fi

cd "$SUBSTRATE"
tags=$( git tag --sort=v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' )

# Does tag $1 define $2 (FQN::method)? Resolves the DECLARING class's own file,
# so an inherited call is answered where the method really lives.
# The file declaring class/trait/interface $2 at rev $1, as `rev:path`.
decl_file() {
	git grep -lE "^(final |abstract )?(class|trait|interface) ${2}( |\$)" "$1" -- includes/ 2>/dev/null | head -1
}

# Does the call `Class::method` RESOLVE at rev $1? Not "is it declared on that
# exact class" — an override added later (Timer_Node::name over Node::name)
# resolved through the parent all along, and counting it would pin the floor
# ABOVE what the code needs, leaving a plugin dormant against a substrate that
# runs it fine. So walk traits, then parents, exactly as PHP would.
has_api() {
	local tag=$1 fqn=${2%%::*} method=${2##*::} short file trait tfile parent depth=0
	short=${fqn##*\\}
	# `git grep -l` at a rev yields `rev:path`, which `git show` takes whole.
	file=$( decl_file "$tag" "$short" ) || true
	if [ -z "$file" ]; then
		return 1
	fi
	if git show "$file" 2>/dev/null | grep -qE "function ${method}\("; then
		return 0
	fi
	# @longform Reflection attributes a TRAIT's method to the class that uses
	# it, so the declaring class PHPStan reports may not be where the method is
	# written — Timer_Node::parse_schema_args lives in Schema_Reflection. A
	# trait use is indented inside the class body; a namespace import is not,
	# which is what tells the two `use` forms apart here.
	for trait in $( git show "$file" 2>/dev/null | grep -E "^[[:space:]]+use [A-Z][A-Za-z_]*[,;]" | tr -d '\t ;' | sed 's/^use//' | tr ',' '\n' ); do
		tfile=$( decl_file "$tag" "$trait" ) || true
		if [ -n "$tfile" ] && git show "$tfile" 2>/dev/null | grep -qE "function ${method}\("; then
			return 0
		fi
	done
	# Up the extends chain; the depth cap is a cycle guard, not a real limit.
	parent=$short
	while [ "$depth" -lt 12 ]; do
		depth=$(( depth + 1 ))
		file=$( decl_file "$tag" "$parent" ) || true
		if [ -z "$file" ]; then
			return 1
		fi
		parent=$( git show "$file" 2>/dev/null \
			| grep -m1 -oE "^(final |abstract )?class ${parent} extends [A-Za-z_\\\\]+" \
			| sed 's/.* extends //; s/.*\\\\//' ) || true
		if [ -z "$parent" ]; then
			return 1
		fi
		file=$( decl_file "$tag" "$parent" ) || true
		if [ -n "$file" ] && git show "$file" 2>/dev/null | grep -qE "function ${method}\("; then
			return 0
		fi
	done
	return 1
}

# The first tag carrying $1, by binary search — presence is monotonic.
first_tag_with() {
	local api=$1 lo=1 hi mid t ans=""
	hi=$( echo "$tags" | wc -l | tr -d ' ' )
	while [ "$lo" -le "$hi" ]; do
		mid=$(( ( lo + hi ) / 2 ))
		t=$( echo "$tags" | sed -n "${mid}p" )
		if has_api "$t" "$api"; then ans=$t; hi=$(( mid - 1 )); else lo=$(( mid + 1 )); fi
	done
	echo "$ans"
}

newer=""
unresolved=()
true_floor=$declared
for api in $apis; do
	if has_api "v$declared" "$api"; then
		continue
	fi
	intro=$( first_tag_with "$api" )
	if [ -z "$intro" ]; then
		unresolved+=( "$api" )
		continue
	fi
	newer+="  ${intro#v}  $api"$'\n'
	if [ "$( printf '%s\n%s\n' "${intro#v}" "$true_floor" | sort -V | tail -1 )" = "${intro#v}" ]; then
		true_floor=${intro#v}
	fi
done

cd "$PLUGIN_DIR"

# Absent at the declared floor AND absent from every tag means the LOOKUP is
# broken, not that the API is old. Left silent, that turns this gate into a
# green light that cannot fail — which is exactly how it behaved when the class
# regex used a `\b` that git grep does not support.
if [ ${#unresolved[@]} -gt 0 ]; then
	echo "✗ floor check: ${#unresolved[@]} substrate APIs resolve to no tag at all:"
	printf '    %s\n' "${unresolved[@]}" | head -10
	echo "  The tag lookup is broken; fix it rather than trusting the result."
	exit 1
fi

if [ "$true_floor" = "$declared" ]; then
	echo "✓ floor check: $declared covers every substrate API called ($( echo "$apis" | wc -l | tr -d ' ' ) resolved)"
	exit 0
fi

echo "✗ floor check: declared $declared, but these substrate APIs are newer:"
printf '%s' "$newer" | sort -V
echo
echo "  Raise the floor to $true_floor. A floor below what the code calls does not"
echo "  degrade — the plugin activates and then fatals on the missing method."
exit 1
