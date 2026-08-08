#!/usr/bin/env bash
#
# test-reorder-node-methods.sh — tests for both reorder-node-methods twins (.php, .js).
#
# Covers two concerns:
#
# (A) Call-graph receiver scoping (callees_factory / calleesOf). An edge exists
#     only for SELF-dispatch — PHP: $this->/$this?->/$this::/self::/static:: ;
#     JS: this./this?. A call on another object ($p->foo() / p.foo()) is NOT an
#     edge. Guarded here by a fixture where a foreign call WOULD create a cycle
#     (leaf -> root_call) if mis-read as a self-call; a cycle stalls the
#     topological sort and breaks caller-before-callee, so the assertion catches
#     it. Self-dispatch in every form MUST be an edge (self-forms fixture).
#
# (B) NODE ordering policy: fixed prefix (constructor/arguments/fill/fire*),
#     then a topological order of the call-graph-connected methods where every
#     callee sits below ALL its callers (public roots grouped, then the shared
#     chain), then standalone methods in source order, then node_schema. The
#     dual-homed fixture is the topic-node shape: apply_mode is reached from both
#     the fill path (via materialize) and the public path (mode_a/mode_b ->
#     set_mode). It must land at the BOTTOM of its call chain (below set_mode),
#     not hoisted up under materialize.

# shellcheck disable=SC2016  # single-quoted '$foo' are PHP names, not shell
set -u
cd "$( dirname "$0" )" || exit 2

for bin in php node; do
	command -v "$bin" >/dev/null 2>&1 || { echo "✗ required interpreter '$bin' not found on PATH"; exit 2; }
done

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# assert_before LABEL OUTPUT FIRST SECOND — both names present and FIRST precedes SECOND.
assert_before() {
	local label="$1" out="$2" first="$3" second="$4"
	if [[ "$out" != *"$first"* || "$out" != *"$second"* ]]; then
		echo "✗ $label: expected both '$first' and '$second' in reordered output; got:"
		echo "$out"
		fail=1
		return
	fi
	local before_first="${out%%"$first"*}" before_second="${out%%"$second"*}"
	if [ "${#before_first}" -gt "${#before_second}" ]; then
		echo "✗ $label: '$second' came before '$first'. Output:"
		echo "$out"
		fail=1
	else
		echo "✓ $label: '$first' precedes '$second'"
	fi
}

# ---- (A1) every self-dispatch form MUST be an edge ----
cat > "$tmp/class-selfforms-node.php" <<'PHP'
<?php
class Selfforms_Node extends Node {
	public function fill( array &$message ): void {
		$this?->step();
	}

	public function ztail(): void {
	}

	private function step(): void {
		$this::deep();
	}

	private function deep(): void {
		self::tip();
		static::tip();
	}

	private function tip(): void {
	}
}
PHP
assert_before "php self-forms" "$( php reorder-node-methods.php "$tmp/class-selfforms-node.php" 2>&1 )" step ztail

cat > "$tmp/selfforms-node.js" <<'JS'
class SelfformsNode extends Node {
	fill( message ) {
		this?.step();
	}

	ztail() {
	}

	step() {
		this?.deep();
	}

	deep() {
	}
}
JS
assert_before "js self-forms" "$( node reorder-node-methods.js "$tmp/selfforms-node.js" 2>&1 )" step ztail

# ---- (A2) a foreign call must NOT be an edge (else leaf->root_call cycles) ----
cat > "$tmp/class-foreign-node.php" <<'PHP'
<?php
class Foreign_Node extends Node {
	public function fill( array &$message ): void {
		$this->root_call();
	}

	private function leaf( $p ): void {
		$p->root_call();
	}

	private function mid(): void {
		$this->leaf();
	}

	public function root_call(): void {
		$this->mid();
	}
}
PHP
assert_before "php foreign-no-cycle" "$( php reorder-node-methods.php "$tmp/class-foreign-node.php" 2>&1 )" root_call mid

cat > "$tmp/foreign-node.js" <<'JS'
class ForeignNode extends Node {
	fill( message ) {
		this.rootCall();
	}

	leaf( p ) {
		p.rootCall();
	}

	mid() {
		this.leaf();
	}

	rootCall() {
		this.mid();
	}
}
JS
assert_before "js foreign-no-cycle" "$( node reorder-node-methods.js "$tmp/foreign-node.js" 2>&1 )" rootCall mid

# ---- (B) dual-homed helper: roots grouped, shared chain below, apply_mode last ----
cat > "$tmp/class-dualhomed-node.php" <<'PHP'
<?php
class Dualhomed_Node extends Node {
	public function fill( array &$message ): void {
		$this->materialize();
	}

	private function materialize(): void {
		$this->apply_mode();
	}

	public function mode_a(): void {
		$this->set_mode();
	}

	public function mode_b(): void {
		$this->set_mode();
	}

	private function apply_mode(): void {
	}

	private function set_mode(): void {
		$this->apply_mode();
	}
}
PHP
php_dh="$( php reorder-node-methods.php "$tmp/class-dualhomed-node.php" 2>&1 )"
assert_before "php dual-homed: set_mode before apply_mode" "$php_dh" set_mode apply_mode
assert_before "php dual-homed: mode_b before apply_mode"   "$php_dh" mode_b apply_mode
assert_before "php dual-homed: roots grouped (mode_b before set_mode)" "$php_dh" mode_b set_mode

# ---- (C) dual-homed, GENERIC policy: the same invariant off the node path ----
# A plain class gets the generic policy. `shared` is reached from write_a and
# from write_b; whichever caller the walk reaches first must not claim it, or
# the other caller ends up printed BELOW the helper it calls.
cat > "$tmp/class-dualhomed-plain.php" <<'PHP'
<?php
class Dualhomed_Plain {
	private function shared(): void {
	}

	private function only_b(): void {
	}

	public function write_a(): void {
		$this->shared();
	}

	public function write_b(): void {
		$this->shared();
		$this->only_b();
	}
}
PHP
php_gdh="$( php reorder-node-methods.php "$tmp/class-dualhomed-plain.php" 2>&1 )"
assert_before "php generic dual-homed: write_a before shared" "$php_gdh" write_a shared
assert_before "php generic dual-homed: write_b before shared" "$php_gdh" write_b shared

cat > "$tmp/dualhomed-plain.js" <<'JS'
class DualhomedPlain {
	shared() {
	}

	onlyB() {
	}

	writeA() {
		this.shared();
	}

	writeB() {
		this.shared();
		this.onlyB();
	}
}
JS
js_gdh="$( node reorder-node-methods.js "$tmp/dualhomed-plain.js" 2>&1 )"
assert_before "js generic dual-homed: writeA before shared" "$js_gdh" writeA shared
assert_before "js generic dual-homed: writeB before shared" "$js_gdh" writeB shared

# ---- (D) a call inside a closure body is NOT an edge of the enclosing method ----
# zboot() only REGISTERS a closure; the call inside it runs later, under whoever
# invokes the closure. Counting it as zboot -> decorate pins decorate below an
# unrelated method and opens a hole in emit()'s chain.
cat > "$tmp/class-closure-edge.php" <<'PHP'
<?php
class Closure_Edge {
	public function emit(): void {
		self::decorate();
	}

	public function zboot(): void {
		self::install( static function (): void {
			self::decorate();
		} );
	}

	private static function install( callable $cb ): void {
	}

	private static function decorate(): void {
	}
}
PHP
php_ce="$( php reorder-node-methods.php "$tmp/class-closure-edge.php" 2>&1 )"
assert_before "php closure-edge: decorate stays with emit, above zboot" "$php_ce" decorate zboot

cat > "$tmp/closure-edge.js" <<'JS'
class ClosureEdge {
	emit() {
		this.decorate();
	}

	zboot() {
		this.install( () => {
			this.decorate();
		} );
	}

	install( cb ) {
	}

	decorate() {
	}
}
JS
js_ce="$( node reorder-node-methods.js "$tmp/closure-edge.js" 2>&1 )"
assert_before "js closure-edge: decorate stays with emit, above zboot" "$js_ce" decorate zboot

# ---- (E) locality: an unrelated root must not wedge into a chain ----
# loner has no callers, so it is available from the first wave. Emitting
# chain_top frees chain_mid; the chain must continue rather than yield to
# whatever merely sorts earlier in source order.
cat > "$tmp/class-locality.php" <<'PHP'
<?php
class Locality {
	private static function chain_leaf(): void {
	}

	public function chain_top(): void {
		self::chain_mid();
	}

	public function loner(): void {
		self::loner_help();
	}

	private static function chain_mid(): void {
		self::chain_leaf();
	}

	private static function loner_help(): void {
	}
}
PHP
php_loc="$( php reorder-node-methods.php "$tmp/class-locality.php" 2>&1 )"
assert_before "php locality: chain_mid follows chain_top, before loner" "$php_loc" chain_mid loner

cat > "$tmp/locality.js" <<'JS'
class Locality {
	chainLeaf() {
	}

	chainTop() {
		this.chainMid();
	}

	loner() {
		this.lonerHelp();
	}

	chainMid() {
		this.chainLeaf();
	}

	lonerHelp() {
	}
}
JS
js_loc="$( node reorder-node-methods.js "$tmp/locality.js" 2>&1 )"
assert_before "js locality: chainMid follows chainTop, before loner" "$js_loc" chainMid loner

cat > "$tmp/dualhomed-node.js" <<'JS'
class DualhomedNode extends Node {
	fill( message ) {
		this.materialize();
	}

	materialize() {
		this.applyMode();
	}

	modeA() {
		this.setMode();
	}

	modeB() {
		this.setMode();
	}

	applyMode() {
	}

	setMode() {
		this.applyMode();
	}
}
JS
js_dh="$( node reorder-node-methods.js "$tmp/dualhomed-node.js" 2>&1 )"
assert_before "js dual-homed: setMode before applyMode" "$js_dh" setMode applyMode
assert_before "js dual-homed: modeB before applyMode"   "$js_dh" modeB applyMode
assert_before "js dual-homed: roots grouped (modeB before setMode)" "$js_dh" modeB setMode

# ---- (B2) standalone methods sink below the connected block, in source order ----
# alpha/beta are inert (no call edges); worker/sub are the connected chain. alpha/beta
# are defined ABOVE worker in source but must land below the connected block, and keep
# their own source order (alpha before beta).
cat > "$tmp/class-standalone-node.php" <<'PHP'
<?php
class Standalone_Node extends Node {
	public function fill( array &$message ): void {
		$this->worker();
	}

	public function alpha(): void {
	}

	public function beta(): void {
	}

	private function worker(): void {
		$this->sub();
	}

	private function sub(): void {
	}
}
PHP
php_sa="$( php reorder-node-methods.php "$tmp/class-standalone-node.php" 2>&1 )"
assert_before "php standalone: connected sinks standalone (worker before alpha)" "$php_sa" worker alpha
assert_before "php standalone: source order kept (alpha before beta)" "$php_sa" alpha beta

cat > "$tmp/standalone-node.js" <<'JS'
class StandaloneNode extends Node {
	fill( message ) {
		this.worker();
	}

	alpha() {
	}

	beta() {
	}

	worker() {
		this.sub();
	}

	sub() {
	}
}
JS
js_sa="$( node reorder-node-methods.js "$tmp/standalone-node.js" 2>&1 )"
assert_before "js standalone: connected sinks standalone (worker before alpha)" "$js_sa" worker alpha
assert_before "js standalone: source order kept (alpha before beta)" "$js_sa" alpha beta

# ---- (C) the base Node class itself (name 'Node', no superclass) gets node policy ----
# A shared helper authored ABOVE its callers must sink below them under node policy.
# The base class was previously excluded, so it was left untouched (helper on top).
cat > "$tmp/class-base-node.php" <<'PHP'
<?php
class Node {
	public function fill( array &$message ): void {
	}

	public function helper(): void {
	}

	public function caller_a(): void {
		$this->helper();
	}

	public function caller_b(): void {
		$this->helper();
	}
}
PHP
php_base="$( php reorder-node-methods.php "$tmp/class-base-node.php" 2>&1 )"
assert_before "php base Node: caller_a before helper" "$php_base" caller_a helper
assert_before "php base Node: caller_b before helper" "$php_base" caller_b helper

cat > "$tmp/base-node.js" <<'JS'
class Node {
	fill( message ) {
	}

	helper() {
	}

	callerA() {
		this.helper();
	}

	callerB() {
		this.helper();
	}
}
JS
js_base="$( node reorder-node-methods.js "$tmp/base-node.js" 2>&1 )"
assert_before "js base Node: callerA before helper" "$js_base" callerA helper
assert_before "js base Node: callerB before helper" "$js_base" callerB helper

# ---- (D) a field interleaved among methods is HOISTED, not silently skipped ----
# The tool must reorder the class (methods newspaper-ordered) AND move the
# interleaved const to the top, rather than bailing with a silent '·'.
assert_reordered() { # LABEL OUTPUT — output must announce a reorder ('~'), not skip ('·')
	case "$2" in
		*"~ "*) echo "✓ $1: reordered (not silently skipped)";;
		*) echo "✗ $1: silently skipped or errored; got: $2"; fail=1;;
	esac
}

cat > "$tmp/class-hoist-node.php" <<'PHP'
<?php
class Hoist_Node extends Node {
	public function fill( array &$message ): void {
		$this->worker();
	}

	public function helper(): void {
	}

	const MID_CONST = 42;

	public function worker(): void {
		$this->helper();
	}
}
PHP
php_hoist_out="$( php reorder-node-methods.php --write "$tmp/class-hoist-node.php" 2>&1 )"
php_hoist_file="$( cat "$tmp/class-hoist-node.php" )"
assert_reordered "php hoist: interleaved field" "$php_hoist_out"
# method order checked against the reorder note (clean names, no call-site noise)
assert_before "php hoist: worker before helper" "$php_hoist_out" worker helper
assert_before "php hoist: MID_CONST hoisted above fill" "$php_hoist_file" MID_CONST "function fill"

cat > "$tmp/hoist-node.js" <<'JS'
class HoistNode extends Node {
	fill( message ) {
		this.worker();
	}

	helper() {
	}

	static MID_CONST = 42;

	worker() {
		this.helper();
	}
}
JS
js_hoist_out="$( node reorder-node-methods.js --write "$tmp/hoist-node.js" 2>&1 )"
js_hoist_file="$( cat "$tmp/hoist-node.js" )"
assert_reordered "js hoist: interleaved field" "$js_hoist_out"
assert_before "js hoist: worker before helper" "$js_hoist_out" worker helper
assert_before "js hoist: MID_CONST hoisted above fill" "$js_hoist_file" MID_CONST "fill("

# ---- (E) PHP field block ordered by convention (use → const → static → instance;
#          public→protected→private; alpha within), across the WHOLE class ----
cat > "$tmp/class-order-node.php" <<'PHP'
<?php
class Order_Node extends Node {
	private int $zeta = 0;
	public const BETA = 2;

	public function fill( array &$message ): void {
		$this->helper();
	}

	use Loggable;
	protected static string $mid = 'x';
	public const ALPHA = 1;

	private function helper(): void {
	}

	public static array $reg = [];
}
PHP
# Declared field order is observable (get_object_vars, casts, var_dump), so the
# convention sort is opt-in; this fixture is the thing --sort-fields exists for.
php reorder-node-methods.php --write --sort-fields "$tmp/class-order-node.php" >/dev/null 2>&1
php_ord="$( cat "$tmp/class-order-node.php" )"
assert_before "php order: use trait at very top"        "$php_ord" "use Loggable" "const ALPHA"
assert_before "php order: const ALPHA before BETA (alpha)" "$php_ord" "ALPHA" "BETA"
assert_before "php order: const before static prop"     "$php_ord" "BETA" '$reg'
assert_before "php order: public static before protected static" "$php_ord" '$reg' '$mid'
assert_before "php order: static before instance prop"  "$php_ord" '$mid' '$zeta'
assert_before "php order: fields before methods"        "$php_ord" '$zeta' "function fill"
assert_before "php order: methods keep call-graph order" "$php_ord" "function fill" "function helper"

# ---- (E2) `// @ordered` pins a field block against --sort-fields ----
# A positional layout (Message's 7 wire fields) is only correct in declaration
# order; alphabetising it silently renumbers the wire. The marker opts that one
# block out while the rest of the class still sorts.
cat > "$tmp/class-pinned-node.php" <<'PHP'
<?php
class Pinned_Node extends Node {
	private int $zulu = 0;

	// @ordered
	public const TYPE      = 0;
	public const TIMESTAMP = 1;
	public const FROM      = 2;
	public const TO        = 3;
	public const ID        = 4;
	public const KEY       = 5;
	public const VALUE     = 6;

	public const ALPHA = 'a';

	public function fill( array &$message ): void {
		$this->helper();
	}

	private function helper(): void {
	}
}
PHP
php reorder-node-methods.php --write --sort-fields "$tmp/class-pinned-node.php" >/dev/null 2>&1
php_pin="$( cat "$tmp/class-pinned-node.php" )"
# The whole point: declaration order survives, even though T < TI < F... is not
# alphabetical and ALPHA would otherwise sort ahead of every one of them.
assert_before "php @ordered: TYPE before TIMESTAMP"   "$php_pin" "TYPE" "TIMESTAMP"
assert_before "php @ordered: TIMESTAMP before FROM"   "$php_pin" "TIMESTAMP" "FROM"
assert_before "php @ordered: FROM before TO"          "$php_pin" "FROM" "TO"
assert_before "php @ordered: TO before ID"            "$php_pin" "TO" "ID"
assert_before "php @ordered: ID before KEY"           "$php_pin" "ID" "KEY"
assert_before "php @ordered: KEY before VALUE"        "$php_pin" "KEY" "VALUE"
# The marker pins ONLY its block — unmarked fields still sort into convention.
assert_before "php @ordered: unpinned ALPHA still sorts above the instance prop" "$php_pin" "ALPHA" '$zulu'
assert_before "php @ordered: fields still hoisted above methods" "$php_pin" '$zulu' "function fill"

# assert_valid_php LABEL FILE — the rewritten file still parses.
assert_valid_php() {
	if php -l "$2" >/dev/null 2>&1; then echo "✓ $1: valid PHP"; else echo "✗ $1: INVALID PHP output"; fail=1; fi
}

# ---- (F) `Foo::class` must NOT seed a phantom class ----
cat > "$tmp/class-ccls-node.php" <<'PHP'
<?php
$types = [ Foo::class, Bar::class ];
class Ccls_Node extends Node {
	public function helper(): void {
	}

	public function fill( array &$message ): void {
		$this->helper();
	}
}
PHP
php reorder-node-methods.php --write "$tmp/class-ccls-node.php" >/dev/null 2>&1
assert_valid_php "php ::class" "$tmp/class-ccls-node.php"
assert_before "php ::class: real class still reorders (fill before helper)" "$( cat "$tmp/class-ccls-node.php" )" "function fill" "function helper"

# ---- (G) trait-use adaptation block ( use X { ... } ) is a `use` member, hoisted ----
cat > "$tmp/class-trait-node.php" <<'PHP'
<?php
class Trait_Node extends Node {
	public function fill( array &$message ): void {
		$this->helper();
	}

	use Bar {
		Bar::thing insteadof Baz;
	}

	public function helper(): void {
	}
}
PHP
php reorder-node-methods.php --write "$tmp/class-trait-node.php" >/dev/null 2>&1
assert_valid_php "php trait-block" "$tmp/class-trait-node.php"
assert_before "php trait-block: use hoisted above methods" "$( cat "$tmp/class-trait-node.php" )" "use Bar" "function fill"

# assert_line LABEL FILE LINE — an exact line survives verbatim in the output.
assert_line() {
	if grep -qF "$3" "$2"; then echo "✓ $1"; else echo "✗ $1 — line not found: $3"; fail=1; fi
}

# ---- (H) a trailing inline comment stays with its OWN member across reorder ----
cat > "$tmp/class-cmt-node.php" <<'PHP'
<?php
class Cmt_Node extends Node {
	public function fill( array &$message ): void {
		$this->helper();
	}

	private const ZED = 1; // zed comment
	private const ABE = 2; // abe comment

	private function helper(): void {
	}
}
PHP
php reorder-node-methods.php --write "$tmp/class-cmt-node.php" >/dev/null 2>&1
assert_valid_php "php trailing-comment" "$tmp/class-cmt-node.php"
assert_line "php trailing-comment: ABE keeps its own comment" "$tmp/class-cmt-node.php" 'const ABE = 2; // abe comment'
assert_line "php trailing-comment: ZED keeps its own comment" "$tmp/class-cmt-node.php" 'const ZED = 1; // zed comment'

exit "$fail"
