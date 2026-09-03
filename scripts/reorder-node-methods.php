#!/usr/bin/env php
<?php
/**
 * Newspaper-order the members of a PHP class, so a reader meets an entrypoint
 * first and every helper below the code that calls it.
 *
 * A class body comes out as its trait-`use` block, then its field block, then
 * its methods in call-graph order. Member bodies are NEVER edited: each member
 * moves as a raw text span, and its leading docblock and blank line travel with
 * it. Two invariants are checked before any write — the multiset of member
 * texts is byte-identical before and after, and the byte histogram of the WHOLE
 * file is unchanged — and a mismatch aborts that file and fails the run. Two
 * observable changes are deliberately NOT guarded, because they are the point:
 * a comment can re-associate to a different member, and the declaration order
 * that reflection reports shifts.
 *
 * `reorder-node-methods.js` is the JS twin, and `test-reorder-node-methods.sh`
 * holds the two to the same orderings. This repo carries the authoritative copy
 * that `sync-shared-scripts.sh` vendors into every sibling plugin, so edit it
 * here; an edit to a vendored copy is overwritten on that sibling's next commit.
 *
 * Node detection keys on the `_Node` suffix — ADR-10's naming, which is what
 * `make_node` resolves against. A class named `Node` or `*_Node`, or extending
 * one (namespace-qualified parents included), takes the node policy.
 *
 * Two ordering policies:
 *
 *   NODE — `__construct`, `arguments`, `fill`, `fire_cb`, `fire` (the node
 *     lifecycle in the order it runs), then the call-graph middle in
 *     topological order, then the methods no self-dispatch edge touches in
 *     source order, then `node_schema` last.
 *
 *   GENERIC (every other class) — `__construct`, then every remaining method
 *     in topological order.
 *
 * Topological order means a method is emitted only once EVERY caller of it
 * already is, so no caller ever prints below something it calls. A cycle stalls
 * the sort, and the members left over fall through in source order.
 *
 * Member boundaries come from `token_get_all`, so a brace inside a string,
 * comment, heredoc or closure never confuses the scan.
 *
 * Declared field order is observable through `get_object_vars`, a `foreach`, an
 * `(array)` cast and JSON, so fields keep source order unless `--sort-fields`
 * opts into the convention sort. A run of fields under an `// @ordered` marker
 * keeps its slot even then. A file under `tests/` or `__tests__/` is skipped
 * whole.
 *
 * Usage — run on the host, because the container's `/services` mount is
 * read-only:
 *
 *   php reorder-node-methods.php [--check|--write] [--sort-fields] <file.php> [...]
 *
 * With no flag it reports what it would change and exits 0. `--check` reports
 * the same and exits 1, which is how lint-staged gates a commit. `--write`
 * applies, and `--sort-fields` sorts the field block as well.
 *
 * After `--write`, run `phpcbf` on the changed files to normalize the blank
 * lines between members, then the test suite.
 *
 * @package Newspack_Nodes
 *
 * @phpstan-type Token array{0:int|null,1:string,2:int}
 * @phpstan-type Member array{method:bool,name:string,static:bool,public:bool,end:int,start_fn:int,vis?:string,kind?:string}
 * @phpstan-type ClassRec array{contentStart:int,is_node:bool,members:list<Member>}
 */

/**
 * Fixed-order rank for a method name under the node policy.
 *
 * `order_methods_node()` reads the number as three bands: under 5 is the fixed
 * prefix and sorts on the rank itself, 1000 is `node_schema` last, and the 500
 * default is the call-graph middle.
 *
 * @param string $name Method name.
 * @return int Rank.
 */
function priority( string $name ): int {
	return match ( $name ) {
		'__construct' => 0,
		'arguments'   => 1,
		'fill'        => 2,
		'fire_cb'     => 3,
		'fire'        => 4,
		'node_schema' => 1000,
		default       => 500,
	};
}

/**
 * Tokenize `$src`, giving every token its byte offset.
 *
 * `token_get_all()` reports a line number but no offset, and every member
 * boundary here is a substring of the source.
 *
 * @param string $src PHP source.
 * @return list<Token> Every token in source order, its id null for a
 *                     single-character token.
 */
function tokens_with_offsets( string $src ): array {
	$toks = token_get_all( $src );
	$out  = [];
	$off  = 0;
	foreach ( $toks as $t ) {
		if ( is_array( $t ) ) { $out[] = [ $t[0], $t[1], $off ]; $off += strlen( $t[1] ); }
		else { $out[] = [ null, $t, $off ]; $off += strlen( $t ); }
	}
	return $out;
}

/**
 * The first write invariant: sorted texts of EVERY member in the file.
 *
 * Reordering is a permutation, so this multiset is unchanged unless a member's
 * own text was corrupted — which aborts the write. Each span runs from the
 * member's `function` keyword, or from its first token for a field, to its end,
 * so a mangled signature or body is caught here. The leading docblock, the
 * modifiers ahead of `function`, and the whitespace between members fall to the
 * second invariant instead, the whole-file byte histogram.
 *
 * @param string $src PHP source.
 * @return list<string> Member texts, sorted.
 */
function member_fingerprint( string $src ): array {
	$fp = [];
	foreach ( find_classes( $src ) as $cls ) {
		foreach ( $cls['members'] as $m ) {
			$fp[] = substr( $src, $m['start_fn'], $m['end'] - $m['start_fn'] );
		}
	}
	sort( $fp );
	return $fp;
}

/**
 * Build a non-method member — a const, a property or a trait `use` — with the
 * metadata the field-ordering convention sorts on: kind, visibility,
 * static-ness and name.
 *
 * The name is recovered by regex over the member's own text rather than from
 * the token walk, because the three kinds each spell it somewhere else.
 *
 * @param string $src    PHP source.
 * @param int    $start  Byte offset of the member's first token.
 * @param int    $end    Byte offset just past the member.
 * @param string $vis    Declared visibility: `public`, `protected` or `private`.
 * @param bool   $static Whether a `static` keyword was seen.
 * @param bool   $const  Whether a `const` keyword was seen.
 * @param bool   $use    Whether a `use` keyword was seen.
 * @return Member
 */
function field_member( string $src, int $start, int $end, string $vis, bool $static, bool $const, bool $use ): array {
	$text = substr( $src, $start, $end - $start );
	if ( $use ) {
		$kind = 'use';
		$name = preg_match( '/\buse\s+(\w+)/', $text, $m ) ? $m[1] : '';
	} elseif ( $const ) {
		$kind = 'const';
		$name = preg_match( '/\bconst\s+(?:\S+\s+)?([A-Za-z_]\w*)\s*[=;]/', $text, $m ) ? $m[1] : '';
	} else {
		$kind = 'prop';
		$name = preg_match( '/\$(\w+)/', $text, $m ) ? $m[1] : '';
	}
	return [ 'method' => false, 'name' => $name, 'static' => $static, 'public' => 'public' === $vis, 'vis' => $vis, 'kind' => $kind, 'end' => $end, 'start_fn' => $start ];
}

/**
 * Member end offset, extended to swallow a trailing SAME-LINE `//`, `#`, or
 * `/* ... *\/` comment after the terminating `;`/`}`. Without this the trailing
 * comment falls into the next member's leading chunk and gets orphaned onto the
 * wrong line on reorder.
 *
 * @param list<Token> $toks      Every token in the file.
 * @param int         $n         Token count.
 * @param int         $close_idx Index of the `;` or `}` that ends the member.
 * @return int Byte offset just past the member.
 */
function absorb_trailing_comment( array $toks, int $n, int $close_idx ): int {
	$end  = $toks[ $close_idx ][2] + strlen( $toks[ $close_idx ][1] );
	$next = $close_idx + 1;
	// Optional same-line whitespace before the comment (no newline).
	if ( $next < $n && $toks[ $next ][0] === T_WHITESPACE && strpos( $toks[ $next ][1], "\n" ) === false ) {
		$next++;
	}
	if ( $next < $n && $toks[ $next ][0] === T_COMMENT ) {
		$c = ltrim( $toks[ $next ][1] );
		if ( str_starts_with( $c, '//' ) || str_starts_with( $c, '#' ) || str_starts_with( $c, '/*' ) ) {
			return $toks[ $next ][2] + strlen( $toks[ $next ][1] ); // includes any trailing newline
		}
	}
	return $end;
}

/**
 * Last `\`-delimited segment of a qualified name (`\A\B_Node` → `B_Node`).
 *
 * @param string $name A class name, qualified or not.
 * @return string The unqualified name.
 */
function last_ns_segment( string $name ): string {
	$pos = strrpos( $name, '\\' );
	return false === $pos ? $name : substr( $name, $pos + 1 );
}

/**
 * Whether a token id can spell a class name.
 *
 * A namespaced name arrives as one `T_NAME_*` token rather than a run of
 * `T_STRING`s, so without those ids `extends \Newspack_Nodes\Job_Worker_Node`
 * reads as no parent at all, and a subclass whose own name lacks the `_Node`
 * suffix silently drops to the generic policy.
 *
 * @param int|null $id Token id, or null for a single-character token.
 * @return bool
 */
function is_name_token( ?int $id ): bool {
	return T_STRING === $id || T_NAME_QUALIFIED === $id || T_NAME_FULLY_QUALIFIED === $id || T_NAME_RELATIVE === $id;
}

/**
 * Every class in the file, with its depth-1 members and their offsets.
 *
 * Nothing is filtered out: each record is tagged `is_node` so `reorder()` picks
 * the policy per class.
 *
 * @param string $src PHP source.
 * @return list<ClassRec>
 */
function find_classes( string $src ): array {
	$toks    = tokens_with_offsets( $src );
	$n       = count( $toks );
	$classes = [];
	for ( $i = 0; $i < $n; $i++ ) {
		if ( $toks[ $i ][0] !== T_CLASS ) continue;
		// `Foo::class` tokenizes as T_CLASS but declares nothing — skip it.
		$p = $i - 1;
		while ( $p >= 0 && ( $toks[ $p ][0] === T_WHITESPACE || $toks[ $p ][0] === T_COMMENT ) ) $p--;
		if ( $p >= 0 && $toks[ $p ][0] === T_DOUBLE_COLON ) continue;
		$j         = $i + 1;
		$extends   = '';
		$className = '';
		while ( $j < $n && $toks[ $j ][1] !== '{' ) {
			if ( is_name_token( $toks[ $j ][0] ) && $className === '' ) $className = last_ns_segment( $toks[ $j ][1] ); // first name token = class name
			if ( $toks[ $j ][0] === T_EXTENDS ) {
				$k = $j + 1;
				while ( $k < $n && $toks[ $k ][1] !== '{' && $toks[ $k ][0] !== T_IMPLEMENTS ) {
					if ( is_name_token( $toks[ $k ][0] ) ) $extends = last_ns_segment( $toks[ $k ][1] );
					$k++;
				}
			}
			$j++;
		}
		if ( $j >= $n ) continue;
		// @longform Node-orderable if the class IS a node base (name 'Node' or
		// '*_Node') or extends one. Node policy orders the base class right
		// (fill/fire prefix + call graph), so unlike generic policy it needs
		// no exclusion.
		$is_node = ( $className === 'Node' || str_ends_with( $className, '_Node' )
			|| $extends === 'Node' || str_ends_with( $extends, '_Node' ) );

		// $j is the class body '{'. Walk depth-1 members.
		$contentStart = $toks[ $j ][2] + 1; // offset just after '{'
		$depth        = 0;
		$members      = [];
		$memStart = null; $sawFunction = false; $fnName = null; $fnStatic = false; $fnPublic = true; $fnNameOff = null;
		$mVis = 'public'; $mConst = false; $mUse = false;
		for ( $k = $j; $k < $n; $k++ ) {
			$txt = $toks[ $k ][1];
			if ( $txt === '{' ) { $depth++; continue; }
			if ( $txt === '}' ) {
				$depth--;
				if ( $depth === 0 ) break; // class closes
				if ( $depth === 1 && $sawFunction ) { // method body closed
					if ( null !== $fnName && null !== $fnNameOff )
						$members[] = [ 'method' => true, 'name' => $fnName, 'static' => $fnStatic, 'public' => $fnPublic, 'end' => absorb_trailing_comment( $toks, $n, $k ), 'start_fn' => $fnNameOff ];
					$memStart = null; $sawFunction = false; $fnName = null; $fnStatic = false; $fnPublic = true; $fnNameOff = null;
					$mVis = 'public'; $mConst = false; $mUse = false;
				} elseif ( $depth === 1 && $mUse ) { // trait-use adaptation block closed (has no depth-1 ';')
					if ( null !== $memStart )
						$members[] = field_member( $src, $memStart, absorb_trailing_comment( $toks, $n, $k ), $mVis, $fnStatic, $mConst, $mUse );
					$memStart = null; $sawFunction = false; $fnName = null; $fnStatic = false; $fnPublic = true; $fnNameOff = null;
					$mVis = 'public'; $mConst = false; $mUse = false;
				}
				continue;
			}
			if ( $depth !== 1 ) continue;
			$id = $toks[ $k ][0];
			if ( $id === T_WHITESPACE || $id === T_COMMENT || $id === T_DOC_COMMENT ) continue; // leading trivia → chunk
			if ( $memStart === null ) $memStart = $toks[ $k ][2];
			if ( $id === T_FUNCTION ) { $sawFunction = true; if ( $fnNameOff === null ) $fnNameOff = $toks[ $k ][2]; }
			if ( $id === T_STATIC ) $fnStatic = true;
			if ( $id === T_CONST ) $mConst = true;
			if ( $id === T_USE ) $mUse = true;
			if ( $id === T_PRIVATE ) { $fnPublic = false; $mVis = 'private'; }
			elseif ( $id === T_PROTECTED ) { $fnPublic = false; $mVis = 'protected'; }
			elseif ( $id === T_PUBLIC ) { $mVis = 'public'; }
			// @longform The method name is the first identifier-shaped token
			// after `function` (skip the optional `&` for by-ref). Match by
			// TEXT, not token id: a semi-reserved name (`list`, `print`,
			// `unset`, …) tokenizes as T_LIST/T_PRINT/…, never T_STRING.
			if ( $sawFunction && $fnName === null && $id !== T_FUNCTION && \preg_match( '/^[a-zA-Z_][a-zA-Z0-9_]*$/', $txt ) ) $fnName = $txt;
			if ( $txt === ';' ) {
				if ( $sawFunction ) { // abstract method (no body)
					if ( null !== $fnName && null !== $fnNameOff )
						$members[] = [ 'method' => true, 'name' => $fnName, 'static' => $fnStatic, 'public' => $fnPublic, 'end' => absorb_trailing_comment( $toks, $n, $k ), 'start_fn' => $fnNameOff ];
				} else // property / const / use
					$members[] = field_member( $src, $memStart, absorb_trailing_comment( $toks, $n, $k ), $mVis, $fnStatic, $mConst, $mUse );
				$memStart = null; $sawFunction = false; $fnName = null; $fnStatic = false; $fnPublic = true; $fnNameOff = null;
				$mVis = 'public'; $mConst = false; $mUse = false;
			}
		}
		$classes[] = [ 'contentStart' => $contentStart, 'is_node' => $is_node, 'members' => $members ];
	}
	return $classes;
}

/**
 * A reader of one method's SELF-dispatched callees (`$this->`, `$this?->`,
 * `self::`, `static::`), in first-appearance order; a call on another object
 * (`$p->foo()`) is not an edge.
 *
 * Detection scans the TOKEN stream over the method's `[start_fn, end]` range,
 * so a call spelled inside a string, comment or heredoc is never an edge. The
 * reader takes a method index and a `$soft` flag: false returns the edges
 * outside any closure body, which is the call graph both policies sort on; true
 * returns only what the closure bodies call, which gates nothing and serves the
 * generic policy as a locality tie-break.
 *
 * @param list<Token>       $toks    Every token in the file.
 * @param list<Member>      $methods The class's methods, in source order.
 * @param array<string,int> $names   Method name to its index in $methods.
 * @return callable(int,bool=): list<string>
 */
function callees_factory( array $toks, array $methods, array $names ): callable {
	$nt  = count( $toks );
	$adv = function ( int $k ) use ( $toks, $nt ): int {
		while ( $k < $nt && ( $toks[ $k ][0] === T_WHITESPACE || $toks[ $k ][0] === T_COMMENT || $toks[ $k ][0] === T_DOC_COMMENT ) ) $k++;
		return $k;
	};
	/**
	 * @param int  $i    Index into $methods.
	 * @param bool $soft Return only what this method's closure bodies call.
	 * @return list<string> Callee method names.
	 */
	return function ( int $i, bool $soft = false ) use ( $toks, $nt, $methods, $names, $adv ) {
		$start = $methods[ $i ]['start_fn'];
		$end   = $methods[ $i ]['end'];
		$first = [];
		// @longform A closure body is a scope of its own: the call runs later,
		// under whoever invokes the closure, so attributing it to the enclosing
		// method invents an edge. Skip from `function`/`fn` to the end of its
		// body. $depth counts braces once inside one; -1 means we are not.
		$depth = -1;
		for ( $k = 0; $k < $nt; $k++ ) {
			$off = $toks[ $k ][2];
			if ( $off < $start ) continue;
			if ( $off >= $end ) break;
			$id  = $toks[ $k ][0];
			$own = ( $off === $start ); // own declaration, not a closure
			if ( ! $own && $depth < 0 && ( T_FUNCTION === $id || T_FN === $id ) ) {
				$depth = 0;
				continue;
			}
			if ( $depth >= 0 ) {
				$t = $toks[ $k ][1];
				if ( '{' === $t ) $depth++;
				elseif ( '}' === $t ) { $depth--; if ( 0 === $depth ) $depth = -1; }
				elseif ( 0 === $depth && ( ';' === $t || ',' === $t ) ) $depth = -1; // arrow fn ends
				if ( ! $soft ) continue;
			} elseif ( $soft ) {
				continue; // soft pass wants ONLY what the closures call
			}
			$txt = $toks[ $k ][1];
			$is_this   = ( T_VARIABLE === $id && '$this' === $txt );
			$is_self   = ( T_STRING === $id && 'self' === $txt );
			$is_static = ( T_STATIC === $id );
			if ( ! $is_this && ! $is_self && ! $is_static ) continue;
			$k2 = $adv( $k + 1 );
			$op = $toks[ $k2 ][0] ?? null;
			$op_ok = $is_this
				? ( T_OBJECT_OPERATOR === $op || T_NULLSAFE_OBJECT_OPERATOR === $op || T_DOUBLE_COLON === $op )
				: ( T_DOUBLE_COLON === $op );
			if ( ! $op_ok ) continue;
			$k3 = $adv( $k2 + 1 );
			if ( T_STRING !== ( $toks[ $k3 ][0] ?? null ) ) continue;
			$name = $toks[ $k3 ][1];
			if ( ! isset( $names[ $name ] ) || $names[ $name ] === $i ) continue; // unknown method or self
			$k4 = $adv( $k3 + 1 );
			if ( '(' !== ( $toks[ $k4 ][1] ?? null ) ) continue;
			if ( ! isset( $first[ $name ] ) ) $first[ $name ] = $off; // first appearance
		}
		asort( $first );
		return array_keys( $first );
	};
}

/**
 * NODE policy: the fixed prefix, the call-graph middle, the standalone methods,
 * then `node_schema`.
 *
 * The prefix is `__construct`, `arguments`, `fill`, `fire_cb`, `fire`,
 * pre-placed in that order but still pulling their middle helpers in. The
 * middle is emitted in topological order, every callee below ALL its callers,
 * with ties broken by source order. A method no self-dispatch edge touches is
 * standalone and follows the middle in source order. A cycle stalls the sort,
 * and the methods left over fall through in source order.
 *
 * @param list<Token>  $toks    Every token in the file.
 * @param list<Member> $methods The class's methods, in source order.
 * @return list<int> Indices into $methods, in output order.
 */
function order_methods_node( array $toks, array $methods ): array {
	$names = [];
	foreach ( $methods as $i => $m ) $names[ $m['name'] ] = $i;
	$callees_of = callees_factory( $toks, $methods, $names );

	$prefix = []; $suffix = []; $middle = [];
	foreach ( $methods as $i => $m ) {
		$r = priority( $m['name'] );
		if ( $r < 5 ) $prefix[] = [ 'i' => $i, 'r' => $r ];
		elseif ( $r === 1000 ) $suffix[] = $i;
		else $middle[] = $i;
	}
	usort( $prefix, fn( $a, $b ) => $a['r'] <=> $b['r'] );
	$prefixIdx = array_map( fn( $t ) => $t['i'], $prefix );
	$middleSet = array_flip( $middle );

	// Prefix entrypoints are pre-placed, but still pull middle helpers in.
	$callees = []; $indeg = array_fill_keys( $middle, 0 ); $called_by_prefix = [];
	foreach ( array_merge( $prefixIdx, $middle ) as $i ) {
		$cs = [];
		foreach ( $callees_of( $i ) as $cn ) {
			$j = $names[ $cn ] ?? null;
			if ( $j === null || ! isset( $middleSet[ $j ] ) ) continue;
			$cs[] = $j;
			if ( isset( $middleSet[ $i ] ) ) $indeg[ $j ]++; // only middle callers gate
			else $called_by_prefix[ $j ] = 1;
		}
		$callees[ $i ] = $cs;
	}

	// Connected = incident to any self-dispatch edge; the rest are standalone.
	$connected = [];
	foreach ( $middle as $i )
		if ( $callees[ $i ] || $indeg[ $i ] > 0 || isset( $called_by_prefix[ $i ] ) ) $connected[ $i ] = 1;

	// Kahn emit (ascending index breaks ties); a cycle falls to source order.
	$placed = []; $visited = [];
	$remaining = array_values( array_filter( $middle, fn( $i ) => isset( $connected[ $i ] ) ) );
	while ( true ) {
		$avail = array_values( array_filter( $remaining, fn( $i ) => ! isset( $visited[ $i ] ) && 0 === $indeg[ $i ] ) );
		if ( ! $avail ) break;
		sort( $avail );
		$i = $avail[0];
		$visited[ $i ] = 1; $placed[] = $i;
		foreach ( $callees[ $i ] as $j ) if ( isset( $indeg[ $j ] ) ) $indeg[ $j ]--;
	}
	foreach ( $remaining as $i ) if ( ! isset( $visited[ $i ] ) ) { $visited[ $i ] = 1; $placed[] = $i; } // cycle
	$standalone = array_values( array_filter( $middle, fn( $i ) => ! isset( $connected[ $i ] ) ) );

	return array_merge( $prefixIdx, $placed, $standalone, $suffix );
}

/**
 * GENERIC policy: `__construct`, then every remaining method in topological
 * order.
 *
 * A method is emitted only once EVERY caller of it already is, so no caller
 * ever prints below something it calls. The constructor is pre-placed and gates
 * nothing. Ties prefer, in order: the method a caller just freed, so a chain
 * stays together; then a public method that calls something, then any other
 * public method; then source order. A cycle stalls the sort, and the methods
 * left over fall through in source order.
 *
 * @param list<Token>  $toks    Every token in the file.
 * @param list<Member> $methods The class's methods, in source order.
 * @return list<int> Indices into $methods, in output order.
 */
function order_methods_generic( array $toks, array $methods ): array {
	$names = [];
	foreach ( $methods as $i => $m ) $names[ $m['name'] ] = $i;
	$callees_of = callees_factory( $toks, $methods, $names );

	$ctor = []; $rest = [];
	foreach ( $methods as $i => $m ) { if ( $m['name'] === '__construct' ) $ctor[] = $i; else $rest[] = $i; }
	$restSet = array_flip( $rest );

	// @longform In-degree counts callers among $rest. The constructor is
	// pre-placed and gates nothing, so its callees stay free to sink below
	// whichever other callers they have.
	$callees = []; $indeg = array_fill_keys( $rest, 0 );
	foreach ( array_merge( $ctor, $rest ) as $i ) {
		$cs = [];
		foreach ( $callees_of( $i ) as $cn ) {
			$j = $names[ $cn ] ?? null;
			if ( $j === null || ! isset( $restSet[ $j ] ) ) continue;
			$cs[] = $j;
			if ( isset( $restSet[ $i ] ) ) $indeg[ $j ]++;
		}
		$callees[ $i ] = $cs;
	}

	// @longform Kahn: a method is emitted only once EVERY caller of it
	// already is, so no caller can ever print below a method it calls.
	// Freed order breaks ties first, most recent winning: emitting a caller
	// pulls in the callees it just released, so a chain stays together
	// instead of yielding to an unrelated root that merely sorts earlier.
	// Roots free from the start share order 0 and fall to rank, then
	// source. A cycle stalls the sort and falls through below.
	$placed = []; $visited = []; $freed = array_fill_keys( $rest, 0 ); $tick = 0;
	$rank = fn( $i ) => ( $methods[ $i ]['public'] && $callees[ $i ] ) ? 0 : ( $methods[ $i ]['public'] ? 1 : 2 );
	while ( true ) {
		$avail = array_values( array_filter( $rest, fn( $i ) => ! isset( $visited[ $i ] ) && 0 === $indeg[ $i ] ) );
		if ( ! $avail ) break;
		usort( $avail, function ( $a, $b ) use ( $rank, $freed ) {
			return ( $freed[ $b ] <=> $freed[ $a ] ) ?: ( $rank( $a ) <=> $rank( $b ) ) ?: ( $a <=> $b );
		} );
		$i = $avail[0];
		$visited[ $i ] = 1; $placed[] = $i;
		foreach ( $callees[ $i ] as $j ) {
			if ( 0 === --$indeg[ $j ] ) $freed[ $j ] = ++$tick;
		}
		// @longform A closure body's calls gate nothing — they run later, under
		// whoever invokes the closure — but they still say "these two belong
		// together", so they nudge an already-free method up the tie-break.
		foreach ( $callees_of( $i, true ) as $cn ) {
			$j = $names[ $cn ] ?? null;
			if ( null !== $j && isset( $indeg[ $j ] ) && ! isset( $visited[ $j ] ) && 0 === $indeg[ $j ] ) {
				$freed[ $j ] = ++$tick;
			}
		}
	}
	foreach ( $rest as $i ) if ( ! isset( $visited[ $i ] ) ) { $visited[ $i ] = 1; $placed[] = $i; } // cycle
	return array_merge( $ctor, $placed );
}

/**
 * `--sort-fields` kind rank: const (0), static property (1), instance
 * property (2).
 *
 * @param Member $m One member.
 * @return int Rank.
 */
function field_kind_rank( array $m ): int {
	return 'const' === ( $m['kind'] ?? '' ) ? 0 : ( ! empty( $m['static'] ) ? 1 : 2 );
}

/**
 * `--sort-fields` visibility rank: public (0), protected (1), private (2).
 *
 * @param Member $m One member.
 * @return int Rank.
 */
function field_vis_rank( array $m ): int {
	return [ 'public' => 0, 'protected' => 1, 'private' => 2 ][ $m['vis'] ?? 'public' ] ?? 0;
}

/**
 * Field slots pinned by a `// @ordered` marker, which --sort-fields must leave
 * alone. A positional layout (Message's 7 wire fields, a packed record) is only
 * correct in DECLARATION order; alphabetising it silently renumbers the wire.
 *
 * The marker opens a block and the first blank line closes it, so one comment
 * pins the run of fields under it and nothing else. A second marker re-opens.
 *
 * @param string    $src          PHP source.
 * @param Member[]  $slice        All members of the class, in source order.
 * @param int       $region_start Byte offset just past the class body's `{`.
 * @param list<int> $field_pos    Indices into $slice of the const and property
 *                                members; a trait `use` is not one of them.
 * @return array<int,true> Pinned $slice indices, as a set.
 */
function pinned_field_positions( string $src, array $slice, int $region_start, array $field_pos ): array {
	$pinned = [];
	$open   = false;
	foreach ( $field_pos as $p ) {
		$cs   = 0 === $p ? $region_start : $slice[ $p - 1 ]['end'];
		$lead = substr( $src, $cs, $slice[ $p ]['start_fn'] - $cs );
		if ( preg_match( '{(?:^|\n)\s*(?://|\#)\s*@ordered\b|/\*.*?@ordered\b}s', $lead ) ) {
			$open = true;
		} elseif ( $open && preg_match( '/\n[ \t]*\n/', $lead ) ) {
			$open = false;
		}
		if ( $open ) {
			$pinned[ $p ] = true;
		}
	}
	return $pinned;
}

/**
 * Rewrite every class body in `$src` into convention order.
 *
 * A class body comes out as its trait-`use` block, then its field block, then
 * its methods under the node or the generic policy. Each member travels as one
 * chunk running from the end of the member before it, so its leading docblock,
 * modifiers and blank lines move with it. Classes are rewritten right to left,
 * which keeps the offsets of the ones still to come valid. A class with fewer
 * than two members, one with no method at all, and one already in convention
 * order are each left alone.
 *
 * @param string $src         PHP source.
 * @param bool   $sort_fields Sort the field block as well.
 * @return array{0:string,1:list<string>} The rewritten source, and one note per
 *                                        class reordered.
 */
function reorder( string $src, bool $sort_fields = false ): array {
	$classes = find_classes( $src );
	$toks    = tokens_with_offsets( $src );
	usort( $classes, fn( $a, $b ) => $b['contentStart'] <=> $a['contentStart'] ); // right-to-left: offsets stay valid
	$out   = $src;
	$notes = [];
	foreach ( $classes as $cls ) {
		$slice = $cls['members'];
		if ( count( $slice ) < 2 ) continue;
		$has_method = false;
		foreach ( $slice as $m ) if ( $m['method'] ) { $has_method = true; break; }
		if ( ! $has_method ) continue;

		// The region spans the whole class body: fields hoist above methods.
		$regionStart = $cls['contentStart'];
		$regionEnd   = $slice[ count( $slice ) - 1 ]['end'];
		$chunks = [];
		foreach ( $slice as $p => $m ) {
			$cs           = $p === 0 ? $regionStart : $slice[ $p - 1 ]['end'];
			$chunks[ $p ] = substr( $src, $cs, $m['end'] - $cs );
		}

		$use_pos = []; $field_pos = []; $method_pos = [];
		foreach ( $slice as $p => $m ) {
			if ( $m['method'] ) $method_pos[] = $p;
			elseif ( ( $m['kind'] ?? '' ) === 'use' ) $use_pos[] = $p;
			else $field_pos[] = $p;
		}

		// --sort-fields: kind, vis, name; @ordered blocks keep slot and order.
		if ( $sort_fields ) {
			$pinned  = pinned_field_positions( $src, $slice, $regionStart, $field_pos );
			$movable = array_values( array_filter( $field_pos, fn( int $p ) => ! isset( $pinned[ $p ] ) ) );
			usort( $movable, function ( int $a, int $b ) use ( $slice ) {
				$ka = [ field_kind_rank( $slice[ $a ] ), field_vis_rank( $slice[ $a ] ), $slice[ $a ]['name'], $a ];
				$kb = [ field_kind_rank( $slice[ $b ] ), field_vis_rank( $slice[ $b ] ), $slice[ $b ]['name'], $b ];
				return $ka <=> $kb;
			} );
			$next = 0;
			foreach ( $field_pos as $k => $p ) {
				if ( ! isset( $pinned[ $p ] ) ) {
					$field_pos[ $k ] = $movable[ $next++ ];
				}
			}
		}

		$methods = array_map( fn( $p ) => $slice[ $p ], $method_pos );
		$order   = $cls['is_node'] ? order_methods_node( $toks, $methods ) : order_methods_generic( $toks, $methods );
		$ordered_method_pos = array_map( fn( $k ) => $method_pos[ $k ], $order );

		$final = array_merge( $use_pos, $field_pos, $ordered_method_pos );
		if ( $final === range( 0, count( $slice ) - 1 ) ) continue; // already in convention order
		$newRegion = implode( '', array_map( fn( $p ) => $chunks[ $p ], $final ) );
		$out       = substr( $out, 0, $regionStart ) . $newRegion . substr( $out, $regionEnd );
		$notes[]   = 'reordered: ' . implode( ', ', array_map( fn( $p ) => $slice[ $p ]['method'] ? $slice[ $p ]['name'] : '(field)', $final ) );
	}
	return [ $out, $notes ];
}

/**
 * Write $out over $f atomically: a same-dir temp file (so rename is atomic,
 * never cross-device), chmod'd to the original mode, then renamed into place.
 * A failed step cleans up the temp file and returns false, so callers fail loud.
 *
 * @param string $f   Path to overwrite.
 * @param string $out New contents.
 * @return bool True when the rename landed.
 */
function write_atomic( string $f, string $out ): bool {
	$dir = dirname( $f );
	$tmp = tempnam( $dir, '.reorder' );
	if ( false === $tmp ) return false;
	if ( false === file_put_contents( $tmp, $out ) || ! chmod( $tmp, fileperms( $f ) & 0777 ) || ! rename( $tmp, $f ) ) {
		unlink( $tmp );
		return false;
	}
	return true;
}

/** @var list<string> $argv */
$argv_rest   = array_slice( $argv, 1 );
$write       = in_array( '--write', $argv_rest, true );
// --check: dry-run that FAILS when a file is out of order, for the hook.
$check       = in_array( '--check', $argv_rest, true );
$sort_fields = in_array( '--sort-fields', $argv_rest, true );
$files       = array_values( array_filter( $argv_rest, fn( $a ) => ! str_starts_with( $a, '--' ) ) );
if ( ! $files ) { fwrite( STDERR, "usage: php reorder-node-methods.php [--check|--write] [--sort-fields] <file.php> [...]\n" ); exit( 1 ); }
$failed = false;
/**
 * Whether a path holds test code, which is left alone.
 *
 * Test methods have no call graph worth ordering, `setUp` and `tearDown` are a
 * fixture contract rather than a chain, and a mock deliberately mirrors the
 * order of the class it doubles. The gate runs on every staged `*.php`, so
 * tests reach it unless excluded here.
 *
 * @param string $f Path, in either separator style.
 * @return bool
 */
function is_test_path( string $f ): bool {
	$norm = str_replace( '\\', '/', $f );
	return str_contains( $norm, '/tests/' ) || str_contains( $norm, '/__tests__/' )
		|| str_starts_with( $norm, 'tests/' );
}

foreach ( $files as $f ) {
	if ( is_test_path( $f ) ) continue;
	$src = file_get_contents( $f );
	if ( false === $src ) { fwrite( STDERR, "✗ $f: cannot read\n" ); $failed = true; continue; }
	$before = member_fingerprint( $src );
	[ $out, $notes ] = reorder( $src, $sort_fields );
	if ( $out === $src ) continue;
	// Invariants: member texts unchanged, whole-file byte multiset unchanged.
	if ( $before !== member_fingerprint( $out ) || count_chars( $src, 1 ) !== count_chars( $out, 1 ) ) {
		fwrite( STDERR, "✗ $f: INVARIANT VIOLATION — aborted\n" );
		$failed = true;
		continue;
	}
	if ( $write && ! write_atomic( $f, $out ) ) {
		fwrite( STDERR, "✗ $f: write failed\n" );
		$failed = true;
		continue;
	}
	echo "~ $f  " . implode( '; ', array_unique( $notes ) ) . "\n";
	if ( $check ) { $failed = true; }
}
exit( $failed ? 1 : 0 );
