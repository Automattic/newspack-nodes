#!/usr/bin/env bash
# shellcheck disable=SC2016 # the fixtures are source text, written verbatim
#
# test-lint-english.sh — tests for the prose gate.
#
# Two halves. The readers decide what counts as prose in each file type, so
# each reader has a case proving a rule fires inside its prose and stays silent
# in the code around it. The rules decide what is wrong with that prose, so
# each rule has a case for every shape it catches and every shape it keeps.

set -u
cd "$( dirname "$0" )" || exit 2
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }
gate="$( pwd )/lint-english.mjs"

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0
count=0

# write NAME BODY — one fixture in a directory of its own; prints its path.
write() {
	count=$(( count + 1 ))
	local path="$tmp/$count/$1"
	mkdir -p "$( dirname "$path" )"
	printf '%s\n' "$2" > "$path"
	echo "$path"
}

# run_gate PATH… — sets `out` and `status`.
run_gate() {
	out="$( node "$gate" "$@" 2>&1 )"; status=$?
}

# flags LABEL ID NAME BODY [LINE] — exit 1 with [ID], at LINE when given.
flags() {
	local label="$1" id="$2" name="$3" body="$4" line="${5:-}" path needle
	path="$( write "$name" "$body" )"
	run_gate "$path"
	needle="[$id]"
	[ -n "$line" ] && needle="$path:$line: [$id]"
	if [[ $status -eq 1 && "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 1 with '$needle'; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# clean LABEL NAME BODY — exit 0, silent.
clean() {
	local label="$1" name="$2" body="$3" path
	path="$( write "$name" "$body" )"
	run_gate "$path"
	if [[ $status -eq 0 && -z "$out" ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected a silent exit 0; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# prose_flags ID TEXT… — each TEXT, as Markdown, fires ID.
prose_flags() {
	local id="$1" text
	shift
	for text in "$@"; do
		flags "$id: $text" "$id" note.md "$text"
	done
}

# prose_clean TEXT… — each TEXT, as Markdown, fires nothing.
prose_clean() {
	local text
	for text in "$@"; do
		clean "keeps: $text" note.md "$text"
	done
}

# ---- the command line ----

path="$( write note.md 'A row is no reader.' )"
run_gate "$path"
if [[ $status -eq 1 && "$out" == "$path:1: [is-no] "* ]]; then
	echo "✓ a hit prints file:line: [id] and exits 1"
else
	echo "✗ a hit prints file:line: [id] and exits 1: exit $status: $out"
	fail=1
fi
if [[ "$out" == *'A false positive must be carved out of the gate itself, in newspack-nodes/scripts/lint-english.mjs: never reword around it. There is no opt-out comment.'* ]]; then
	echo "✓ every hit says to carve a false positive out of the gate"
else
	echo "✗ every hit says to carve a false positive out of the gate: $out"
	fail=1
fi

dir="$tmp/tree"
mkdir -p "$dir/includes" "$dir/vendor/lib" "$dir/node_modules/lib" \
	"$dir/build" "$dir/release" "$dir/coverage/report" "$dir/.phpstan/cache" \
	"$dir/tests/fixtures" "$dir/src/__fixtures__" "$dir/tests/templates" \
	"$dir/docs/specs/mocks"
printf 'A row is no reader.\n' > "$dir/includes/hit.md"
for f in vendor/lib/a.md node_modules/lib/a.md build/a.md release/a.md \
	coverage/report/a.md .phpstan/cache/a.md tests/fixtures/a.md \
	src/__fixtures__/a.md tests/templates/a.html CHANGELOG.md LICENSE.md \
	tests/INVENTORY.md docs/specs/mocks/a.html; do
	printf 'A row is no reader.\n' > "$dir/$f"
done
run_gate "$dir"
hits="$( printf '%s\n' "$out" | grep -c '\[is-no\]' )"
if [[ $status -eq 1 && "$hits" -eq 1 && "$out" == *'includes/hit.md'* ]]; then
	echo "✓ a directory walk reads prose and prunes generated trees"
else
	echo "✗ a directory walk prunes generated trees: $hits hits: $out"
	fail=1
fi

run_gate "$dir/vendor/lib/a.md" "$dir/CHANGELOG.md"
if [[ $status -eq 0 ]]; then
	echo "✓ an exempt path named directly is skipped too"
else
	echo "✗ an exempt path named directly is skipped too: $out"
	fail=1
fi

community="$tmp/repos/newspack-community"
mkdir -p "$community/docs/fdn-arch" "$community/docs/superpowers/plans" \
	"$community/docs/guides" "$tmp/repos/newspack-pyrobase/docs/superpowers/plans"
for f in "$community/docs/fdn-arch/a.md" \
	"$community/docs/superpowers/plans/a.md"; do
	printf 'A row is no reader.\n' > "$f"
done
run_gate "$community/docs/fdn-arch/a.md" "$community/docs/superpowers/plans/a.md"
if [[ $status -eq 0 && -z "$out" ]]; then
	echo "✓ community's design docs are exempt when named directly"
else
	echo "✗ community's design docs are exempt when named directly: $out"
	fail=1
fi
printf 'A row is no reader.\n' > "$community/docs/guides/a.md"
run_gate "$community/docs"
if [[ $status -eq 1 && "$out" == *'docs/guides/a.md'* && "$out" != *'fdn-arch'* && "$out" != *'superpowers'* ]]; then
	echo "✓ a walk over community's docs reads its guides alone"
else
	echo "✗ a walk over community's docs reads its guides alone: $out"
	fail=1
fi
out="$( cd "$community" && node "$gate" docs/fdn-arch docs/superpowers 2>&1 )"; status=$?
if [[ $status -eq 0 && -z "$out" ]]; then
	echo "✓ community's design docs are exempt from inside the repo"
else
	echo "✗ community's design docs are exempt from inside the repo: $out"
	fail=1
fi
printf 'A row is no reader.\n' > "$tmp/repos/newspack-pyrobase/docs/superpowers/plans/a.md"
run_gate "$tmp/repos/newspack-pyrobase/docs"
if [[ $status -eq 1 && "$out" == *'[is-no]'* ]]; then
	echo "✓ another repo's docs/superpowers is still read"
else
	echo "✗ another repo's docs/superpowers is still read: exit $status: $out"
	fail=1
fi

run_gate "$tmp/absent.md"
if [[ $status -eq 0 ]]; then
	echo "✓ a path that does not exist yields nothing"
else
	echo "✗ a path that does not exist yields nothing: $out"
	fail=1
fi

flags 'no marker of any kind opts a line out' is-no note.php '<?php
// english-ok: A row is no reader.
// @longform A row is no reader.'

# ---- wrapping ----

flags 'a phrase wraps across // lines and reports its first' is-no a.php '<?php
$a = 1;
// A row is
// no reader.' 3
flags 'a phrase wraps across a docblock prefix' is-no a.php '<?php
/**
 * A row is
 * no reader.
 */' 3
flags 'a phrase wraps across # lines' is-no a.sh '#!/bin/sh
# A row is
# no reader.' 2
flags 'a phrase wraps across Markdown lines' is-no a.md 'First line.

A row is
no reader.' 3
flags 'a phrase wraps across a block quote' is-no a.md '> A row is
> no reader.' 1
clean 'a blank docblock line ends the paragraph' a.php '<?php
/**
 * A row is
 *
 * no reader.
 */'
clean 'a tag line ends the paragraph' a.php '<?php
/**
 * A row is
 * @param no reader.
 */'
clean 'a Markdown list item ends the paragraph' a.md '- A row is
- no reader.'
clean 'a code line ends the comment' a.php '<?php
// A row is
$a = 1;
// no reader.'

# ---- PHP ----

flags 'PHP // comment' is-no a.php '<?php
$a = 1; // A row is no reader.'
flags 'PHP # comment' is-no a.php '<?php
# A row is no reader.'
flags 'PHP block comment' is-no a.php '<?php
/* A row is no reader. */'
flags 'a comment after a closing tag and reopening' is-no a.php '<p>x</p>
<?php
// A row is no reader.
?>
<p>y</p>
<?php /* A row is no reader. */ ?>'
clean 'PHP single-quoted string' a.php '<?php
$a = '"'"'// A row is no reader.'"'"';'
clean 'PHP double-quoted string across lines' a.php '<?php
$a = "
// A row is no reader.
";'
clean 'PHP attribute is not a comment' a.php '<?php
#[Attr( "A row is no reader." )]
function a() {}'
clean 'PHP heredoc' a.php '<?php
$a = <<<TEXT
// A row is no reader.
TEXT;'
clean 'PHP indented nowdoc' a.php '<?php
$a = <<<'"'"'TEXT'"'"'
	// A row is no reader.
	TEXT;'
clean 'inline HTML outside PHP tags' a.php '<?php $a = 1; ?>
<p>A row is no reader.</p>'
clean 'a // comment ends at a closing tag' a.php '<?php // ok ?> A row is no reader.'

# ---- JS ----

flags 'JS // comment' is-no a.js 'const a = 1; // A row is no reader.'
flags 'MJS JSDoc' is-no a.mjs '/** A row is no reader. */'
flags 'CJS comment' is-no a.cjs '// A row is no reader.'
flags 'JSX comment' is-no a.jsx 'const a = <p>{ /* A row is no reader. */ }</p>;'
flags 'TS comment' is-no a.ts '// A row is no reader.'
flags 'a comment after a regex holding a quote' is-no a.js "const a = /'/; // A row is no reader."
flags 'a comment after a template literal' is-no a.js 'const a = `${ b }`; // A row is no reader.'
clean 'JS strings' a.js "const a = '// A row is no reader.', b = \"/* A row is no reader. */\";"
clean 'JS template literal' a.js 'const a = `
// A row is no reader.
`;'
clean 'JS template literal with a nested template' a.js 'const a = `${ b ? `x` : "y" }
// A row is no reader.
`;'
clean 'a URL in a string is not a comment' a.js "const a = 'https://x.test/A row is no reader.';"
clean 'a regex literal holding a comment opener' a.js 'const a = /\/\/ A row is no reader./;'
clean 'a JSX closing tag does not open a regex' a.jsx 'const a = <p>x</p>; const b = `
// A row is no reader.
`;'

# ---- SCSS and CSS ----

flags 'SCSS // comment' is-no a.scss '// A row is no reader.'
flags 'CSS block comment' is-no a.css '/* A row is no reader. */'
clean 'an unquoted url() is not a comment' a.scss '.a { background: url(http://x.test/A row is no reader.); }'
clean 'a CSS string' a.css '.a::after { content: "A row is no reader."; }'
clean '// does not comment CSS' a.css '.a { color: red; // A row is no reader.
}'

# ---- shell ----

flags 'shell comment' is-no a.sh '#!/bin/sh
echo hi # A row is no reader.'
flags 'a hook with no extension' is-no pre-commit '#!/bin/sh
# A row is no reader.'
flags 'a comment after a heredoc' is-no a.sh 'cat <<EOF
x
EOF
# A row is no reader.'
clean 'shell strings' a.sh "echo '# A row is no reader.' \"# A row is no reader.\""
clean 'a substitution inside a string' a.sh 'a="$( echo "# A row is no reader." )"'
clean 'a shell heredoc' a.sh "cat <<'PHP'
# A row is no reader.
PHP"
clean 'an indented heredoc' a.sh 'cat <<-EOF
	# A row is no reader.
	EOF'
clean 'a hash inside a word' a.sh 'a=${b#A row is no reader.}; c=x#A row is no reader.'

# ---- Markdown ----

flags 'a heading' is-no a.md '# A row is no reader'
flags 'a table cell' is-no a.md '| a | A row is no reader. |'
flags 'link text' is-no a.md '[A row is no reader.](https://x.test/)'
clean 'a fenced code block' a.md '```
A row is no reader.
```'
clean 'a tilde fence' a.md '~~~php
A row is no reader.
~~~'
clean 'an inline code span' a.md 'Write `A row is no reader.` instead.'
clean 'a link URL' a.md '[here](docs/a-row-is-no-reader.md) and [there](https://x.test/is%20no%20reader)'
clean 'an image URL' a.md '![a](https://x.test/is no.png)'
clean 'code spans in a comment' a.php '<?php
// Prints `A row is no reader.`'

# ---- HTML and gyrobase templates ----

flags 'an HTML comment' is-no a.html '<!-- A row is no reader. -->'
flags 'an evComment body' is-no a.html '<evComment>
A row is
no reader.
</evComment>' 2
flags 'an evC body' is-no a.html '<evC>A row is no reader.</evC>'
flags 'text between tags' is-no a.html '<p>A row is no reader.</p>'
flags 'text after a tag with nested tags' is-no a.html '<evIf <evVar.a> = "b">A row is no reader.</evIf>'
clean 'a script body' a.html '<script>const a = "A row is no reader.";</script>'
clean 'a style body' a.html '<style>/* A row is no reader. */</style>'
clean 'an attribute' a.html '<p title="A row is no reader.">x</p>'
clean 'an evTag argument' a.html '<evVar.a default="A row is no reader.">'
clean 'an attribute holding a nested tag and quotes' a.html '<p title="<evVar.a default="A row is no reader.">">x</p>'
clean 'a tag between two words breaks the phrase' a.html '<p>A row is <b>no</b> reader.</p>'

# ---- folded negatives ----

prose_flags folded-relative \
	'A value which no Code sets.' \
	'A value that no reader takes.' \
	'A row whose name no test reads, which nothing else writes.' \
	'A list that none of the workers holds.' \
	'A file that nobody reads.' \
	'A tree that nothing inside it bounds.'
prose_clean \
	'It proves merely that nothing threw.' \
	'The test asserts that no row landed.' \
	'A value that no longer parses.' \
	'A worker that no more than one thread holds.' \
	'Refuse it on the basis that no row landed.' \
	'It checks a tree and that none breaks.' \
	'A gap is not evidence that nothing listens.' \
	'The rows came back, and for the rest, that nothing came back.' \
	'It tells the agent up front that nothing undeclared is taken.' \
	'Verify in dry-run that none of the classes remain.' \
	'It reports at severity high that nothing inside it was measured.'

prose_flags folded-contact \
	'A request no rule logs.' \
	'A placement no Location carries.' \
	'A log nothing reads.' \
	'The worker nobody started.'
prose_clean \
	'The worker no longer runs.' \
	'An error means nothing happens.' \
	'The row has no reader.' \
	'A pass that changes nothing writes nothing.' \
	'Without a rewrite nothing is merged.' \
	'Each one carrying no rows means little.' \
	'Without this pass nothing brings it back.'

prose_flags folded-subordinate \
	'Run it when no layer sets one.' \
	'Wait while no node holds the name.' \
	'Stop if none of the peers answers.' \
	'Exit because no peer answered.' \
	'Skip it since no writer holds it.' \
	'Loop until no row matches.' \
	'Fail unless no row matches.' \
	'Run it where no test reaches.' \
	'Keep it once no row remains.' \
	'Stop when nothing reads the log.' \
	'Stop when nobody holds the lock.' \
	'Stop if nothing else can hold it.' \
	'Skip it as no row matches.' \
	'Skip it as nothing holds the lock.' \
	'Skip it as nobody holds the lock.' \
	'Return the row, or null when none.' \
	"The column reads '' when none." \
	'Use the stock path if none.' \
	'Zero when no rows.' \
	'Null when no template.'
prose_clean \
	'Exit so nothing complains.' \
	'Return null where nothing was measured.' \
	'Read it when nothing is set.' \
	'Stop if nothing happens.' \
	'Stop when no longer needed.' \
	'Run it when no-op mode holds.' \
	'Stop because nothing about the answer depends on it.' \
	'Zero counts as no filter.' \
	'A failed read throws rather than reading as none.' \
	'It reaches the check as no row.' \
	'WordPress renders it as no type and falls back.' \
	'It throws rather than reading as no such class.' \
	'An until date that reads as nothing leaves the bare clause.' \
	'A blank name read as nobody starts the job.' \
	'A date reading as nothing leaves the row alone.'
flags 'a read as no plural is the clipped form' is-no note.md 'A bad tag reads as no declared names.'
if [[ "$out" == *'[folded-subordinate]'* ]]; then
	echo "✗ a read as no plural is not a subordinate clause: $out"
	fail=1
else
	echo "✓ a read as no plural is not a subordinate clause"
fi

prose_flags folded-preposition \
	'A request falls in no column.' \
	'The name belongs to no group.' \
	'The value rests on no index.' \
	'A row falls in none of the columns.'
prose_clean \
	'A row with no Event.' \
	'It returns no value.' \
	'The list comes in no particular order.' \
	'A guard is by no means enough.' \
	'Reading it pulls in none of the path.' \
	'The rows arrive in no set order.' \
	'The point of no return.' \
	'IN NO EVENT SHALL THE OWNER BE LIABLE.'

prose_flags is-no \
	'A value that is no number.' \
	'The rows are no reader.' \
	'That was no request.' \
	'Those were no rows.' \
	'A blank reads as no row.' \
	'The value is none of the listed names.'
prose_clean \
	'There is no X.' \
	'There are no rows.' \
	'There was no reply, and there were no rows.' \
	'It is no longer valid.' \
	'A list is no more than a row.' \
	'It is a no-op, and the setting is no-JS.' \
	'It is no one.' \
	'The answer is no.' \
	'It is no wider than the row.' \
	'The keys are none or many.' \
	'The button is no substitute for either check.' \
	'The overlay is no help either.' \
	'The arming is no protection.' \
	'A slow answer is no evidence of a break.' \
	'It is no fault of the gesture.' \
	'A cell is no place to surface it.'

# ---- clipped grammar ----

prose_flags possessive-noun \
	'The window is still the boot'"'"'s.' \
	'The counts are no request'"'"'s.' \
	'The failure reads as a crash'"'"'s, and stops.' \
	'The call is Foundation'"'"'s.' \
	'The node'"'"'s window is still the boot'"'"'s.' \
	'The node'"'"'s time is core'"'"'s.' \
	'The window is the boot'"'"'s, so the node'"'"'s name holds.' \
	'The boot'"'"'s window ends. The node reads a crash'"'"'s.' \
	'That'"'"'s the boot'"'"'s, and it stops.' \
	'It'"'"'s a crash'"'"'s.' \
	'The clauses'"'"' binds end. The node reads the condition'"'"'s.' \
	'The clauses'"'"' binds are the condition'"'"'s.' \
	'Read the '"'"'clauses'"'"' and the condition'"'"'s.' \
	'Read a source'"'"'s, the extractor'"'"'s or collection'"'"'s.' \
	'Read a source'"'"'s, which the extractor'"'"'s or collection'"'"'s row holds.'
prose_clean \
	'The node'"'"'s name is set.' \
	'That'"'"'s all, and it'"'"'s done.' \
	'The boot'"'"'s window holds.' \
	'They read each other'"'"'s.' \
	'Neither reads the other'"'"'s.' \
	'One client spends every other'"'"'s.' \
	'The totals, the site'"'"'s and each server'"'"'s.' \
	'Rates run on the probe'"'"'s clock, never the poll'"'"'s.' \
	'It is the app'"'"'s business, not the table'"'"'s.' \
	'Before every park, a fill'"'"'s or a sweep'"'"'s, it counts.' \
	'A Table'"'"'s, a Consumer'"'"'s, every patron'"'"'s.' \
	'The name is the hub'"'"'s, not the spoke'"'"'s.' \
	'Each set keeps its own TTL, or the Table'"'"'s.' \
	'The start'"'"'s message outranks the complete'"'"'s.' \
	'Empties are `foo`'"'"'s job, not the shell'"'"'s.' \
	'The `WITH` clauses, the condition, the clauses'"'"' binds and the condition'"'"'s.' \
	'The workers'"'"' logs and the fleet'"'"'s.' \
	'The fields of a source'"'"'s, the extractor'"'"'s or collection'"'"'s row.' \
	'A source'"'"'s, the extractor'"'"'s or collection'"'"'s row.' \
	'On a Partition'"'"'s, a Log'"'"'s or a Delay'"'"'s `:config`, it writes.' \
	'A source'"'"'s, a Log'"'"'s, a Delay'"'"'s, or the fleet'"'"'s row.'

prose_flags dropped-noun \
	'A header the check passes is one the rewrite takes.' \
	'These are ones a reader sees.'
prose_clean \
	'It is one of the rows.' \
	'That is the one a reader sees.' \
	'It is one row.'

prose_flags arrow-chain \
	'Ran it: read → parse → fails.' \
	'It goes `a` → `b` → `c`.' \
	'Read -> parse -> fail.' \
	'| A cell reads → parses → fails. |' \
	'It goes **read** → parse → fail.'
prose_clean \
	'| a state INIT → ACTIVE | b status INIT → ACTIVE |' \
	'Rename `a` → your log and `b` → your node.' \
	'Go to **Settings** → **Event Logger** → **Rules** and press Add.' \
	'A single step: read → parse.' \
	'Call a->b->c here.' \
	'A list of `a` → `b`, and `c` → `d`.' \
	'Open WP Admin → Pages → Add New.' \
	'Open Appearance → Editor → Templates.' \
	'Open DevTools → Rendering → Emulate.'
clean 'a mapping across lines is not a chain' a.md 'One thing → first answer
second thing → second answer'
clean 'trailing comments do not chain' a.js 'const a = 1; // → 0s
const b = 2; // → 500ms'
clean 'an arrow chain in a PHP comment is notation' a.php '<?php
// Read → parse → fail.'
clean 'an ASCII arrow chain in a docblock is notation' a.php '<?php
/**
 * Read -> parse -> fail.
 */'
clean 'an arrow chain in a JS comment is notation' a.js '// Read → parse → fail.'
clean 'an arrow chain in a SCSS comment is notation' a.scss '// Read → parse → fail.'
clean 'an arrow chain in a shell comment is notation' a.sh '# Read → parse → fail.'
clean 'an arrow chain in an HTML comment is notation' a.html '<!-- Read → parse → fail. -->'

# ---- throat-clearing and qualifiers ----

prose_flags throat-clearing \
	'It'"'"'s worth noting that rows land.' \
	'It is worth noting that rows land.' \
	'I should mention the rows.' \
	'It should be noted that rows land.' \
	'Needless to say, rows land.'

prose_flags dead-very 'A very long row.'
prose_flags dead-quite 'A quite long row.'
prose_flags dead-rather 'A rather long row.'
prose_flags dead-really \
	'It really holds.' \
	'The worker really holds the lock.' \
	'The spenders really did exhaust the budget.'
prose_flags dead-actually \
	'It actually holds.' \
	'Actually, the row holds.' \
	'The worker actually holds the lock.' \
	'This is actually a list.' \
	'Actually move the files.' \
	'The rows we actually read.'
prose_flags dead-somewhat 'A somewhat long row.'
prose_flags dead-fairly 'A fairly long row.'
prose_clean \
	'Use a row rather than a list.' \
	'Everything works.' \
	'It reads the very next line.' \
	'A very-long-ago row.' \
	'The boot reads its very first row.' \
	'Those very spans open it.' \
	'If you would rather read it, or you'"'"'d rather not.' \
	'Share it fairly, and split it fairly.' \
	'It just holds.' \
	'It does not actually hold.' \
	'The spinner doesn'"'"'t really render.' \
	'It runs without actually sleeping.' \
	'It passes instead of actually running the loop.' \
	'Actually move the files. Without this flag it lists them.' \
	'It never actually ran.' \
	'Commit only when an include actually WENT.' \
	'Only keys ACTUALLY PRESENT count.' \
	'Report what the node actually holds.' \
	'Say how long it really ran.' \
	'Ask where the method really lives.' \
	'Clamp it to whatever the user actually holds.' \
	'Measure whichever element actually scrolls.' \
	'Check whether the row actually landed.' \
	'It read the store actually written, not a stale copy.' \
	'Assert the shape it actually sent rather than a mock.' \
	'Read-only in effect, it really writes.' \
	'It looks idle but actually writes.' \
	'Run it as production code so it is really measured.' \
	'A real class, so the test actually builds a node.'
if grep -q 'dead-just' "$gate"; then
	echo "✗ the gate carries no rule for \"just\""
	fail=1
else
	echo "✓ the gate carries no rule for \"just\""
fi

# ---- links ----

prose_flags github-line \
	'See [foo](https://github.com/a/b/blob/main/c.php) (:181).' \
	'See https://github.com/a/b/blob/main/c.php (:84-97).' \
	'See [`foo`](https://github.com/a/b/blob/main/c.php#L1) (:181).'
prose_clean \
	'See [foo](https://github.com/a/b/blob/main/c.php#L181).' \
	'See [foo](https://x.test/c.php) (:181).' \
	'See `foo` (:181).'

# ---- the staged half of the wiring ----

# Every plugin hands lint-staged's whole list to the gate, whose READERS choose.
for plugin in "$( pwd )"/../../newspack-*/; do
	[[ -f "$plugin/scripts/pre-commit" ]] || continue
	name="$( basename "$plugin" )"
	wired="$( node -p \
		'require( process.argv[ 1 ] )[ "lint-staged" ][ "*" ]' \
		"$( cd "$plugin" && pwd )/package.json" )"
	if [[ "$wired" == 'node scripts/lint-english.mjs' ]]; then
		echo "✓ $name hands every staged file to the gate"
	else
		echo "✗ $name hands every staged file to the gate: $wired"
		fail=1
	fi
done

# ---- the gate holds itself to its own rules ----

run_gate "$gate" "$0"
if [[ $status -eq 0 ]]; then
	echo "✓ the gate and its tests pass the gate"
else
	echo "✗ the gate and its tests pass the gate:"
	echo "$out"
	fail=1
fi

[ "$fail" -eq 0 ] && echo "all prose-gate tests passed"
exit "$fail"
