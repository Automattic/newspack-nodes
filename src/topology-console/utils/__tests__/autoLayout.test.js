/**
 * Tests for autoLayout — column layout, barycenter ordering, snap, conflict.
 */

import {
	autoLayout,
	placeBelow,
	snapToGrid,
	X_PAD,
	X_STEP,
	Y_PAD,
	Y_STEP,
	NODE_W,
	NODE_H,
} from '../autoLayout';

describe( 'placeBelow — new-node tuck', () => {
	it( 'returns the origin cell for an empty map', () => {
		expect( placeBelow( {} ) ).toEqual( { x: X_PAD, y: Y_PAD } );
	} );
	it( 'drops one row below a single node', () => {
		expect( placeBelow( { a: { x: 60, y: 80 } } ) ).toEqual( {
			x: 60,
			y: 80 + Y_STEP,
		} );
	} );
	it( 'uses the left-most column, then its bottom-most node', () => {
		const positions = {
			a: { x: X_PAD, y: Y_PAD },
			b: { x: X_PAD, y: Y_PAD + Y_STEP },
			c: { x: X_PAD + X_STEP, y: Y_PAD },
		};
		expect( placeBelow( positions ) ).toEqual( {
			x: X_PAD,
			y: Y_PAD + 2 * Y_STEP,
		} );
	} );
	it( 'ignores a deeper column even when it sits lower', () => {
		const positions = {
			a: { x: X_PAD, y: Y_PAD },
			deep: { x: X_PAD + 3 * X_STEP, y: Y_PAD + 9 * Y_STEP },
		};
		expect( placeBelow( positions ) ).toEqual( {
			x: X_PAD,
			y: Y_PAD + Y_STEP,
		} );
	} );
} );

describe( 'autoLayout — no overlapping nodes', () => {
	// Smallest vertical gap between any two nodes sharing a column (same x);
	// Infinity if no column has 2+ nodes. Below NODE_H means their cards overlap.
	// Half-row midpoint snapping used to leave near-collisions (rows 1.0 and 1.5)
	// that the exact-match deconflict missed.
	function minColumnGap( nodes ) {
		const byCol = {};
		for ( const n of nodes ) {
			if ( ! byCol[ n.position.x ] ) {
				byCol[ n.position.x ] = [];
			}
			byCol[ n.position.x ].push( n.position.y );
		}
		let min = Infinity;
		for ( const ys of Object.values( byCol ) ) {
			ys.sort( ( p, q ) => p - q );
			for ( let i = 1; i < ys.length; i++ ) {
				min = Math.min( min, ys[ i ] - ys[ i - 1 ] );
			}
		}
		return min;
	}

	it( 'spreads same-column producers that share a target so they do not overlap', () => {
		// `a` fans out to t1+t2 (snaps to the 0.5 midpoint); `b` targets only t2
		// (row 1). Both are column-0 producers — 0.5 vs 1.0 is a 55px overlap.
		const { nodes } = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 't1' }, { id: 't2' } ],
			edges: [
				{ from: 'a', to: 't1' },
				{ from: 'a', to: 't2' },
				{ from: 'b', to: 't2' },
			],
		} );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'keeps a lone midpoint producer at its half-row (no spurious spreading)', () => {
		// `a` fans out to t1 (row 0) + t2 (row 1), so it snaps to the 0.5 midpoint
		// and is alone in its column — de-overlap must leave that half-row intact.
		const { nodes } = autoLayout( {
			nodes: [ { id: 'a' }, { id: 't1' }, { id: 't2' } ],
			edges: [
				{ from: 'a', to: 't1' },
				{ from: 'a', to: 't2' },
			],
		} );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		const a = nodes.find( ( n ) => n.id === 'a' );
		expect( a.position.y ).toBe( Y_PAD + 0.5 * Y_STEP );
	} );
} );

describe( 'autoLayout — fan centering (both directions)', () => {
	it( 'centers a fan-in sink between its sources, with the sources kept spread', () => {
		// s1 + s2 → sink. The sink should sit at the vertical midpoint of its two
		// sources (mirror of the fan-out target-snap), not floored to the top one.
		const { nodes } = autoLayout( {
			nodes: [ { id: 's1' }, { id: 's2' }, { id: 'sink' } ],
			edges: [
				{ from: 's1', to: 'sink' },
				{ from: 's2', to: 'sink' },
			],
		} );
		const by = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( by.s1.y ).not.toBe( by.s2.y ); // sources spread, not collapsed
		expect( by.sink.y ).toBe( ( by.s1.y + by.s2.y ) / 2 );
	} );

	it( 'centers a fan-in MIDDLE node between its sources, keeping the sources spread', () => {
		// community + releases → summarizer → digest. summarizer is a fan-in that
		// also feeds forward — it must still center between its two sources, and the
		// sources must keep their spread (not collapse onto summarizer).
		const { nodes } = autoLayout( {
			nodes: [
				{ id: 'community' },
				{ id: 'releases' },
				{ id: 'summarizer' },
				{ id: 'digest' },
			],
			edges: [
				{ from: 'community', to: 'summarizer' },
				{ from: 'releases', to: 'summarizer' },
				{ from: 'summarizer', to: 'digest' },
			],
		} );
		const by = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( by.community.y ).not.toBe( by.releases.y );
		expect( by.summarizer.y ).toBe(
			( by.community.y + by.releases.y ) / 2
		);
		// …and the chain stays straight: summarizer sits on its downstream row.
		expect( by.summarizer.y ).toBe( by.digest.y );
	} );

	it( 'centers a fan-out producer between its targets (unchanged)', () => {
		// a → t1 + t2. The producer sits at the midpoint of its targets.
		const { nodes } = autoLayout( {
			nodes: [ { id: 'a' }, { id: 't1' }, { id: 't2' } ],
			edges: [
				{ from: 'a', to: 't1' },
				{ from: 'a', to: 't2' },
			],
		} );
		const by = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( by.t1.y ).not.toBe( by.t2.y );
		expect( by.a.y ).toBe( ( by.t1.y + by.t2.y ) / 2 );
	} );
} );

describe( 'autoLayout — real graphs (normalized; relative positions only)', () => {
	// Shift a position map so its top-left corner sits at (0, 0). Only relative
	// positions matter, so the layout and the expected output are each normalized
	// before comparison.
	function normalize( posMap ) {
		let minX = Infinity;
		let minY = Infinity;
		for ( const p of Object.values( posMap ) ) {
			minX = Math.min( minX, p.x );
			minY = Math.min( minY, p.y );
		}
		const out = {};
		for ( const [ id, p ] of Object.entries( posMap ) ) {
			out[ id ] = { x: p.x - minX, y: p.y - minY };
		}
		return out;
	}
	function posMapOf( nodes ) {
		const m = {};
		for ( const n of nodes ) {
			m[ n.id ] = { x: n.position.x, y: n.position.y };
		}
		return m;
	}

	// ── Graph A: performance dashboard (sources → tees → sinks; _output fans in) ──
	const graphA = {
		nodes: [
			{ id: '_completion' },
			{ id: '_cwd' },
			{ id: '_http' },
			{ id: '_metadata' },
			{ id: '_output' },
			{ id: 'echo1' },
			{ id: 'echo2' },
			{ id: 'performance:command' },
			{ id: 'performance:view' },
			{ id: 'tee1' },
			{ id: 'tee2' },
			{ id: 'tee3' },
		],
		edges: [
			{ from: 'performance:command', to: 'tee1' },
			{ from: '_metadata', to: 'tee2' },
			{ from: 'echo1', to: 'tee3' },
			{ from: 'echo2', to: 'tee3' },
			{ from: 'tee1', to: 'performance:view' },
			{ from: 'tee1', to: '_output' },
			{ from: 'tee2', to: '_cwd' },
			{ from: 'tee2', to: '_output' },
			{ from: 'tee3', to: '_output' },
		],
	};
	const graphAExpected1 = {
		_completion: { x: 540, y: 520 },
		_cwd: { x: 540, y: 410 },
		_http: { x: 540, y: 630 },
		_metadata: { x: 60, y: 410 },
		_output: { x: 540, y: 245 },
		echo1: { x: 60, y: 190 },
		echo2: { x: 60, y: 300 },
		'performance:command': { x: 60, y: 80 },
		'performance:view': { x: 540, y: 80 },
		tee1: { x: 300, y: 80 },
		tee2: { x: 300, y: 410 },
		tee3: { x: 300, y: 245 },
	};
	const graphAExpected2 = {
		_completion: { x: 540, y: 685 },
		_cwd: { x: 540, y: 575 },
		_http: { x: 540, y: 795 },
		_metadata: { x: 60, y: 410 },
		_output: { x: 540, y: 245 },
		echo1: { x: 60, y: 190 },
		echo2: { x: 60, y: 300 },
		'performance:command': { x: 60, y: 80 },
		'performance:view': { x: 540, y: -85 },
		tee1: { x: 300, y: 80 },
		tee2: { x: 300, y: 410 },
		tee3: { x: 300, y: 245 },
	};

	// ── Graph B: firehose-workers-and-jobs topology ──
	const graphB = {
		nodes: [
			{ id: '_repl' },
			{ id: 'completed:partition' },
			{ id: 'completed:tee' },
			{ id: 'errors:partition' },
			{ id: 'firehose:consumer' },
			{ id: 'firehose:tee' },
			{ id: 'gyroscope:partition' },
			{ id: 'job-router' },
			{ id: 'jobintake:consumer' },
			{ id: 'jobs:partition' },
			{ id: 'request-builder' },
			{ id: 'requests:partition' },
		],
		edges: [
			{ from: 'firehose:consumer', to: 'firehose:tee' },
			{ from: 'firehose:tee', to: 'request-builder' },
			{ from: 'firehose:tee', to: 'job-router' },
			{ from: 'request-builder', to: 'requests:partition' },
			{ from: 'request-builder', to: 'errors:partition' },
			{ from: 'request-builder', to: 'completed:tee' },
			{ from: 'request-builder', to: 'gyroscope:partition' },
			{ from: 'completed:tee', to: 'completed:partition' },
			{ from: 'completed:tee', to: 'gyroscope:partition' },
			{ from: 'job-router', to: 'jobs:partition' },
			{ from: 'jobintake:consumer', to: 'job-router' },
		],
	};
	const graphBExpected1 = {
		_repl: { x: 1020, y: 630 },
		'completed:partition': { x: 1020, y: 80 },
		'completed:tee': { x: 780, y: 135 },
		'errors:partition': { x: 1020, y: 300 },
		'firehose:consumer': { x: 60, y: 410 },
		'firehose:tee': { x: 300, y: 410 },
		'gyroscope:partition': { x: 1020, y: 190 },
		'job-router': { x: 540, y: 520 },
		'jobintake:consumer': { x: 60, y: 520 },
		'jobs:partition': { x: 1020, y: 520 },
		'request-builder': { x: 540, y: 245 },
		'requests:partition': { x: 1020, y: 410 },
	};
	const graphBExpected2 = {
		...graphBExpected1,
		'request-builder': { x: 540, y: 300 },
	};

	it( 'lays out the firehose worker graph (graph B) — already satisfied', () => {
		const got = normalize( posMapOf( autoLayout( graphB ).nodes ) );
		expect( [
			normalize( graphBExpected1 ),
			normalize( graphBExpected2 ),
		] ).toContainEqual( got );
	} );

	it( 'lays out the performance dashboard graph (graph A)', () => {
		const got = normalize( posMapOf( autoLayout( graphA ).nodes ) );
		expect( [
			normalize( graphAExpected1 ),
			normalize( graphAExpected2 ),
		] ).toContainEqual( got );
	} );

	// The runtime registers nodes in an arbitrary order (the live performance
	// dashboard hands them over backbone-first, not alphabetically). The layout
	// must be the same regardless — a node's registration order must not change
	// where it lands. The backbone-first order is the exact one that produced the
	// wrong live layout before the fix.
	const reorder = ( graph, order ) => ( {
		nodes: order.map( ( id ) => ( { id } ) ),
		edges: graph.edges,
	} );
	const permutations = ( graph ) => {
		const ids = graph.nodes.map( ( n ) => n.id );
		return [
			ids,
			[ ...ids ].reverse(),
			[ ...ids ].sort(),
			[ ...ids.slice( 6 ), ...ids.slice( 0, 6 ) ],
		];
	};

	it( 'graph A is independent of node registration order (incl. live backbone order)', () => {
		const liveBackbone = [
			'_metadata',
			'_output',
			'_cwd',
			'_http',
			'_completion',
			'performance:command',
			'performance:view',
			'echo1',
			'echo2',
			'tee1',
			'tee2',
			'tee3',
		];
		const orders = [ liveBackbone, ...permutations( graphA ) ];
		for ( const order of orders ) {
			const got = normalize(
				posMapOf( autoLayout( reorder( graphA, order ) ).nodes )
			);
			expect( [
				normalize( graphAExpected1 ),
				normalize( graphAExpected2 ),
			] ).toContainEqual( got );
		}
	} );

	// ── Graph C: fan-in → straight chain → fan-out (the summarizer pipeline) ──
	// community/releases → summarizer → digest → tee → out/_repl. The end fan-out
	// must STRADDLE tee (out/_repl above & below it), mirroring the start fan-in.
	const graphC = {
		nodes: [
			'_repl',
			'community',
			'digest',
			'out',
			'releases',
			'summarizer',
			'tee',
		].map( ( id ) => ( { id } ) ),
		edges: [
			[ 'community', 'summarizer' ],
			[ 'releases', 'summarizer' ],
			[ 'summarizer', 'digest' ],
			[ 'digest', 'tee' ],
			[ 'tee', 'out' ],
			[ 'tee', '_repl' ],
		].map( ( [ from, to ] ) => ( { from, to } ) ),
	};
	const graphCExpected = {
		community: { x: 60, y: 80 },
		releases: { x: 60, y: 190 },
		summarizer: { x: 300, y: 135 },
		digest: { x: 540, y: 135 },
		tee: { x: 780, y: 135 },
		_repl: { x: 1020, y: 80 },
		out: { x: 1020, y: 190 },
	};

	it( 'straddles a tail fan-out around its producer (graph C, order-independent)', () => {
		for ( const order of permutations( graphC ) ) {
			const got = normalize(
				posMapOf( autoLayout( reorder( graphC, order ) ).nodes )
			);
			expect( got ).toEqual( normalize( graphCExpected ) );
		}
	} );

	it( 'graph B is independent of node registration order', () => {
		for ( const order of permutations( graphB ) ) {
			const got = normalize(
				posMapOf( autoLayout( reorder( graphB, order ) ).nodes )
			);
			expect( [
				normalize( graphBExpected1 ),
				normalize( graphBExpected2 ),
			] ).toContainEqual( got );
		}
	} );
} );

describe( 'autoLayout', () => {
	it( 'returns empty nodes/edges arrays when input has none', () => {
		const out = autoLayout( { nodes: [], edges: [] } );
		expect( out.nodes ).toEqual( [] );
		expect( out.edges ).toEqual( [] );
	} );

	it( 'tolerates an empty/missing parsed argument', () => {
		expect( autoLayout( {} ).nodes ).toEqual( [] );
		expect( autoLayout( null ).nodes ).toEqual( [] );
		expect( autoLayout( undefined ).nodes ).toEqual( [] );
	} );

	it( 'places a single source node at the origin column', () => {
		const out = autoLayout( {
			nodes: [ { id: 'a' } ],
			edges: [],
		} );
		expect( out.nodes[ 0 ].position ).toEqual( { x: X_PAD, y: Y_PAD } );
	} );

	it( 'increments column for each predecessor link in a chain', () => {
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ],
			edges: [
				{ from: 'a', to: 'b' },
				{ from: 'b', to: 'c' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.a.position.x ).toBe( X_PAD );
		expect( byId.b.position.x ).toBe( X_PAD + X_STEP );
		expect( byId.c.position.x ).toBe( X_PAD + 2 * X_STEP );
	} );

	it( 'pulls a node forward when its only target is several columns ahead', () => {
		// a->c, b->c, b->d: the forward-pull slides a toward c.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' } ],
			edges: [
				{ from: 'a', to: 'c' },
				{ from: 'b', to: 'c' },
				{ from: 'b', to: 'd' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.c.position.x ).toBe( byId.d.position.x );
	} );

	it( 'orders nodes within a column by barycenter of predecessors', () => {
		// Two sources, two sinks; pass 2 snaps sources toward targets.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'y' } ],
			edges: [
				{ from: 'a', to: 'y' },
				{ from: 'b', to: 'x' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.x.position.x ).toBe( byId.y.position.x );
		expect( byId.x.position.y ).not.toBe( byId.y.position.y );
	} );

	it( 'breaks cycles by treating one node as the entry of the loop', () => {
		// a->b->a is a 2-cycle; DFS depth-0 for whichever it visits first.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' } ],
			edges: [
				{ from: 'a', to: 'b' },
				{ from: 'b', to: 'a' },
			],
		} );
		expect( out.nodes ).toHaveLength( 2 );
		out.nodes.forEach( ( n ) =>
			expect( n.position ).toEqual(
				expect.objectContaining( {
					x: expect.any( Number ),
					y: expect.any( Number ),
				} )
			)
		);
	} );

	it( 'deconflicts when two column-mates land on the same row', () => {
		// a->z, b->z: both want z's row; pass 3 bumps one.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 'z' } ],
			edges: [
				{ from: 'a', to: 'z' },
				{ from: 'b', to: 'z' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.a.position.x ).toBe( byId.b.position.x );
		expect( byId.a.position.y ).not.toBe( byId.b.position.y );
	} );

	it( 'prefers the "straighter" link when two column-mates tie on row', () => {
		// a->b->c (row 0) and x->y->c (via y, row 1); straightness keeps b on c's row.
		const out = autoLayout( {
			nodes: [
				{ id: 'a' },
				{ id: 'x' },
				{ id: 'b' },
				{ id: 'y' },
				{ id: 'c' },
			],
			edges: [
				{ from: 'a', to: 'b' },
				{ from: 'b', to: 'c' },
				{ from: 'x', to: 'y' },
				{ from: 'y', to: 'c' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.b.position.x ).toBe( byId.y.position.x );
		expect( byId.b.position.y ).not.toBe( byId.y.position.y );
	} );

	it( 'leaves the edges array unchanged', () => {
		const edges = [ { from: 'a', to: 'b' } ];
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' } ],
			edges,
		} );
		expect( out.edges ).toBe( edges );
	} );

	it( 'does not mutate the input nodes array', () => {
		const inputNodes = [ { id: 'a' }, { id: 'b' } ];
		const inputCopy = inputNodes.map( ( n ) => ( { ...n } ) );
		autoLayout( {
			nodes: inputNodes,
			edges: [ { from: 'a', to: 'b' } ],
		} );
		expect( inputNodes ).toEqual( inputCopy );
	} );

	it( 'exports column/row pitch constants for snap consumers', () => {
		expect( X_STEP ).toBe( 240 );
		expect( Y_STEP ).toBe( 110 );
		expect( X_PAD ).toBe( 60 );
		expect( Y_PAD ).toBe( 80 );
		expect( NODE_W ).toBe( 196 );
		expect( NODE_H ).toBe( 84 );
	} );

	it( 'survives an isolated node with no edges', () => {
		const out = autoLayout( {
			nodes: [ { id: 'a' } ],
			edges: [],
		} );
		expect( out.nodes[ 0 ].position ).toEqual( { x: X_PAD, y: Y_PAD } );
	} );

	it( 'positions a 4-node diamond cleanly', () => {
		// Diamond: a->b,a->c,b->d,c->d.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' } ],
			edges: [
				{ from: 'a', to: 'b' },
				{ from: 'a', to: 'c' },
				{ from: 'b', to: 'd' },
				{ from: 'c', to: 'd' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.a.position.x ).toBe( X_PAD );
		expect( byId.d.position.x ).toBe( X_PAD + 2 * X_STEP );
		expect( byId.b.position.x ).toBe( byId.c.position.x );
		expect( byId.b.position.y ).not.toBe( byId.c.position.y );
	} );

	it( 'pairs a single-source target with its source, and centers a multi-source fan-in between its sources', () => {
		// Local-Shell topology repro: 5 sources in col 0, 3 targets in col 1.
		// Two sources share a target (_metadata + _uptime → _cwd); two have
		// their own target; one source has no target. The desired layout
		// places each source on the SAME ROW as its (first) target, so the
		// dashed edge runs horizontally between adjacent columns. Sources
		// without a target (or that share a target already paired) fall to
		// the next available row.
		const out = autoLayout( {
			nodes: [
				{ id: '_metadata' },
				{ id: '_uptime' },
				{ id: '_completion' },
				{ id: '_heartbeat' },
				{ id: '_sse' },
				{ id: '_cwd' },
				{ id: '_http' },
				{ id: '_output' },
			],
			edges: [
				{ from: '_metadata', to: '_cwd' },
				{ from: '_uptime', to: '_cwd' },
				{ from: '_heartbeat', to: '_http' },
				{ from: '_sse', to: '_output' },
			],
		} );
		const rowOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.y - Y_PAD ) /
			Y_STEP;
		// Single-source targets stay paired with their source (straight edge).
		expect( rowOf( '_heartbeat' ) ).toBe( rowOf( '_http' ) );
		expect( rowOf( '_sse' ) ).toBe( rowOf( '_output' ) );
		// _cwd fans in from _metadata + _uptime, so it centers between them (mirror
		// of fan-out) — the two sources stay spread on different rows.
		expect( rowOf( '_metadata' ) ).not.toBe( rowOf( '_uptime' ) );
		expect( rowOf( '_cwd' ) ).toBe(
			( rowOf( '_metadata' ) + rowOf( '_uptime' ) ) / 2
		);
	} );

	it( 'pushes every sink (no outgoing) AND every isolated node (no edges) to the max-depth column', () => {
		// Worker pattern: a fan-out from request-builder reaches some leaf
		// partitions at depth 3 and some at depth 4 (via completed:tee). The
		// shallower-depth sinks should cluster in the rightmost column with
		// the natural-max-depth sinks so all partitions line up. An isolated
		// node (no edges anywhere — `_repl` in the live worker graph) joins
		// them at the right rather than sitting lonely on the left.
		const out = autoLayout( {
			nodes: [
				{ id: 'consumer' },
				{ id: 'tee' },
				{ id: 'request_builder' },
				{ id: 'completed_tee' },
				{ id: 'errors' },
				{ id: 'completed' },
				{ id: 'gyroscope' },
				{ id: '_repl' }, // isolated
			],
			edges: [
				{ from: 'consumer', to: 'tee' },
				{ from: 'tee', to: 'request_builder' },
				{ from: 'request_builder', to: 'completed_tee' },
				{ from: 'request_builder', to: 'errors' }, // sink at depth 3
				{ from: 'completed_tee', to: 'completed' }, // sink at depth 4
				{ from: 'completed_tee', to: 'gyroscope' }, // sink at depth 4
			],
		} );
		const colOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.x - X_PAD ) /
			X_STEP;
		// All sinks (errors, completed, gyroscope) and the isolated _repl
		// land in the rightmost column.
		const maxCol = Math.max(
			...out.nodes.map( ( n ) => ( n.position.x - X_PAD ) / X_STEP )
		);
		expect( colOf( 'errors' ) ).toBe( maxCol );
		expect( colOf( 'completed' ) ).toBe( maxCol );
		expect( colOf( 'gyroscope' ) ).toBe( maxCol );
		expect( colOf( '_repl' ) ).toBe( maxCol );
		// Internal nodes stay at their topological depth.
		expect( colOf( 'consumer' ) ).toBe( 0 );
		expect( colOf( 'tee' ) ).toBe( 1 );
		expect( colOf( 'request_builder' ) ).toBe( 2 );
		expect( colOf( 'completed_tee' ) ).toBeLessThan( maxCol );
	} );

	it( 'source-only nodes (no incoming edges) stay anchored at column 0 (left edge)', () => {
		// Worker pattern: jobintake:consumer → job-router → jobs:partition
		// alongside a longer chain that makes jobs:partition depth 3. The
		// forward-pull pass slides job-router right (toward jobs:partition's
		// depth 3), which would then drag jobintake:consumer with it.
		// Source-only nodes ignore the forward pull — they have nowhere to
		// come from, so they belong on the left edge.
		const out = autoLayout( {
			nodes: [
				{ id: 'jobintake_consumer' },
				{ id: 'job_router' },
				{ id: 'jobs_partition' },
				{ id: 'chain1' },
				{ id: 'chain2' },
				{ id: 'longer_source' },
			],
			edges: [
				{ from: 'jobintake_consumer', to: 'job_router' },
				{ from: 'job_router', to: 'jobs_partition' },
				{ from: 'longer_source', to: 'chain1' },
				{ from: 'chain1', to: 'chain2' },
				{ from: 'chain2', to: 'jobs_partition' },
			],
		} );
		const colOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.x - X_PAD ) /
			X_STEP;
		expect( colOf( 'jobintake_consumer' ) ).toBe( 0 );
		expect( colOf( 'longer_source' ) ).toBe( 0 );
	} );

	it( 'a middle node with a fan-out sits near the midpoint of its targets (not pulled to its predecessor row)', () => {
		// Worker pattern: request-builder fans out to 4 targets across rows
		// 0..3. Its single predecessor (firehose:tee) sits on row 0. The
		// midpoint of the targets is row 1.5 — request-builder should land
		// near that, not on row 0 with its predecessor.
		const out = autoLayout( {
			nodes: [
				{ id: 'firehose_tee' },
				{ id: 'request_builder' },
				{ id: 't1' },
				{ id: 't2' },
				{ id: 't3' },
				{ id: 't4' },
			],
			edges: [
				{ from: 'firehose_tee', to: 'request_builder' },
				{ from: 'request_builder', to: 't1' },
				{ from: 'request_builder', to: 't2' },
				{ from: 'request_builder', to: 't3' },
				{ from: 'request_builder', to: 't4' },
			],
		} );
		const rowOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.y - Y_PAD ) /
			Y_STEP;
		const tRows = [
			rowOf( 't1' ),
			rowOf( 't2' ),
			rowOf( 't3' ),
			rowOf( 't4' ),
		];
		const midpoint = tRows.reduce( ( a, b ) => a + b, 0 ) / tRows.length;
		// Within 1 row of the midpoint (deconflict bumps can shift it some).
		expect(
			Math.abs( rowOf( 'request_builder' ) - midpoint )
		).toBeLessThanOrEqual( 1 );
	} );

	it( 'a fan-out source lands on a HALF-row at the exact midpoint of its targets (e.g. targets at 1+2 → source at 1.5)', () => {
		// User-requested precision: snap to nearest 0.5 (not 1) so a source
		// fanning to 2 targets at rows 1 and 2 sits exactly between them at
		// row 1.5 — the dashed edges then run symmetrically up-right and
		// down-right at the same angle.
		const out = autoLayout( {
			nodes: [ { id: 'src' }, { id: 't_upper' }, { id: 't_lower' } ],
			edges: [
				{ from: 'src', to: 't_upper' },
				{ from: 'src', to: 't_lower' },
			],
		} );
		const rowOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.y - Y_PAD ) /
			Y_STEP;
		// Targets at integer rows 0 and 1 (alpha order), source midpoint 0.5.
		expect( rowOf( 't_lower' ) ).toBe( 0 );
		expect( rowOf( 't_upper' ) ).toBe( 1 );
		expect( rowOf( 'src' ) ).toBe( 0.5 );
	} );

	it( 'completed:tee in the worker topology lands at the half-row midpoint of its 2 leaf targets', () => {
		// Full worker repro of the screenshot Chris flagged. completed:tee
		// has two outgoing edges (→ completed:partition, → gyroscope:partition)
		// in a graph where col 4 contains both targets at non-adjacent rows.
		// The half-row snap should put completed:tee at the exact midpoint of
		// the two target rows — NOT at the same row as one of them.
		const out = autoLayout( {
			nodes: [
				{ id: 'firehose:consumer' },
				{ id: 'firehose:tee' },
				{ id: 'request-builder' },
				{ id: 'completed:tee' },
				{ id: 'jobintake:consumer' },
				{ id: 'job-router' },
				{ id: 'errors:partition' },
				{ id: 'requests:partition' },
				{ id: 'jobs:partition' },
				{ id: 'completed:partition' },
				{ id: 'gyroscope:partition' },
				{ id: '_repl' },
			],
			edges: [
				{ from: 'firehose:consumer', to: 'firehose:tee' },
				{ from: 'firehose:tee', to: 'request-builder' },
				{ from: 'request-builder', to: 'completed:tee' },
				{ from: 'request-builder', to: 'errors:partition' },
				{ from: 'request-builder', to: 'requests:partition' },
				{ from: 'completed:tee', to: 'completed:partition' },
				{ from: 'completed:tee', to: 'gyroscope:partition' },
				{ from: 'jobintake:consumer', to: 'job-router' },
				{ from: 'job-router', to: 'jobs:partition' },
			],
		} );
		const rowOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.y - Y_PAD ) /
			Y_STEP;
		const ctRow = rowOf( 'completed:tee' );
		const cpRow = rowOf( 'completed:partition' );
		const gyroRow = rowOf( 'gyroscope:partition' );
		// completed:tee must NOT share a row with either of its targets —
		// it sits strictly between them.
		expect( ctRow ).not.toBe( cpRow );
		expect( ctRow ).not.toBe( gyroRow );
		// And specifically at the exact midpoint.
		expect( ctRow ).toBe( ( cpRow + gyroRow ) / 2 );
	} );

	it( 'middle nodes re-snap to FINAL target rows after deconflict (not stale Pass-1 rows)', () => {
		// Worker repro of the firehose-workers-and-jobs topology with virtual
		// edges (the augmentWithVirtualEdges output): request-builder fans
		// out to errors, completed:tee, gyroscope, requests. completed:tee
		// fans to completed:partition and gyroscope. The col 4 deconflict
		// pulls gyroscope from Pass-1 row 2 → row 1; without a second snap
		// pass, completed:tee stays at Pass-2 row 1 (mean of row 0 and the
		// STALE row 2) and ends up sharing gyroscope's row. The final
		// re-snap should put it at the actual midpoint of its FINAL targets:
		// (0 + 1) / 2 = 0.5.
		const out = autoLayout( {
			nodes: [
				{ id: 'firehose:consumer' },
				{ id: 'firehose:tee' },
				{ id: 'request-builder' },
				{ id: 'completed:tee' },
				{ id: 'jobintake:consumer' },
				{ id: 'job-router' },
				{ id: 'errors:partition' },
				{ id: 'requests:partition' },
				{ id: 'jobs:partition' },
				{ id: 'completed:partition' },
				{ id: 'gyroscope:partition' },
				{ id: '_repl' },
			],
			edges: [
				{ from: 'firehose:consumer', to: 'firehose:tee' },
				{ from: 'firehose:tee', to: 'request-builder' },
				{ from: 'firehose:tee', to: 'job-router' },
				{ from: 'request-builder', to: 'requests:partition' },
				{ from: 'request-builder', to: 'errors:partition' },
				{ from: 'request-builder', to: 'completed:tee' },
				{ from: 'request-builder', to: 'gyroscope:partition' },
				{ from: 'completed:tee', to: 'completed:partition' },
				{ from: 'completed:tee', to: 'gyroscope:partition' },
				{ from: 'jobintake:consumer', to: 'job-router' },
				{ from: 'job-router', to: 'jobs:partition' },
			],
		} );
		const rowOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.y - Y_PAD ) /
			Y_STEP;
		const ctRow = rowOf( 'completed:tee' );
		const cpRow = rowOf( 'completed:partition' );
		const gyroRow = rowOf( 'gyroscope:partition' );
		expect( ctRow ).not.toBe( gyroRow );
		expect( ctRow ).toBe( ( cpRow + gyroRow ) / 2 );
	} );

	it( 'falls back to alphabetical when barycenter ties', () => {
		// Tied barycenter -> alphabetical id sort.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'y' }, { id: 'b' } ],
			edges: [
				{ from: 'a', to: 'y' },
				{ from: 'a', to: 'b' },
			],
		} );
		const byId = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n ] )
		);
		expect( byId.b.position.y ).not.toBe( byId.y.position.y );
	} );
} );

describe( 'snapToGrid', () => {
	// Drop point lands AT (or near) a node's center; snapToGrid returns the
	// top-left corner of a node whose center sits on the nearest grid
	// intersection. That keeps a fresh drop on the same grid the renderer
	// uses for the existing nodes, so connections + drag-snaps line up.
	it( 'snaps the canonical first-cell drop to (X_PAD, Y_PAD)', () => {
		// (X_PAD + NODE_W/2, Y_PAD + NODE_H/2) is the first cell's center;
		// snapping that returns the top-left = (X_PAD, Y_PAD).
		expect( snapToGrid( X_PAD + NODE_W / 2, Y_PAD + NODE_H / 2 ) ).toEqual(
			{ x: X_PAD, y: Y_PAD }
		);
	} );

	it( 'rounds an off-grid drop to the nearest intersection', () => {
		// A drop one cell to the right + a hair below — round to (col 2, row 2).
		const cx = X_PAD + NODE_W / 2 + X_STEP + 4;
		const cy = Y_PAD + NODE_H / 2 + Y_STEP + 3;
		expect( snapToGrid( cx, cy ) ).toEqual( {
			x: X_PAD + X_STEP,
			y: Y_PAD + Y_STEP,
		} );
	} );
} );
