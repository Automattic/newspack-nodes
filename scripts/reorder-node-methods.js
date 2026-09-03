#!/usr/bin/env node
/**
 * reorder-node-methods.js — newspaper-order the methods of a JS class.
 *
 * Reorders each class body so methods read top-down like a newspaper: an
 * entrypoint, then the functions it calls, then the functions those call — the
 * stack deepening as you go down. Method bodies are NEVER edited; they move as
 * raw text spans (each method's leading docblock + blank line travels with it),
 * guarded by two hard invariants checked before any write: the multiset of
 * member texts is unchanged (no body edited) AND the whole-file char histogram is
 * unchanged (no byte lost, duplicated, or added). Either mismatch aborts the file
 * untouched. Residual observable changes NOT guarded: a comment may re-associate
 * to a different member, and reflection-order of the prototype's own keys shifts.
 *
 * A class field interleaved among the methods is hoisted to the top of the
 * region and keeps source order: declared field order is observable, so
 * nothing sorts it. The PHP twin's --sort-fields has no counterpart here.
 *
 * Two ordering policies:
 *
 *   NODE (default) — for a class named `Node` / `*Node`, or extending one:
 *     constructor, arguments (get/set), fill, fire_cb, fire,
 *       <a topological order of the middle units the call graph connects,
 *        then the unconnected ones in source order>,
 *     node_schema
 *
 *   GENERIC (every other class) — constructor first, then a topological order
 *     of the call graph: a unit is emitted only once EVERY caller of it
 *     already is, so no caller ever prints below something it calls. Among
 *     the units free at the same moment, the ones a just-emitted caller
 *     released come first, then public callers, then source order.
 *
 * Both policies break a tie by source order, and a cycle falls back to source
 * order rather than stalling.
 *
 * Given no flag, the tool only prints the order it would write. `--check` turns
 * a would-change file into exit 1, which is how lint-staged gates a commit;
 * `--write` applies the order. A file that fails to parse or trips an invariant
 * exits 1 under every flag. Test paths are skipped throughout.
 *
 * After --write, run `eslint --fix` on the changed files to normalize the blank
 * lines between methods, then the test suite. Sibling tool: the PHP twin
 * reorder-node-methods.php; `scripts/test-reorder-node-methods.sh` runs both.
 */

const fs = require( 'fs' );
const path = require( 'path' );
const { createRequire } = require( 'module' );

/** Everything after the script name: the flags below plus the paths. */
const argv = process.argv.slice( 2 );
/** Apply the new order in place; without it the run only reports. */
const write = argv.includes( '--write' );
/** Dry run that FAILS when a file is out of order, for the commit hook. */
const check = argv.includes( '--check' );
/** Every non-flag argument, each taken as a path to reorder. */
const files = argv.filter( ( a ) => ! a.startsWith( '--' ) );
if ( ! files.length ) {
	console.error(
		'usage: node reorder-node-methods.js [--check|--write] <file.js> [...]'
	);
	process.exit( 1 );
}

/**
 * Resolve from the plugin this copy lives in, so a vendored copy uses that
 * plugin's dependencies rather than reaching back into the substrate. The
 * filename is a placeholder — `createRequire` needs only a path to resolve
 * FROM, and nothing reads that file.
 */
const requireFromPlugin = createRequire(
	path.join( __dirname, '..', 'node_modules', '__reorder_node_methods__.js' )
);
let parser;
try {
	parser = requireFromPlugin( '@babel/parser' );
} catch ( e ) {
	// A raw MODULE_NOT_FOUND here means npm install has not been run.
	console.error(
		'reorder-node-methods: cannot load @babel/parser — resolved from ../node_modules relative to this script. Run npm install in this plugin first.'
	);
	process.exit( 1 );
}

/**
 * Parse one source file into a babel AST.
 *
 * The plugin list covers what the dashboards and the runtime write: JSX, class
 * fields, and private members. Syntax outside it raises, and the caller reports
 * the parse error rather than rewriting a file it cannot see whole.
 *
 * @param {string} src File contents.
 * @return {Object} The babel File node.
 */
function parse( src ) {
	return parser.parse( src, {
		sourceType: 'module',
		plugins: [
			'jsx',
			'classProperties',
			'classPrivateProperties',
			'classPrivateMethods',
		],
	} );
}

/**
 * Whether NODE policy applies: the class is named `Node` or `*Node`, or it
 * extends one.
 *
 * A base class qualifies on its own name. NODE policy orders it correctly —
 * the fixed prefix is exactly the base's own shape — so excluding it and
 * falling back to GENERIC would buy nothing. A superclass reached through a
 * member expression (`x.Node`) carries no `name` and does not match.
 *
 * @param {Object} cls A ClassDeclaration node.
 * @return {boolean} True when the class takes NODE ordering.
 */
function isNodeClass( cls ) {
	const names = [ cls.id?.name, cls.superClass?.name ];
	return names.some( ( n ) => !! n && ( n === 'Node' || /Node$/.test( n ) ) );
}

/**
 * Visit every top-level class, tagged with the policy that applies to it.
 *
 * Only a `class` statement at program scope counts, bare or exported. A class
 * nested inside a function or assigned to a variable (`const X = class {}`) is
 * left alone.
 *
 * @param {Object}   ast The parsed program.
 * @param {Function} cb  Called `( classNode, isNode )` for each class.
 */
function walkClasses( ast, cb ) {
	for ( const node of ast.program.body ) {
		let cls = null;
		if ( node.type === 'ClassDeclaration' ) {
			cls = node;
		} else if (
			( node.type === 'ExportNamedDeclaration' ||
				node.type === 'ExportDefaultDeclaration' ) &&
			node.declaration?.type === 'ClassDeclaration'
		) {
			cls = node.declaration;
		}
		if ( ! cls ) {
			continue;
		}
		const isNode = isNodeClass( cls );
		{
			cb( cls, isNode );
		}
	}
}

/**
 * The static name of a class member.
 *
 * `key.id.name` is the private-name form, so `#foo` resolves to `foo`. A
 * computed key resolves to neither, which is why reorderClass refuses a class
 * carrying one outright.
 *
 * @param {Object} m A class member node.
 * @return {string|undefined} The name, or undefined when the key has none.
 */
const mname = ( m ) => m.key && ( m.key.name ?? ( m.key.id && m.key.id.name ) );
/**
 * Whether the unit is the constructor.
 *
 * @param {Object} u A method unit.
 * @return {boolean} True for the constructor.
 */
const isConstructor = ( u ) => u.members[ 0 ].kind === 'constructor';
/**
 * Whether the unit belongs to the class's public surface — neither the
 * constructor nor an `_`-prefixed name. GENERIC ordering floats these above
 * private helpers within one wave, so a chain reads from its entrypoint down.
 *
 * @param {Object} u A method unit.
 * @return {boolean} True when the unit is public.
 */
const isPublic = ( u ) =>
	! isConstructor( u ) &&
	typeof u.name === 'string' &&
	! u.name.startsWith( '_' );

/**
 * Position in the NODE fixed prefix, or null for a call-graph middle unit.
 *
 * The prefix is the shape every Node subclass shares — construct, configure,
 * receive, fire — so it is pinned by name rather than discovered from the call
 * graph. `arguments` counts only as an accessor, the form the runtime declares
 * it in, and `fill` only as an instance method, since a static `fill` is a
 * different thing. `fireCb` and `fire_cb` are the JS and PHP-parity spellings
 * of one method.
 *
 * @param {Object} m A class member node.
 * @return {?number} Rank 0 through 4, or null.
 */
function topRank( m ) {
	if ( m.kind === 'constructor' ) {
		return 0;
	}
	const n = mname( m );
	if ( ( m.kind === 'get' || m.kind === 'set' ) && n === 'arguments' ) {
		return 1;
	}
	if ( ! m.static && n === 'fill' ) {
		return 2;
	}
	if ( n === 'fireCb' || n === 'fire_cb' ) {
		return 3;
	}
	if ( n === 'fire' ) {
		return 4;
	}
	return null;
}

/**
 * Whether the member is pinned to the BOTTOM of a Node class: `nodeSchema` in
 * the JS spelling, `node_schema` in the PHP-parity one.
 *
 * @param {Object} m A class member node.
 * @return {boolean} True when the member sorts last.
 */
const isLast = ( m ) => {
	const n = mname( m );
	return n === 'nodeSchema' || n === 'node_schema';
};

/**
 * The method name a callee expression dispatches on THIS.
 *
 * Only `this.foo()`, `this?.foo()`, `this.#foo()` and `this['foo']()` count. A
 * call on another object is not an edge: `p.foo()` says nothing about where
 * this class's own `foo` belongs, and reading it as an edge invents cycles that
 * stall the topological sort. A computed key that is not a string literal
 * cannot be resolved, so it yields null rather than a guess.
 *
 * @param {Object} callee The callee of a call expression.
 * @return {?string} The self-dispatched method name.
 */
function thisCallName( callee ) {
	if (
		! callee ||
		( callee.type !== 'MemberExpression' &&
			callee.type !== 'OptionalMemberExpression' )
	) {
		return null;
	}
	if ( ! callee.object || callee.object.type !== 'ThisExpression' ) {
		return null;
	}
	const p = callee.property;
	if ( callee.computed ) {
		return p.type === 'StringLiteral' ? p.value : null;
	}
	if ( p.type === 'Identifier' ) {
		return p.name;
	}
	if ( p.type === 'PrivateName' ) {
		return p.id.name;
	}
	return null;
}

/**
 * Collect self-dispatched calls under an AST node, in source-position order.
 *
 * Reading the AST rather than the text is what keeps strings, comments and
 * template literals from forging a call edge. A nested function body is a scope
 * of its own: the call runs later, under whoever invokes it, so blaming the
 * enclosing method invents an edge. The walk descends anyway and marks those
 * hits soft — soft hits gate nothing, and only nudge the tie-break toward
 * keeping related methods together.
 *
 * @param {Object}  node   Any AST node.
 * @param {Array}   hits   Accumulator of `{name, pos, soft}`, appended in place.
 * @param {boolean} [soft] True once the walk is inside a nested function.
 */
function collectThisCalls( node, hits, soft = false ) {
	if ( ! node || typeof node.type !== 'string' ) {
		return;
	}
	const nested =
		node.type === 'FunctionExpression' ||
		node.type === 'ArrowFunctionExpression' ||
		node.type === 'FunctionDeclaration';
	if (
		node.type === 'CallExpression' ||
		node.type === 'OptionalCallExpression'
	) {
		const nm = thisCallName( node.callee );
		if ( nm ) {
			hits.push( { name: nm, pos: node.start, soft } );
		}
	}
	for ( const k in node ) {
		if (
			'leadingComments' === k ||
			'trailingComments' === k ||
			'innerComments' === k ||
			'loc' === k
		) {
			continue;
		}
		const v = node[ k ];
		if ( Array.isArray( v ) ) {
			v.forEach( ( c ) => collectThisCalls( c, hits, soft || nested ) );
		} else if ( v && typeof v.type === 'string' ) {
			collectThisCalls( v, hits, soft || nested );
		}
	}
}

/**
 * Invariant fingerprint: sorted texts of EVERY member (methods and fields)
 * across all processed classes.
 *
 * Reordering is a permutation, so this multiset is unchanged unless a member's
 * own text was corrupted — which aborts the write.
 *
 * @param {string} src The file contents the AST was parsed from.
 * @param {Object} ast The parsed program.
 * @return {string[]} Every member's text, sorted.
 */
function memberTexts( src, ast ) {
	const out = [];
	walkClasses( ast, ( cls ) => {
		for ( const m of cls.body.body ) {
			out.push( src.slice( m.start, m.end ) );
		}
	} );
	return out.sort();
}

/**
 * Compute the reordered text of one class body.
 *
 * Nothing is written here. The caller splices `newText` over
 * `[regionStart, regionEnd)`, which spans the first method through the last, so
 * anything declared above the first method stays where it is. A get/set pair
 * sharing a name moves as ONE unit, keeping an accessor beside its counterpart.
 *
 * @param {string}  src    The file contents `cls` was parsed from.
 * @param {Object}  cls    The ClassDeclaration to reorder.
 * @param {boolean} isNode True for NODE policy, false for GENERIC.
 * @return {?Object} Null when the class declares no methods; `{skip, note}`
 *                   when it is refused; otherwise `{regionStart, regionEnd,
 *                   changed}`, carrying `newText` and `order` when changed.
 */
function reorderClass( src, cls, isNode ) {
	const members = cls.body.body;

	// @longform Refuse classes where reordering could change semantics: a
	// computed key ([expr]) evaluates in element order (a fields-first
	// hoist would move it), and two members sharing a name are last-wins
	// (the call graph could reverse them). A get/set pair is NOT a dup.
	for ( const m of members ) {
		if ( m.computed ) {
			return {
				skip: true,
				note: `class ${ cls.id?.name }: skipped (computed key)`,
			};
		}
	}
	const byStaticName = new Map();
	for ( const m of members ) {
		const n = mname( m );
		if ( ! n ) {
			continue;
		}
		( byStaticName.get( n ) || byStaticName.set( n, [] ).get( n ) ).push(
			m
		);
	}
	for ( const [ n, group ] of byStaticName ) {
		if ( group.length < 2 ) {
			continue;
		}
		const kinds = new Set( group.map( ( m ) => m.kind ) );
		const accessorPair =
			2 === group.length && kinds.has( 'get' ) && kinds.has( 'set' );
		if ( ! accessorPair ) {
			return {
				skip: true,
				note: `class ${ cls.id?.name }: skipped (duplicate member '${ n }')`,
			};
		}
	}

	const isMethod = ( m ) => /Method/.test( m.type );
	const firstMethodIdx = members.findIndex( isMethod );
	const lastMethodIdx =
		members.length - 1 - [ ...members ].reverse().findIndex( isMethod );
	if ( firstMethodIdx < 0 ) {
		return null;
	}

	// @longform The region spans the first method through the last. A
	// class field interleaved among the methods is HOISTED to the top of
	// the region, NOT skipped: moving a field past methods is order-
	// independent, and skipping the class leaves it silently un-ordered.
	const slice = members.slice( firstMethodIdx, lastMethodIdx + 1 );
	const regionStart =
		firstMethodIdx === 0
			? cls.body.start + 1
			: members[ firstMethodIdx - 1 ].end;
	// A same-line trailing comment belongs to that member — extend past it.
	const memberEnd = ( m ) => {
		const tc = m.trailingComments && m.trailingComments[ 0 ];
		return tc && ! src.slice( m.end, tc.start ).includes( '\n' )
			? tc.end
			: m.end;
	};
	const regionEnd = memberEnd( slice[ slice.length - 1 ] );
	// Chunk per member — [prevEnd, thisEnd], so the docblock travels with it.
	const chunk = slice.map( ( m, i ) =>
		src.slice(
			i === 0 ? regionStart : memberEnd( slice[ i - 1 ] ),
			memberEnd( m )
		)
	);
	const fieldText = slice
		.map( ( m, i ) => [ m, i ] )
		.filter( ( [ mm ] ) => ! isMethod( mm ) )
		.map( ( [ , i ] ) => chunk[ i ] );
	const methodEntries = slice
		.map( ( m, i ) => ( { m, i } ) )
		.filter( ( e ) => isMethod( e.m ) );
	const methods = methodEntries.map( ( e ) => e.m );
	const methodChunk = methodEntries.map( ( e ) => chunk[ e.i ] );

	// Group adjacent get/set of the same name into one unit (kept together).
	const units = [];
	for ( let i = 0; i < methods.length; i++ ) {
		const m = methods[ i ];
		const nm = mname( m );
		const prev = units[ units.length - 1 ];
		if (
			prev &&
			prev.kindPair &&
			prev.name === nm &&
			( m.kind === 'get' || m.kind === 'set' )
		) {
			prev.members.push( m );
			prev.text += methodChunk[ i ];
			continue;
		}
		units.push( {
			name: nm,
			members: [ m ],
			text: methodChunk[ i ],
			kindPair: m.kind === 'get' || m.kind === 'set',
		} );
	}

	// Call graph: SELF-dispatched callees only; `p.foo()` is not an edge.
	const allNames = new Set( methods.map( mname ).filter( Boolean ) );
	const byName = {};
	units.forEach( ( u ) =>
		u.members.forEach( ( m ) => {
			const n = mname( m );
			if ( n ) {
				byName[ n ] = u;
			}
		} )
	);
	/**
	 * The units this one calls, by name, in first-call order and deduped.
	 *
	 * Only names this class declares, and never one of the unit's own: a unit
	 * calling itself is not an edge, and a get/set pair calling its twin would
	 * otherwise depend on the unit it already travels with.
	 *
	 * @param {Object}  u          The calling unit.
	 * @param {boolean} [wantSoft] True to take the closure-body calls instead
	 *                             of the direct ones.
	 * @return {string[]} Callee names.
	 */
	const calleesOf = ( u, wantSoft = false ) => {
		const self = new Set( u.members.map( mname ).filter( Boolean ) );
		const hits = [];
		u.members.forEach( ( m ) => collectThisCalls( m, hits ) );
		hits.sort( ( a, b ) => a.pos - b.pos );
		const seen = new Set();
		const out = [];
		for ( const h of hits ) {
			if (
				!! h.soft !== wantSoft ||
				! allNames.has( h.name ) ||
				self.has( h.name ) ||
				seen.has( h.name )
			) {
				continue;
			}
			seen.add( h.name );
			out.push( h.name );
		}
		return out;
	};

	let ordered;
	if ( isNode ) {
		// @longform NODE: fixed prefix, then a topological order of the
		// call-graph-connected middle units where every callee sits below
		// ALL its callers (public roots grouped, then the shared chain),
		// then standalones in source order, then nodeSchema.
		for ( const u of units ) {
			u.topRank = topRank( u.members[ 0 ] );
			if ( u.topRank !== null ) {
				u.role = 'top';
			} else if ( isLast( u.members[ 0 ] ) ) {
				u.role = 'last';
			} else {
				u.role = 'middle';
			}
		}
		const top = units
			.filter( ( u ) => u.role === 'top' )
			.sort( ( a, b ) => a.topRank - b.topRank );
		const last = units.filter( ( u ) => u.role === 'last' );
		const middle = units.filter( ( u ) => u.role === 'middle' );
		const middleSet = new Set( middle );
		const srcIdx = new Map( units.map( ( u, i ) => [ u, i ] ) );

		// Prefix entrypoints are pre-placed, but still pull middle helpers in.
		const calleeUnits = new Map();
		const indeg = new Map( middle.map( ( u ) => [ u, 0 ] ) );
		const calledByTop = new Set();
		for ( const u of [ ...top, ...middle ] ) {
			const cs = [];
			for ( const cn of calleesOf( u ) ) {
				const cu = byName[ cn ];
				if ( ! cu || ! middleSet.has( cu ) ) {
					continue;
				}
				cs.push( cu );
				if ( middleSet.has( u ) ) {
					indeg.set( cu, indeg.get( cu ) + 1 );
				} else {
					calledByTop.add( cu );
				}
			}
			calleeUnits.set( u, cs );
		}
		const connected = new Set(
			middle.filter(
				( u ) =>
					calleeUnits.get( u ).length > 0 ||
					indeg.get( u ) > 0 ||
					calledByTop.has( u )
			)
		);

		// Kahn topological emit (source-order tie-break); cycle → source order.
		const placed = [];
		const visited = new Set();
		const remaining = middle.filter( ( u ) => connected.has( u ) );
		for (;;) {
			const avail = remaining
				.filter( ( u ) => ! visited.has( u ) && indeg.get( u ) === 0 )
				.sort( ( a, b ) => srcIdx.get( a ) - srcIdx.get( b ) );
			if ( ! avail.length ) {
				break;
			}
			const u = avail[ 0 ];
			visited.add( u );
			placed.push( u );
			for ( const cu of calleeUnits.get( u ) ) {
				if ( indeg.has( cu ) ) {
					indeg.set( cu, indeg.get( cu ) - 1 );
				}
			}
		}
		for ( const u of remaining ) {
			if ( ! visited.has( u ) ) {
				visited.add( u );
				placed.push( u );
			}
		}
		const standalone = middle.filter( ( u ) => ! connected.has( u ) );
		ordered = [ ...top, ...placed, ...standalone, ...last ];
	} else {
		// @longform GENERIC: constructor, then a topological order of the call
		// graph — a unit is emitted only once EVERY caller of it already is,
		// so no caller ever prints below something it calls.
		const ctor = units.filter( isConstructor );
		const rest = units.filter( ( u ) => ! ctor.includes( u ) );
		const restSet = new Set( rest );
		// Pre-placed ctor gates nothing; its callees can still sink below.
		const indeg = new Map( rest.map( ( u ) => [ u, 0 ] ) );
		const calleeUnits = new Map();
		for ( const u of units ) {
			const cs = [];
			for ( const cn of calleesOf( u ) ) {
				const cu = byName[ cn ];
				if ( ! cu || ! restSet.has( cu ) ) {
					continue;
				}
				cs.push( cu );
				if ( restSet.has( u ) ) {
					indeg.set( cu, indeg.get( cu ) + 1 );
				}
			}
			calleeUnits.set( u, cs );
		}
		const srcIdx = ( u ) => units.indexOf( u );
		// Public callers lead each wave, so their own chain reads top-down.
		const rank = ( u ) => {
			if ( ! isPublic( u ) ) {
				return 2;
			}
			return calleeUnits.get( u ).length ? 0 : 1;
		};
		// @longform Freed order is the primary tie-break, most recent first:
		// emitting a caller pulls in the callees it just released, so a chain
		// stays together instead of yielding to an unrelated root that merely
		// sorts earlier. Roots free from the start share 0 and fall to rank.
		const placed = [];
		const visited = new Set();
		const freed = new Map( rest.map( ( u ) => [ u, 0 ] ) );
		let tick = 0;
		for (;;) {
			const avail = rest
				.filter( ( u ) => ! visited.has( u ) && indeg.get( u ) === 0 )
				.sort(
					( a, b ) =>
						freed.get( b ) - freed.get( a ) ||
						rank( a ) - rank( b ) ||
						srcIdx( a ) - srcIdx( b )
				);
			if ( ! avail.length ) {
				break;
			}
			const u = avail[ 0 ];
			visited.add( u );
			placed.push( u );
			for ( const cu of calleeUnits.get( u ) ) {
				indeg.set( cu, indeg.get( cu ) - 1 );
				if ( indeg.get( cu ) === 0 ) {
					freed.set( cu, ++tick );
				}
			}
			// Closure-body calls gate nothing, but say these belong together.
			for ( const cn of calleesOf( u, true ) ) {
				const cu = byName[ cn ];
				if ( cu && ! visited.has( cu ) && indeg.get( cu ) === 0 ) {
					freed.set( cu, ++tick );
				}
			}
		}
		for ( const u of rest ) {
			if ( ! visited.has( u ) ) {
				visited.add( u );
				placed.push( u ); // cycle
			}
		}
		ordered = [ ...ctor, ...placed ];
	}

	const methodsUnchanged =
		ordered.length === units.length &&
		ordered.every( ( u, i ) => u === units[ i ] );
	if ( fieldText.length === 0 && methodsUnchanged ) {
		return { regionStart, regionEnd, changed: false };
	}
	return {
		regionStart,
		regionEnd,
		changed: true,
		newText:
			fieldText.join( '' ) + ordered.map( ( u ) => u.text ).join( '' ),
		order: ordered.map( ( u ) => u.members.map( mname ).join( '/' ) ),
	};
}

/**
 * Whether the path is test code, which is left alone.
 *
 * Test methods have no call graph worth ordering, and a double deliberately
 * mirrors the order of what it doubles. The commit gate runs on every staged
 * file, so tests reach this tool unless excluded here.
 *
 * @param {string} file A path, in either separator style.
 * @return {boolean} True when the file is skipped.
 */
function isTestPath( file ) {
	const norm = file.split( path.sep ).join( '/' );
	return (
		norm.includes( '/tests/' ) ||
		norm.includes( '/__tests__/' ) ||
		norm.startsWith( 'tests/' ) ||
		/\.test\.[cm]?jsx?$/.test( norm )
	);
}

/**
 * Reorder every class in one file, check the invariants, and optionally write.
 *
 * Classes are spliced right-to-left so an earlier class's offsets survive a
 * later class's splice. A file whose classes all come back unchanged is never
 * re-parsed and never written, so the invariants cost nothing on a clean run.
 *
 * @param {string}  file    Path to reorder.
 * @param {boolean} doWrite True to write the result back.
 * @return {Object} `{file, changed, notes}`, or `{file, err}` when the file
 *                  failed to parse or an invariant did not hold.
 */
function reorderFile( file, doWrite ) {
	if ( isTestPath( file ) ) {
		return { file, changed: false, notes: [] };
	}
	const src = fs.readFileSync( file, 'utf8' );
	let ast;
	try {
		ast = parse( src );
	} catch ( e ) {
		return { file, err: 'PARSE ' + e.message };
	}
	// The fingerprint has to predate every mutation, so it cannot move down.
	// eslint-disable-next-line @wordpress/no-unused-vars-before-return
	const before = memberTexts( src, ast );
	const classes = [];
	walkClasses( ast, ( c, isNode ) => classes.push( { cls: c, isNode } ) );
	let out = src;
	const notes = [];
	// Right-to-left so earlier classes' offsets stay valid after a splice.
	for ( const { cls, isNode } of classes.reverse() ) {
		const r = reorderClass( out, cls, isNode );
		if ( ! r ) {
			continue;
		}
		if ( r.skip ) {
			notes.push( r.note );
			continue;
		}
		if ( ! r.changed ) {
			continue;
		}
		out =
			out.slice( 0, r.regionStart ) +
			r.newText +
			out.slice( r.regionEnd );
		notes.push( `class ${ cls.id?.name }: [${ r.order.join( ', ' ) }]` );
	}
	if ( out === src ) {
		return { file, notes, changed: false };
	}
	let ast2;
	try {
		ast2 = parse( out );
	} catch ( e ) {
		return { file, err: 'POST-PARSE ' + e.message };
	}
	const after = memberTexts( out, ast2 );
	if (
		before.length !== after.length ||
		before.some( ( t, i ) => t !== after[ i ] )
	) {
		return {
			file,
			err: 'INVARIANT VIOLATION — member text changed; aborted',
		};
	}
	if ( ! histogramsEqual( src, out ) ) {
		return {
			file,
			err: 'INVARIANT VIOLATION — byte histogram changed; aborted',
		};
	}
	if ( doWrite ) {
		atomicWrite( file, out );
	}
	return { file, notes, changed: true };
}

/**
 * Char-frequency multiset equality.
 *
 * A permutation of chunks conserves it, so a pass that loses, duplicates or
 * adds a byte is caught even when every member text still matches — that damage
 * lands in the whitespace and comments BETWEEN members, which the member
 * fingerprint never sees.
 *
 * @param {string} a The source before reordering.
 * @param {string} b The source after.
 * @return {boolean} True when both hold exactly the same characters.
 */
function histogramsEqual( a, b ) {
	if ( a.length !== b.length ) {
		return false;
	}
	const counts = new Map();
	for ( let i = 0; i < a.length; i++ ) {
		counts.set(
			a.charCodeAt( i ),
			( counts.get( a.charCodeAt( i ) ) || 0 ) + 1
		);
	}
	for ( let i = 0; i < b.length; i++ ) {
		const c = b.charCodeAt( i );
		const n = counts.get( c );
		if ( ! n ) {
			return false;
		}
		counts.set( c, n - 1 );
	}
	for ( const n of counts.values() ) {
		if ( 0 !== n ) {
			return false;
		}
	}
	return true;
}

/**
 * Write via a same-directory temp file and a rename, so a reader never sees a
 * partial file. Same directory because a rename is atomic only within one
 * filesystem; the temp file is created under the umask, so the original's mode
 * is copied onto it before the rename.
 *
 * @param {string} file Path to replace.
 * @param {string} out  The new contents.
 */
function atomicWrite( file, out ) {
	const tmp = path.join(
		path.dirname( file ),
		`.${ path.basename( file ) }.reorder-${ process.pid }.tmp`
	);
	fs.writeFileSync( tmp, out );
	fs.chmodSync( tmp, fs.statSync( file ).mode );
	fs.renameSync( tmp, file );
}

for ( const f of files ) {
	const r = reorderFile( f, write );
	if ( r.err ) {
		console.log( `✗ ${ f }: ${ r.err }` );
		process.exitCode = 1;
	} else if ( r.changed ) {
		console.log(
			`~ ${ f }${ '\n    ' + ( r.notes || [] ).join( '\n    ' ) }`
		);
		if ( check ) {
			process.exitCode = 1;
		}
	} else if ( r.notes && r.notes.length ) {
		console.log( `! ${ f }${ '\n    ' + r.notes.join( '\n    ' ) }` );
	}
	// Silence is the clean result: only changes and notes print.
}
