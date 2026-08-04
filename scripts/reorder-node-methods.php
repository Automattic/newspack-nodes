#!/usr/bin/env php
<?php
/**
 * reorder-node-methods.php — newspaper-order the methods of a PHP class.
 *
 * The PHP twin of reorder-node-methods.js. Reorders each class body so methods
 * read top-down like a newspaper: an entrypoint, then the functions it calls,
 * then the functions those call — the stack deepening as you go down. Method
 * bodies are NEVER edited; they move as raw text spans (each method's leading
 * docblock + blank line travels with it), guarded by two invariants checked before
 * every write: (a) the multiset of every member's text is byte-identical before and
 * after (no method body edited), and (b) the multiset of every byte in the WHOLE file
 * is unchanged (no byte lost, duplicated, or added). A mismatch aborts the file and
 * fails the run. Residual observable changes — comment↔member association and
 * reflection/declaration order of members — are NOT guarded; they are the point.
 *
 * Node detection keys on the `_Node` suffix by design (the substrate's make_node
 * contract): a class named `Node`/`*_Node`, or extending one (namespace-qualified
 * parents included), is node-ordered.
 *
 * Two ordering policies:
 *
 *   NODE (default) — for classes extending `Node` or `*_Node`:
 *     __construct, arguments, fill, fire_cb, fire,
 *       <call-graph DFS seeded from the entrypoints fill/fire_cb/fire>,
 *     node_schema
 *
 *   GENERIC (--all-classes, for non-node classes) — __construct first, then the
 *     public "API roots" (public methods not called by any other public method,
 *     that themselves call something), ordered by call-tree depth (deepest
 *     first — the method orchestrating the deepest chain leads), each followed
 *     by its callee tree; then anything unreached in source order.
 *
 * Member boundaries come from token_get_all, so strings / comments / heredocs /
 * closures never confuse brace matching.
 *
 * Usage (host php works; the container mount is read-only):
 *   php reorder-node-methods.php                 includes/class-*.php   # dry-run, node classes
 *   php reorder-node-methods.php --write          includes/class-*.php   # apply, node classes
 *   php reorder-node-methods.php --all-classes     src/*.php              # dry-run, EVERY class
 *   php reorder-node-methods.php --all-classes --write src/*.php          # apply, every class
 *   php reorder-node-methods.php --write --sort-fields class-*.php        # also sort field block
 *
 * Declared field order is observable, so fields keep source order unless
 * --sort-fields is given.
 *
 * After --write, run phpcbf on the changed files to normalize the blank lines
 * between methods, then the test suite.
 */

// Node fixed-order prefix; 500 = call-graph middle, 1000 = node_schema (last).
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

// Tokenize with char offsets. Returns list of [id|null, text, offset].
/** @return list<Token> */
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
 * Invariant fingerprint: sorted texts of EVERY member across all processed
 * classes. Reordering is a permutation, so this multiset is unchanged unless a
 * member's own text was corrupted — which aborts the write. Covers the whole
 * rewritten region, not just method bodies.
 *
 * @return list<string>
 */
function member_fingerprint( string $src, bool $all_classes ): array {
	$fp = [];
	foreach ( find_classes( $src, $all_classes ) as $cls ) {
		foreach ( $cls['members'] as $m ) {
			$fp[] = substr( $src, $m['start_fn'], $m['end'] - $m['start_fn'] );
		}
	}
	sort( $fp );
	return $fp;
}

/**
 * Build a non-method member (const / property / trait-use) with the metadata the
 * field-ordering convention sorts on: kind, visibility, static-ness, and name.
 *
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
 * @param list<Token> $toks
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

// Last `\`-delimited segment of a qualified name (`\A\B_Node` → `B_Node`).
function last_ns_segment( string $name ): string {
	$pos = strrpos( $name, '\\' );
	return false === $pos ? $name : substr( $name, $pos + 1 );
}

// @longform Class-name-shaped token: a bare T_STRING or a namespaced-name
// token. Node detection keys on the `_Node` suffix by design — make_node
// contract — so `extends \Newspack_Nodes\Job_Worker_Node` must be seen too.
function is_name_token( ?int $id ): bool {
	return T_STRING === $id || T_NAME_QUALIFIED === $id || T_NAME_FULLY_QUALIFIED === $id || T_NAME_RELATIVE === $id;
}

/**
 * Find classes and their depth-1 members with offsets. In node mode only Node
 * subclasses; with $all_classes, every class (each tagged is_node).
 *
 * @return list<ClassRec>
 */
function find_classes( string $src, bool $all_classes ): array {
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
		if ( ! $is_node && ! $all_classes ) continue;

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
 * A method's SELF-dispatched callees ($this->/$this?->/self::/static::), in
 * first-appearance order; a call on another object ($p->foo()) is not an edge.
 * Detection scans the TOKEN stream over the method's [start_fn, end] range, so a
 * call spelled inside a string/comment/heredoc is never an edge.
 *
 * @param list<Token>        $toks
 * @param list<Member>       $methods
 * @param array<string, int> $names
 * @return callable(int): list<string>
 */
function callees_factory( array $toks, array $methods, array $names ): callable {
	$nt  = count( $toks );
	$adv = function ( int $k ) use ( $toks, $nt ): int {
		while ( $k < $nt && ( $toks[ $k ][0] === T_WHITESPACE || $toks[ $k ][0] === T_COMMENT || $toks[ $k ][0] === T_DOC_COMMENT ) ) $k++;
		return $k;
	};
	/** @return list<string> */
	return function ( int $i ) use ( $toks, $nt, $methods, $names, $adv ) {
		$start = $methods[ $i ]['start_fn'];
		$end   = $methods[ $i ]['end'];
		$first = [];
		for ( $k = 0; $k < $nt; $k++ ) {
			$off = $toks[ $k ][2];
			if ( $off < $start ) continue;
			if ( $off >= $end ) break;
			$id  = $toks[ $k ][0];
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
 * NODE policy: fixed prefix (constructor/arguments/fill/fire*), then a
 * topological order of the call-graph-connected middle methods where every
 * callee sits below ALL its callers (public roots grouped, then the shared
 * chain), then standalone methods in source order, then node_schema.
 *
 * @param list<Token>  $toks
 * @param list<Member> $methods
 * @return list<int>
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

// GENERIC policy: __construct, then public roots deepest-first + their trees.
/**
 * @param list<Token>  $toks
 * @param list<Member> $methods
 * @return list<int>
 */
function order_methods_generic( array $toks, array $methods ): array {
	$names = [];
	foreach ( $methods as $i => $m ) $names[ $m['name'] ] = $i;
	$callees_of = callees_factory( $toks, $methods, $names );
	$depth_of = function ( int $i, array $stack ) use ( &$depth_of, $callees_of, $names ): int {
		if ( isset( $stack[ $i ] ) ) return 0; // cycle back-edge
		$stack[ $i ] = 1;
		$d = 1;
		foreach ( $callees_of( $i ) as $cn ) {
			$j = $names[ $cn ] ?? null;
			if ( $j !== null ) $d = max( $d, 1 + $depth_of( $j, $stack ) );
		}
		return $d;
	};

	$ctor = []; $rest = [];
	foreach ( $methods as $i => $m ) { if ( $m['name'] === '__construct' ) $ctor[] = $i; else $rest[] = $i; }
	$visited = array_flip( $ctor );
	$placed  = [];
	$expand = function ( int $i ) use ( &$expand, $callees_of, $names, &$visited, &$placed ) {
		foreach ( $callees_of( $i ) as $cn ) {
			$j = $names[ $cn ] ?? null;
			if ( $j !== null && ! isset( $visited[ $j ] ) ) { $visited[ $j ] = 1; $placed[] = $j; $expand( $j ); }
		}
	};
	foreach ( $ctor as $i ) $expand( $i ); // constructor's helpers below it

	$public_idx     = array_values( array_filter( $rest, fn( $i ) => $methods[ $i ]['public'] ) );
	$called_by_pub  = [];
	foreach ( $public_idx as $i ) foreach ( $callees_of( $i ) as $cn ) $called_by_pub[ $cn ] = 1;
	$roots = array_values( array_filter(
		$public_idx,
		fn( $i ) => ! isset( $called_by_pub[ $methods[ $i ]['name'] ] ) && count( $callees_of( $i ) ) > 0
	) );
	usort( $roots, function ( $a, $b ) use ( $depth_of ) {
		$d = $depth_of( $b, [] ) <=> $depth_of( $a, [] ); // deepest first
		return $d !== 0 ? $d : ( $a <=> $b );              // tie: source order
	} );
	foreach ( $roots as $i ) if ( ! isset( $visited[ $i ] ) ) { $visited[ $i ] = 1; $placed[] = $i; $expand( $i ); }
	// Remaining publics (private-only reach, recursion), then privates.
	foreach ( $rest as $i ) if ( $methods[ $i ]['public'] && ! isset( $visited[ $i ] ) ) { $visited[ $i ] = 1; $placed[] = $i; $expand( $i ); }
	foreach ( $rest as $i ) if ( ! isset( $visited[ $i ] ) ) { $visited[ $i ] = 1; $placed[] = $i; }
	return array_merge( $ctor, $placed );
}

// --sort-fields kind rank: const (0) → static prop (1) → instance prop (2).
/** @param Member $m */
function field_kind_rank( array $m ): int {
	return 'const' === ( $m['kind'] ?? '' ) ? 0 : ( ! empty( $m['static'] ) ? 1 : 2 );
}

// --sort-fields visibility rank: public (0) → protected (1) → private (2).
/** @param Member $m */
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
 * @param  Member[]   $slice     All members of the class, in source order.
 * @param  list<int>  $field_pos Indices into $slice of the non-method members.
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

/** @return array{0: string, 1: list<string>} */
function reorder( string $src, bool $all_classes, bool $sort_fields = false ): array {
	$classes = find_classes( $src, $all_classes );
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

		// @longform Reorder the WHOLE class body: the field block (every
		// const/prop/use) is hoisted above the methods, then the methods in
		// call-graph order. Declared field order is OBSERVABLE
		// (get_object_vars, foreach, (array) cast, var_dump, JSON), so
		// fields keep source order unless --sort-fields opts into the
		// convention sort.
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
$all_classes = in_array( '--all-classes', $argv_rest, true );
$sort_fields = in_array( '--sort-fields', $argv_rest, true );
$files       = array_values( array_filter( $argv_rest, fn( $a ) => ! str_starts_with( $a, '--' ) ) );
if ( ! $files ) { fwrite( STDERR, "usage: php reorder-node-methods.php [--check|--write] [--all-classes] [--sort-fields] <file.php> [...]\n" ); exit( 1 ); }
$failed = false;
foreach ( $files as $f ) {
	$src = file_get_contents( $f );
	if ( false === $src ) { fwrite( STDERR, "✗ $f: cannot read\n" ); $failed = true; continue; }
	$before = member_fingerprint( $src, $all_classes );
	[ $out, $notes ] = reorder( $src, $all_classes, $sort_fields );
	if ( $out === $src ) continue;
	// Invariants: member texts unchanged, whole-file byte multiset unchanged.
	if ( $before !== member_fingerprint( $out, $all_classes ) || count_chars( $src, 1 ) !== count_chars( $out, 1 ) ) {
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
