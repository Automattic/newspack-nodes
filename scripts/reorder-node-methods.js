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
 * Two ordering policies:
 *
 *   NODE (default) — for Node subclasses (superclass `Node` or `*Node`):
 *     constructor, arguments (get/set), fill, fire_cb, fire,
 *       <call-graph DFS seeded from the entrypoints fill/fire_cb/fire>,
 *     node_schema
 *
 *   GENERIC (every other class) — constructor first, then a topological order
 *     of the call graph: a unit is emitted only once EVERY caller of it
 *     already is, so no caller ever prints below something it calls. Public
 *     units that call something lead each wave; a cycle falls to source order.
 *
 *
 * After --write, run `eslint --fix` on the changed files to normalize the blank
 * lines between methods, then the test suite. Sibling tool: the PHP twin
 * reorder-node-methods.php.
 */

const fs = require( 'fs' );
const path = require( 'path' );
const { createRequire } = require( 'module' );

const argv = process.argv.slice( 2 );
const write = argv.includes( '--write' );
// --check: dry-run that FAILS when a file is out of order, for the hook.
const check = argv.includes( '--check' );
const files = argv.filter( ( a ) => ! a.startsWith( '--' ) );
if ( ! files.length ) {
	console.error(
		'usage: node reorder-node-methods.js [--check|--write] <file.js> [...]'
	);
	process.exit( 1 );
}

/**
 * Resolve from the plugin this copy lives in, so a vendored copy uses that
 * plugin's dependencies rather than reaching back into the substrate.
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
 * Node-orderable if the class IS a node base (name 'Node' / '*Node') or extends
 * one. Node policy orders the base class correctly (fill/fire prefix +
 * call-graph), so unlike generic policy it needn't be excluded.
 */
function isNodeClass( cls ) {
	const names = [ cls.id?.name, cls.superClass?.name ];
	return names.some( ( n ) => !! n && ( n === 'Node' || /Node$/.test( n ) ) );
}

// Every top-level class, each tagged isNode so the policy can be picked.
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

const mname = ( m ) => m.key && ( m.key.name ?? ( m.key.id && m.key.id.name ) );
const isConstructor = ( u ) => u.members[ 0 ].kind === 'constructor';
const isPublic = ( u ) =>
	! isConstructor( u ) &&
	typeof u.name === 'string' &&
	! u.name.startsWith( '_' );

// Node fixed-order prefix; null = call-graph middle.
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

const isLast = ( m ) => {
	const n = mname( m );
	return n === 'nodeSchema' || n === 'node_schema';
};

// Resolve `this.foo` / `this.#foo` / `this['foo']` callees; else null.
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
 * AST-based so strings / comments / template literals never forge a call edge.
 */
// @longform A nested function body is a scope of its own: the call runs later,
// under whoever invokes it, so blaming the enclosing method invents an
// edge. Descend anyway, marking those hits soft — they gate nothing and
// only nudge the tie-break toward keeping related methods together.
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
 * across all processed classes. Reordering is a permutation, so this multiset is
 * unchanged unless a member's own text was corrupted — which aborts the write.
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
	// independent, and the old skip left such classes silently un-ordered.
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
	// wantSoft picks the closure-body calls instead of the direct ones.
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

// @longform Test code is left alone. Its methods have no call graph worth
// ordering, and a double deliberately mirrors the order of what it doubles. The
// gate runs on every staged file, so tests reach it unless excluded here.
function isTestPath( file ) {
	const norm = file.split( path.sep ).join( '/' );
	return (
		norm.includes( '/tests/' ) ||
		norm.includes( '/__tests__/' ) ||
		norm.startsWith( 'tests/' ) ||
		/\.test\.[cm]?jsx?$/.test( norm )
	);
}

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
 * Char-frequency multiset equality — a permutation of chunks conserves it, so a
 * pass that loses / duplicates / adds a byte is caught even if member texts match.
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
 * Write via a same-dir temp file + rename so a reader never sees a partial file;
 * preserve the original mode (rename would install the umask default).
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
	// else console.log( `✓ ${ f }` );
}
