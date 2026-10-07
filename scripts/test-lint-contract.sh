#!/usr/bin/env bash
# shellcheck disable=SC2016 # the fixtures are PHP source, written verbatim
#
# test-lint-contract.sh — tests for the contract gate's PHP rules and its walk.
#
# Each case builds a throwaway plugin dir and runs the gate with that dir as
# its cwd, because the gate reads `src/`, `examples/` and `includes/` relative
# to where it runs.

set -u
cd "$( dirname "$0" )" || exit 2
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }
gate="$( pwd )/lint-contract.mjs"

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# fixture NAME RELPATH BODY — one throwaway plugin dir holding one file.
fixture() {
	local dir="$tmp/$1"
	mkdir -p "$dir/$( dirname "$2" )"
	printf '%s\n' "$3" > "$dir/$2"
	echo "$dir"
}

# assert_flags LABEL DIR NEEDLE [ARGS…] — exit 1 and report NEEDLE.
assert_flags() {
	local label="$1" dir="$2" needle="$3" out status
	shift 3
	out="$( cd "$dir" && node "$gate" "$@" 2>&1 )"; status=$?
	if [[ $status -eq 1 && "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 1 mentioning '$needle'; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL DIR [ARGS…] — exit 0.
assert_clean() {
	local label="$1" dir="$2" out status
	shift 2
	out="$( cd "$dir" && node "$gate" "$@" 2>&1 )"; status=$?
	if [[ $status -eq 0 ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 0; got exit $status:"
		echo "$out"
		fail=1
	fi
}

bare='$ok = Capabilities::require( '"'"'tune'"'"' );'
scope='$ok = scope_covers( Capabilities::$session_scope, 3 );'
verb='$ok = Capabilities::require_verb( '"'"'tune'"'"' );'
gate_line='$ok = Capabilities::require( '"'"'tune'"'"' );'

d=$( fixture require includes/class-widget.php "$bare" )
assert_flags "Capabilities::require( is flagged" "$d" "[scope-check-in-handler]"

d=$( fixture qualified includes/class-widget.php '$ok = \Newspack_Nodes\Capabilities::require( '"'"'tune'"'"' );' )
assert_flags "a qualified Capabilities::require( is flagged" "$d" "[scope-check-in-handler]"

d=$( fixture verb includes/class-widget.php "$verb" )
assert_clean "Capabilities::require_verb( is not flagged" "$d"

d=$( fixture owner includes/class-capabilities.php "$gate_line" )
assert_clean "class-capabilities.php may call require(" "$d"

d=$( fixture scope includes/class-widget.php "$scope" )
assert_flags "a verb checking the session scope is still flagged" "$d" "[scope-check-in-handler]"

d=$( fixture release examples/demo/release/class-widget.php "$scope" )
assert_clean "a release/ tree is not walked" "$d"

d=$( fixture tests includes/tests/class-widget.php "$scope" )
assert_clean "a tests/ tree is not walked" "$d"
assert_clean "a tests/ path named directly is not scanned" "$d" includes/tests/class-widget.php

d=$( fixture named includes/class-widget.php "$scope" )
assert_flags "a path named directly is scanned" "$d" "[scope-check-in-handler]" includes/class-widget.php

stamp_cases=(
	'$p = Log_Discovery::SOURCES_PREFIX . '"'"'/'"'"';'
	'$ok = \in_array( $g, Log_Discovery::GROUPS, true );'
	'$ok = \in_array( $g, Log_Discovery::STAMP_PREFIXES, true );'
	'$k = '"'"'logs'"'"' === $group ? $n : $g;'
	'$k = "offsets/{$n}";'
	'$ok = '"'"'logs'"'"' !== $group;'
	'$path = "{$base}/{$group}/{$rest}";'
	'$s = "remote/{$vault}:{$kind}";'
	'$ok = $group === '"'"'logs'"'"';'
	'$ok = '"'"'sources'"'"' === $g;'
	'$ok = \str_starts_with( $sub, Log_Discovery::SOURCES_PREFIX );'
	'[ $g, $n ] = \explode( '"'"'/'"'"', $stamp, 2 );'
	'$dir = "{$base_dir}/offsets/{$reader}";'
	'$dir = $base_dir . '"'"'/logs'"'"';'
)
for i in "${!stamp_cases[@]}"; do
	d=$( fixture "stamp$i" includes/class-widget.php "${stamp_cases[$i]}" )
	assert_flags "stamp grammar by hand is flagged: ${stamp_cases[$i]}" "$d" "[stamp-grammar-outside-discovery]"
done

d=$( fixture stamp-owner includes/class-log-discovery.php "${stamp_cases[1]}" )
assert_clean "class-log-discovery.php may read GROUPS" "$d"

d=$( fixture stamp-root includes/class-widget.php '$dir = Log_Discovery::root( $base_dir, '"'"'logs'"'"' ) . "/{$reader}";' )
assert_clean "a root joined through Log_Discovery::root() is not flagged" "$d"

d=$( fixture stamp-route includes/class-widget.php '$parts = \explode( '"'"'/'"'"', $to, 2 );' )
assert_clean "a TO path split on its slash is not flagged" "$d"

d=$( fixture stamp-writer includes/class-widget.php '$k = Log_Discovery::stamp_for( Log_Discovery::SOURCES_PREFIX, $n );' )
assert_clean "a stamp written through stamp_for() is not flagged" "$d"

fanout_use=$'<?php\nclass Widget_Node extends Node {\n\tuse Fanout_Targets;\n\tpublic function fill( array $m ): void {\n\t\t$this->sink?->fill( $m );\n\t}\n}'
d=$( fixture fanout-idle includes/class-widget-node.php "$fanout_use" )
assert_flags "a Fanout_Targets user that never fans out is flagged" "$d" "[fanout-without-fanout]"

for call in '$this->live_targets()' '$this->send_signed( $egress, $to, $verb, $args )'; do
	d=$( fixture "fanout-$RANDOM" includes/class-widget-node.php "${fanout_use/\$this->sink?->fill( \$m )/$call}" )
	assert_clean "a Fanout_Targets user calling ${call%%(*}( is not flagged" "$d"
done

for use_line in 'use Fanout_Targets, Schema_Reflection;' 'use Fanout_Targets {' 'use \Newspack_Nodes\Fanout_Targets;'; do
	d=$( fixture "fanout-use-$RANDOM" includes/class-widget-node.php "${fanout_use/use Fanout_Targets;/$use_line}" )
	assert_flags "a Fanout_Targets user written '$use_line' that never fans out is flagged" "$d" "[fanout-without-fanout]"
done

commented=$'<?php\nclass Widget_Node extends Node {\n\tuse Fanout_Targets;\n\t/**\n\t * Delivered by live_targets( $m ) elsewhere.\n\t */\n\tpublic function fill( array $m ): void {\n\t\t$this->sink?->fill( $m ); // send_signed( later )\n\t\t/* live_targets( never ) */\n\t}\n}'
d=$( fixture fanout-commented includes/class-widget-node.php "$commented" )
assert_flags "a Fanout_Targets user naming the calls only in comments is flagged" "$d" "[fanout-without-fanout]"

glob_string=$'<?php\nclass Widget_Node extends Node {\n\tuse Fanout_Targets;\n\tpublic function fill( array $m ): void {\n\t\t$logs = glob( "{$this->dir}/*.log" );\n\t\tforeach ( $this->live_targets( $m ) as $t ) {}\n\t}\n\t/** Sweep the logs. */\n\tpublic function sweep(): void {}\n}'
d=$( fixture fanout-glob includes/class-widget-node.php "$glob_string" )
assert_clean "a '/*' inside a string ahead of a real live_targets( is not flagged" "$d"

hash_string=$'<?php\nclass Widget_Node extends Node {\n\tuse Fanout_Targets;\n\tpublic function fill( array $m ): void {\n\t\t$tag = \'issue # 41\'; $this->send_signed( $m );\n\t}\n}'
d=$( fixture fanout-hash includes/class-widget-node.php "$hash_string" )
assert_clean "a '#' inside a string ahead of a real send_signed( is not flagged" "$d"

heredoc=$'<?php\nclass Widget_Node extends Node {\n\tuse Fanout_Targets;\n\tpublic function fill( array $m ): void {\n\t\t$sql = <<<SQL\nSELECT 1 /* hint\nSQL;\n\t\tforeach ( $this->live_targets( $m ) as $t ) {}\n\t}\n\t/** Doc. */\n\tpublic function sweep(): void {}\n}'
d=$( fixture fanout-heredoc includes/class-widget-node.php "$heredoc" )
assert_clean "a '/*' inside a heredoc ahead of a real live_targets( is not flagged" "$d"

d=$( fixture fanout-none includes/class-widget-node.php $'<?php\nclass Widget_Node extends Node {\n}' )
assert_clean "a file using no Fanout_Targets is not flagged" "$d"

mint='Command_Auth::sign_for( $spoke, $message );'
d=$( fixture mint includes/class-widget-node.php "$mint" )
assert_flags "Command_Auth::sign_for( outside its owner is flagged" "$d" "[signed-mint-outside-command-auth]"

d=$( fixture mint-qualified includes/class-widget-node.php '\Newspack_Nodes\Command_Auth::sign_for( $spoke, $message );' )
assert_flags "a qualified Command_Auth::sign_for( is flagged" "$d" "[signed-mint-outside-command-auth]"

d=$( fixture mint-owner includes/class-command-auth.php "$mint" )
assert_clean "class-command-auth.php may call sign_for(" "$d"

d=$( fixture mint-probe includes/class-http-out-node.php "$mint" )
assert_clean "class-http-out-node.php's blocking probe may call sign_for(" "$d"

d=$( fixture mint-send includes/class-widget-node.php '$m = Command_Auth::mint_for( $egress, $from, $to, $verb, $args );' )
assert_clean "a mint through Command_Auth::mint_for( is not flagged" "$d"

owner_ask='if ( Core::owns_unpartitioned() ) { $this->arm(); }'
d=$( fixture owns-elsewhere includes/class-widget-node.php "$owner_ask" )
assert_flags "owns_unpartitioned( outside class-core.php is flagged" "$d" "[owns-unpartitioned-outside-core]"

d=$( fixture owns-qualified includes/class-widget-node.php 'return \Newspack_Nodes\Core::owns_unpartitioned();' )
assert_flags "a qualified owns_unpartitioned( is flagged" "$d" "[owns-unpartitioned-outside-core]"

d=$( fixture owns-core includes/class-core.php 'return self::has_partition_token( $w ) || self::owns_unpartitioned();' )
assert_clean "class-core.php may call owns_unpartitioned(" "$d"

d=$( fixture owns-test tests/unit/CoreTest.php "$owner_ask" )
assert_clean "a test may call owns_unpartitioned(" "$d" "$d/tests/unit/CoreTest.php"

d=$( fixture owns-predicate includes/class-widget-node.php 'if ( Core::owns( $this->written ) ) { $this->arm(); }' )
assert_clean "the one predicate, Core::owns(, is not flagged" "$d"

exit $fail
