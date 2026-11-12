#!/usr/bin/env bash
#
# test-check-substrate-floor.sh — tests for the shared substrate-floor check.
#
# A throwaway substrate repo is tagged four times, each tag adding APIs a
# consumer can reach: methods, constants, static properties and classes in
# every declaration shape PHP allows. v1.1.0 also drops brief(), and v1.3.0
# drops gone(). A throwaway consumer beside it reaches each one, and the
# check must hold the consumer to the tag that introduced what it reaches and
# fail below it. An API in the substrate's working tree but not in any tag,
# one an older tag has but the floor's tag lacks, a floor naming no tag, a
# substrate with no tags and an analysis PHPStan could not finish are each
# named as what they are rather than passed.

# shellcheck disable=SC2016 # single-quoted text here is PHP, its $ literal
set -u
cd "$( dirname "$0" )" || exit 2
HERE=$PWD

if [ ! -f ../vendor/phpstan/phpstan/phpstan.phar ]; then
	echo "✗ no vendored phpstan; run composer install"
	exit 2
fi

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# A space in the path, so nothing downstream may assume a path is one word.
substrate="$tmp/floor check/newspack-nodes"
consumer="$tmp/floor check/consumer"

# commit_tag TAG — commit the substrate's whole tree and tag it.
commit_tag() {
	git -C "$substrate" add -A
	git -C "$substrate" -c user.name=t -c user.email=t@t commit -qm "$1"
	git -C "$substrate" tag "$1"
}

# put FILE PHP — write a substrate file in the Newspack_Nodes namespace.
put() {
	printf '<?php\nnamespace Newspack_Nodes;\n\n%s\n' "$2" > "$substrate/includes/$1"
}

mkdir -p "$substrate/includes"
git -C "$substrate" init -q

put class-floor-bootstrap.php 'class Floor_Bootstrap {
	public static function version_at_least( string $floor ): bool {
		return "" !== $floor;
	}
}'
put class-old-thing.php 'class Floor_Old_Thing {
	public function __construct() {
	}
}'
# A substrate class taking the trait in the `use … { … }` form.
# render_reader [ALIAS] — Floor_Reader, and its public alias when asked.
render_reader() {
	local alias=''
	[ -n "${1:-}" ] && alias='
		mixin_method as public mixin_public;'
	put class-floor-reader.php 'class Floor_Reader {
	use Floor_Mixin {
		mixin_method as protected mixin_alias;'"$alias"'
	}
}'
}
render_reader
# picked() comes from Floor_Left alone: v1.0.0 names it there before it exists.
put trait-floor-right.php 'trait Floor_Right {
	public static function picked(): int {
		return 7;
	}
}'
put class-floor-picker.php 'class Floor_Picker {
	use Floor_Left, Floor_Right {
		Floor_Left::picked insteadof Floor_Right;
	}
}'
put trait-floor-left.php 'trait Floor_Left {
}'
# Aliases of trait methods that become static and public only at v1.1.0.
put class-floor-runner.php 'class Floor_Runner {
	use Floor_Runs {
		run as public go;
		hush as hushed;
	}
}'
put trait-floor-runs.php 'trait Floor_Runs {
	public function run(): int {
		return 7;
	}
	private function hush(): int {
		return 7;
	}
}'
# moved() starts on Floor_Kid and moves up to Floor_Elder at v1.2.0.
put class-floor-elder.php 'class Floor_Elder {
}'
put class-floor-kid.php 'class Floor_Kid {
	public static function moved(): int {
		return 7;
	}
}'

# A name long enough that PHPStan's table output would wrap the line naming it.
LONG=reach_with_a_name_long_enough_to_wrap_a_phpstan_table_row

# render_base WITH… — the base class, carrying the members each tag adds.
render_base() {
	local member body='	const OLD_CONST = 7;
	public static int $old_prop = 7;
	public static function old_method(): int {
		return 7;
	}'
	for member in "$@"; do
		case "$member" in
			early)
				body+='
	private static function secret(): int {
		return 7;
	}
	public function was_instance(): int {
		return 7;
	}'
				;;
			v1.1)
				body+='
	public static function secret(): int {
		return 11;
	}
	public static function was_instance(): int {
		return 11;
	}
	const NEW_CONST = 11;
	const MULTI_A = 1, MULTI_B = 2;
	const NULLABLE_CONST = 11;
	public static int $nullable_prop = 11;
	static public int $odd_order = 11;
	public static function new_method(): int {
		return 11;
	}
	public static function '"$LONG"'(): int {
		return 11;
	}
	public static function &by_ref(): array {
		static $kept = [];
		return $kept;
	}
	public function inst_nullsafe(): int {
		return 11;
	}
	public function inst_nullable(): int {
		return 11;
	}'
				;;
			shouty) body+='
	public static function Shouty_Name(): int {
		return 11;
	}' ;;
			quiet) body+='
	public static function shouty_name(): int {
		return 13;
	}' ;;
			v1.3)
				body+='
	public static ?string $new_prop = null;
	public static function callable_target(): int {
		return 13;
	}'
				;;
			unreleased) body+='
	const UNRELEASED_CONST = 17;' ;;
			gone) body+='
	public static function gone(): int {
		return 17;
	}' ;;
			brief) body+='
	public static function brief(): int {
		return 19;
	}' ;;
			restored) body+='
	public static function restored(): int {
		return 23;
	}' ;;
		esac
	done
	put class-floor-base.php "class Floor_Base {
$body
}"
}

# render_mixin WITH_NEW — the trait, carrying its v1.2.0 property when asked.
render_mixin() {
	local extra=''
	[ -n "${1:-}" ] && extra='
	public static array $new_mixin_prop = [];'
	put trait-floor-mixin.php 'trait Floor_Mixin {
	public static int $old_mixin_prop = 7;
	private static function hidden_helper(): int {
		return 7;
	}
	public static function mixin_method(): int {
		return 7;
	}'"$extra"'
}'
}

render_base early gone brief restored
render_mixin
commit_tag v1.0.0

render_base v1.1 shouty gone
put class-floor-parent.php 'class Floor_Parent {
	protected function guarded(): int {
		return 11;
	}
}'
put class-floor-checked.php 'final class Floor_Checked {
}'
put trait-floor-runs.php 'trait Floor_Runs {
	public static function run(): int {
		return 11;
	}
	public function hush(): int {
		return 11;
	}
}'
put trait-floor-left.php 'trait Floor_Left {
	public static function picked(): int {
		return 11;
	}
}'
commit_tag v1.1.0

put class-new-thing.php 'class Floor_New_Thing {
}'
put enum-floor-mode.php 'enum Floor_Mode: string {
	case FAST = "f";
}'
put class-floor-value.php 'readonly class Floor_Value {
}'
put interface-floor-contract.php 'interface Floor_Contract {
}'
put class-floor-error.php 'class Floor_Error extends \RuntimeException {
}'
put class-floor-v2.php 'class Floor_V2 {
}'
put trait-floor-duty.php 'trait Floor_Duty {
	abstract public function duty(): int;
}'
put class-floor-elder.php 'class Floor_Elder {
	public static function moved(): int {
		return 11;
	}
}'
put class-floor-kid.php 'class Floor_Kid extends Floor_Elder {
}'
render_mixin with
render_reader with
commit_tag v1.2.0

render_base v1.1 quiet v1.3
commit_tag v1.3.0

mkdir -p "$consumer/scripts" "$consumer/includes" "$consumer/vendor/bin" "$consumer/vendor/phpstan/phpstan"
cp "$HERE/check-substrate-floor.sh" "$HERE/phpstan-substrate-floor.php" \
	"$HERE/phpstan-floor.neon" "$HERE/substrate-floor-index.php" "$consumer/scripts/"
# A wrapper, not a symlink: the composer proxy would load OUR autoloader.
printf '#!/bin/sh\nexec php "%s" "$@"\n' \
	"$( cd .. && pwd )/vendor/phpstan/phpstan/phpstan.phar" > "$consumer/vendor/bin/phpstan"
chmod +x "$consumer/vendor/bin/phpstan"
ln -s "$( cd .. && pwd )/vendor/phpstan/phpstan/phpstan.phar" "$consumer/vendor/phpstan/phpstan/phpstan.phar"
# A review config, as every plugin's is: strict rules on, all of them.
# neon SCAN — the consumer's config, reading the substrate's classes from SCAN.
neon() {
	printf '%s\n' 'includes:' \
		"	- $( cd .. && pwd )/vendor/phpstan/phpstan-strict-rules/rules.neon" \
		'parameters:' '	strictRules:' '		allRules: true' \
		'	tmpDir: %currentWorkingDirectory%/.phpstan-cache' \
		'	paths:' '		- consumer.php' '		- includes' \
		'	scanDirectories:' "		- $1" > "$consumer/phpstan.neon.dist"
}
neon ../newspack-nodes/includes

# A consumer class mixing in the substrate's trait, whose members PHPStan
# reports as the consumer's own.
cat > "$consumer/includes/class-mixer.php" <<'PHP'
<?php
class Floor_Mixer {
	use \Newspack_Nodes\Floor_Mixin;

	public static function reach(): int {
		return self::hidden_helper();
	}
}
PHP

# consumer FLOOR CODE — the plugin file declares FLOOR; includes/ holds CODE.
consumer() {
	cat > "$consumer/consumer.php" <<-PHP
		<?php
		\\Newspack_Nodes\\Floor_Bootstrap::version_at_least( '$1' );
	PHP
	printf '<?php\n%s\n' "$2" > "$consumer/includes/reader.php"
}

# run LABEL WANT_EXIT — run the check, hold it to WANT_EXIT, keep its output.
run() {
	"$consumer/scripts/check-substrate-floor.sh" > "$tmp/out" 2>&1
	local got=$?
	if [ "$got" = "$2" ]; then
		echo "✓ $1: exits $2"
	else
		echo "✗ $1: expected exit $2, got $got"
		sed 's/^/    /' "$tmp/out"
		fail=1
	fi
}

# says LABEL TEXT — the last run's output holds the fixed string.
says() {
	if grep -qF -- "$2" "$tmp/out"; then
		echo "✓ $1"
	else
		echo "✗ $1: no '$2' in:"
		sed 's/^/    /' "$tmp/out"
		fail=1
	fi
}

# never_says LABEL TEXT — the last run's output does not hold it.
never_says() {
	if grep -qF -- "$2" "$tmp/out"; then
		echo "✗ $1: '$2' in:"
		sed 's/^/    /' "$tmp/out"
		fail=1
	else
		echo "✓ $1"
	fi
}

OLD_READS='function floor_consumer(): void {
	$a = \Newspack_Nodes\Floor_Base::OLD_CONST;
	$b = \Newspack_Nodes\Floor_Base::$old_prop;
	$c = new \Newspack_Nodes\Floor_Old_Thing();
	$d = \Newspack_Nodes\Floor_Base::old_method();
	$e = \Newspack_Nodes\Floor_Base::class;
	$f = \Floor_Mixer::$old_mixin_prop;
	[ , $hole ] = [ $a, $b ];
	foreach ( [ [ $c, $d ] ] as [ , $slot ] ) {
		echo $slot;
	}
	echo $hole;
	echo $a, $b, \get_class( $c ), $d, $e, $f, (string) "a review rule would flag this cast";
}'
NEW_READS='class Floor_Dutiful {
	use \Newspack_Nodes\Floor_Duty;
	public function duty(): int {
		return 1;
	}
}
class Floor_Child extends \Newspack_Nodes\Floor_Parent {
	public int $count = 0;
	public function counter(): \Closure {
		return \strlen(...);
	}
	public function guard(): int {
		return $this->guarded();
	}
}
class Floor_Impl implements \Newspack_Nodes\Floor_Contract {
}
function floor_nullsafe( ?\Newspack_Nodes\Floor_Base $b ): ?int {
	return $b?->inst_nullsafe();
}
function floor_nullable( ?\Newspack_Nodes\Floor_Base $b ): int {
	return $b->inst_nullable() + $b::NULLABLE_CONST + $b::$nullable_prop;
}
function floor_consumer( object $o ): void {
	$a = \Newspack_Nodes\Floor_Base::NEW_CONST + \Newspack_Nodes\Floor_Base::MULTI_B;
	$b = \Newspack_Nodes\Floor_Base::$new_prop . \Newspack_Nodes\Floor_Base::$odd_order;
	$c = new \Newspack_Nodes\Floor_New_Thing();
	$d = \Newspack_Nodes\Floor_Base::new_method() + \Newspack_Nodes\Floor_Base::'"$LONG"'();
	$d += \Newspack_Nodes\Floor_Base::SHOUTY_NAME() + \count( \Newspack_Nodes\Floor_Base::by_ref() );
	$g = \Floor_Mixer::$new_mixin_prop;
	$h = \Newspack_Nodes\Floor_Reader::$new_mixin_prop;
	$i = \Newspack_Nodes\Floor_Mode::FAST;
	$j = new \Newspack_Nodes\Floor_Value();
	$k = $o instanceof \Newspack_Nodes\Floor_Checked;
	$l = [ \Newspack_Nodes\Floor_Base::class, "callable_target" ];
	$m = \Newspack_Nodes\Floor_Mode::tryFrom( "f" ) ?? \Newspack_Nodes\Floor_Mode::cases()[0];
	$n = new \Newspack_Nodes\Floor_V2();
	$p = \Newspack_Nodes\Floor_Reader::mixin_public() + \Newspack_Nodes\Floor_Picker::picked();
	$r = \Newspack_Nodes\Floor_Runner::go() + ( new \Newspack_Nodes\Floor_Runner() )->hushed();
	echo $r;
	$q = \Newspack_Nodes\Floor_Kid::moved() + \Newspack_Nodes\Floor_Base::secret() + \Newspack_Nodes\Floor_Base::was_instance();
	echo $m->value, \get_class( $n ), $p, $q;
	try {
		echo $a, $b, \get_class( $c ), $d, \count( $g ), \count( $h ), $i->value, \get_class( $j ), $k, $l();
	} catch ( \Newspack_Nodes\Floor_Error $e ) {
		echo $e->getMessage();
	}
}'

consumer 1.0.0 "$OLD_READS"
run "reads of v1.0.0 APIs at a 1.0.0 floor" 0
says "every v1.0.0 kind resolves, the bootstrap call included" "(8 resolved)"
never_says "::class is not a constant" "::class"
never_says "a review rule's finding is not an analysis error" "PHPStan reported errors"

consumer 1.0.0 "$NEW_READS"
run "reads of later APIs at a 1.0.0 floor" 1
says "a constant is held to the tag adding it" '1.1.0  Newspack_Nodes\Floor_Base::NEW_CONST'
says "a constant declared beside another is found" '1.1.0  Newspack_Nodes\Floor_Base::MULTI_B'
says "a method is held to the tag adding it" '1.1.0  Newspack_Nodes\Floor_Base::new_method()'
says "a long name survives the report" "1.1.0  Newspack_Nodes\\Floor_Base::$LONG()"
says "a method returning a reference is found" '1.1.0  Newspack_Nodes\Floor_Base::by_ref()'
says "a method is found whatever case an older tag spelt it in" '1.1.0  Newspack_Nodes\Floor_Base::shouty_name()'
never_says "a method is named as declared, not as called" 'SHOUTY_NAME'
says "a nullsafe call is collected" '1.1.0  Newspack_Nodes\Floor_Base->inst_nullsafe()'
never_says "a property and a first-class callable analyse cleanly" "Internal error"
says "a call on a nullable type is collected" '1.1.0  Newspack_Nodes\Floor_Base->inst_nullable()'
says "a method private at the floor is held to the tag making it public" '1.1.0  Newspack_Nodes\Floor_Base::secret()'
says "a static call is held to the tag making the method static" '1.1.0  Newspack_Nodes\Floor_Base::was_instance()'
says "a protected method reached from a subclass is held to its tag" '1.1.0  Newspack_Nodes\Floor_Parent::guarded() (from a subclass)'
says "a constant read through a nullable type is collected" '1.1.0  Newspack_Nodes\Floor_Base::NULLABLE_CONST'
says "a static property read through a nullable type is collected" '1.1.0  Newspack_Nodes\Floor_Base::$nullable_prop'
says "a static property declared static-first is found" '1.1.0  Newspack_Nodes\Floor_Base::$odd_order'
says "an extends is held to the tag adding the parent" '1.1.0  Newspack_Nodes\Floor_Parent'
says "an instanceof is held to the tag adding the class" '1.1.0  Newspack_Nodes\Floor_Checked'
says "a new is held to the tag adding the class" '1.2.0  Newspack_Nodes\Floor_New_Thing'
says "a trait's static property is held to the tag adding it" '1.2.0  Newspack_Nodes\Floor_Mixin::$new_mixin_prop'
says "a trait a class takes with a block is walked" '1.2.0  Newspack_Nodes\Floor_Reader::$new_mixin_prop'
says "an enum case is held to the tag adding the enum" '1.2.0  Newspack_Nodes\Floor_Mode::FAST'
says "a new of a readonly class is held to its tag" '1.2.0  Newspack_Nodes\Floor_Value'
says "an implements is held to the tag adding the interface" '1.2.0  Newspack_Nodes\Floor_Contract'
says "a catch is held to the tag adding the class" '1.2.0  Newspack_Nodes\Floor_Error'
says "a static property is held to the tag adding it" '1.3.0  Newspack_Nodes\Floor_Base::$new_prop'
says "a callable array is held to the tag adding its method" '1.3.0  Newspack_Nodes\Floor_Base::callable_target()'
says "the floor named is the newest of them" "Raise the floor to 1.3.0"
says "a class whose name holds a digit is read whole" '1.2.0  Newspack_Nodes\Floor_V2'
says "a trait used for its contract alone is held to its tag" '1.2.0  Newspack_Nodes\Floor_Duty'
says "an enum's built-in tryFrom() is held to the enum's tag" '1.2.0  Newspack_Nodes\Floor_Mode::tryFrom()'
says "an enum's built-in cases() is held to the enum's tag" '1.2.0  Newspack_Nodes\Floor_Mode::cases()'
says "an alias called statically is held to the tag making its method static" '1.1.0  Newspack_Nodes\Floor_Runner::go()'
says "an alias with no modifier keeps its method's visibility" '1.1.0  Newspack_Nodes\Floor_Runner->hushed()'
says "a public trait alias is held to the tag adding it" '1.2.0  Newspack_Nodes\Floor_Reader::mixin_public()'
says "a method an insteadof excludes does not count" '1.1.0  Newspack_Nodes\Floor_Picker::picked()'
never_says "a member moved up to a parent is read where it is reached" 'moved()'
never_says "every API resolves somewhere" "lookup is broken"

consumer 1.2.0 "$NEW_READS"
run "reads of later APIs at a 1.2.0 floor" 1
says "the static property still fails at 1.2.0" '1.3.0  Newspack_Nodes\Floor_Base::$new_prop'
never_says "the constant passes at 1.2.0" "NEW_CONST"
never_says "the class passes at 1.2.0" "Floor_New_Thing"
never_says "the trait's property passes at 1.2.0" "new_mixin_prop"
never_says "a method an older tag spelt otherwise passes at 1.2.0" "shouty_name"
never_says "the enum passes at 1.2.0" "Floor_Mode"
never_says "the digit-named class passes at 1.2.0" "Floor_V2"
never_says "the public alias passes at 1.2.0" "mixin_public"
never_says "aliases of a static, public method pass at 1.2.0" "Floor_Runner"
never_says "a method public and static by the floor passes" "secret"
never_says "a protected method reached from a subclass passes" "guarded"

consumer 1.3.0 "$NEW_READS"
run "reads of later APIs at a 1.3.0 floor" 0

consumer 1.1.5 "$NEW_READS"
run "a floor naming no tag" 1
says "the verdict says the floor names no tag" "floor names no tag v1.1.5"
never_says "nothing is called dropped against it" "older tag"

printf '<?php\nfunction floor_broken( {\n' > "$consumer/includes/broken.php"
consumer 1.3.0 "$NEW_READS"
run "an analysis PHPStan could not finish" 1
says "the verdict names PHPStan's own errors" "PHPStan reported errors"
rm "$consumer/includes/broken.php"

# Stubs that still carry gone() and brief(), as a plugin's stubs can lag.
render_base v1.1 quiet v1.3 unreleased gone brief restored
cp -R "$substrate/includes" "$consumer/stub-includes"
neon stub-includes
render_base v1.1 quiet v1.3 unreleased restored
# Untracked work in progress, which git does not see and neither may the index.
printf '<?php\nclass {\n' > "$substrate/includes/wip-draft.php"
consumer 1.3.0 "$NEW_READS
function floor_late(): void {
	echo \\Newspack_Nodes\\Floor_Base::UNRELEASED_CONST + \\Newspack_Nodes\\Floor_Base::restored();
	echo \\Newspack_Nodes\\Floor_Base::gone() + \\Newspack_Nodes\\Floor_Base::brief();
}"
run "a read of an API in no tag, and of ones the floor's tag dropped" 1
says "it is named as unreleased" 'Newspack_Nodes\Floor_Base::UNRELEASED_CONST'
says "the verdict says no tag carries it" "in no tag yet"
never_says "it is not called a broken lookup" "lookup is broken"
says "an API back in the working tree is unreleased" '  Newspack_Nodes\Floor_Base::restored()'
never_says "the working tree is read before older tags" '1.0.0  Newspack_Nodes\Floor_Base::restored()'
says "a dropped API is named with the newest older tag having it" '1.2.0  Newspack_Nodes\Floor_Base::gone()'
says "an API dropped mid-history is found without a binary search" '1.0.0  Newspack_Nodes\Floor_Base::brief()'
never_says "a tag is named as a version, like a newer one" 'v1.2.0'
never_says "an untracked file is not read" "wip-draft"
says "the verdict says the floor's tag lacks them" "not at v1.3.0"
never_says "neither is held to a floor to raise to" "Raise the floor"
rm "$substrate/includes/wip-draft.php"

# A tracked file that will not parse costs only what it declares.
printf '<?php\nnamespace Newspack_Nodes;\nclass Floor_Draft {\n' > "$substrate/includes/class-floor-draft.php"
git -C "$substrate" add includes/class-floor-draft.php
put_stub() {
	printf '<?php\nnamespace Newspack_Nodes;\n\n%s\n' "$2" > "$consumer/stub-includes/$1"
}
put_stub class-floor-draft.php 'class Floor_Draft {
}'
consumer 1.3.0 "$OLD_READS
function floor_draft(): object {
	return new \\Newspack_Nodes\\Floor_Draft();
}"
run "a tracked file that will not parse" 1
says "what it declares reads as unresolved" 'Newspack_Nodes\Floor_Draft'
says "the file is named" 'class-floor-draft.php'
never_says "the gate itself does not fail" "index failed"
git -C "$substrate" rm -q --cached includes/class-floor-draft.php
rm "$substrate/includes/class-floor-draft.php"

# A class declared in two tracked files is refused, both files named, once.
put class-floor-copy.php 'class Floor_Base {
}'
git -C "$substrate" add includes/class-floor-copy.php
consumer 1.3.0 "$OLD_READS
function floor_copy(): int {
	return \\Newspack_Nodes\\Floor_Base::UNRELEASED_CONST;
}"
run "a class declared twice" 1
says "the refusal names the first file" 'class-floor-base.php'
says "the refusal names the second file" 'class-floor-copy.php'
if [ "$( grep -c 'declared twice' "$tmp/out" )" = 1 ]; then
	echo "✓ the refusal prints once"
else
	echo "✗ the refusal prints once:"
	sed 's/^/    /' "$tmp/out"
	fail=1
fi
git -C "$substrate" rm -q --cached includes/class-floor-copy.php
rm "$substrate/includes/class-floor-copy.php"

# The index answering for fewer APIs than were asked fails the check.
cp "$consumer/scripts/substrate-floor-index.php" "$tmp/index.php"
printf '<?php\necho "ok Newspack_Nodes\\\\Floor_Bootstrap::version_at_least()\\n";\n' > "$consumer/scripts/substrate-floor-index.php"
consumer 1.3.0 "$OLD_READS"
run "an index answering for fewer APIs than it was asked" 1
says "the verdict counts the answers" "answered for 1 of"
cp "$tmp/index.php" "$consumer/scripts/substrate-floor-index.php"

# Without the PHPStan phar there is no parser, and the check says so.
mv "$consumer/vendor/phpstan/phpstan/phpstan.phar" "$tmp/phpstan.phar.link"
run "a missing PHPStan phar" 1
says "the verdict names PHPStan" "PHPStan"
mv "$tmp/phpstan.phar.link" "$consumer/vendor/phpstan/phpstan/phpstan.phar"

for t in v1.0.0 v1.1.0 v1.2.0 v1.3.0; do
	git -C "$substrate" tag -d "$t" > /dev/null
done
run "a substrate with no tags" 1
says "the verdict says the checkout has no tags" "has no vX.Y.Z tags"

exit "$fail"
