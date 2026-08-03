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
} from '../autoLayout';

// The node card autoLayout centres its snap grid on; asserted via snapToGrid.
const NODE_W = 196;
const NODE_H = 84;

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
	// Smallest vertical gap between same-column nodes; < NODE_H means overlap.
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
		// a→t1+t2 snaps to 0.5; b→t2 is row 1; 0.5 vs 1.0 is a 55px overlap.
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
		// a→t1(0)+t2(1) snaps to 0.5, alone in col — keep the half-row intact.
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
		// s1+s2→sink: sink at the midpoint of its sources, not the top one.
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
		// summarizer fans in from community+releases and also feeds digest.
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
	// Shift a position map so its top-left sits at (0,0) for comparison.
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

	// ── Graph A: performance dashboard (sources → tees → sinks) ──
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

	// Layout must be identical regardless of node registration order.
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

	// ── Graph C: fan-in chain then a tail fan-out that straddles tee ──
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
		// a->b->c (row 0), x->y->c (row 1); straightness keeps b on c's row.
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
		// Local-Shell repro: each source shares its target's row.
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
		// _cwd fans in from _metadata+_uptime, so it centers between them.
		expect( rowOf( '_metadata' ) ).not.toBe( rowOf( '_uptime' ) );
		expect( rowOf( '_cwd' ) ).toBe(
			( rowOf( '_metadata' ) + rowOf( '_uptime' ) ) / 2
		);
	} );

	it( 'pushes every sink (no outgoing) AND every isolated node (no edges) to the max-depth column', () => {
		// Sinks at mixed depths + an isolated _repl all cluster rightmost.
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
		// All sinks and the isolated _repl land in the rightmost column.
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
		// Source-only nodes ignore the forward-pull and stay on the left edge.
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
		// A fan-out middle node sits near its targets' midpoint, not row 0.
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
		// Snap to nearest 0.5 so a 2-target fan-out sits exactly between them.
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
		// completed:tee snaps to the exact midpoint of its 2 leaf targets.
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
		// completed:tee must sit strictly between its targets, not on either.
		expect( ctRow ).not.toBe( cpRow );
		expect( ctRow ).not.toBe( gyroRow );
		// And specifically at the exact midpoint.
		expect( ctRow ).toBe( ( cpRow + gyroRow ) / 2 );
	} );

	it( 'middle nodes re-snap to FINAL target rows after deconflict (not stale Pass-1 rows)', () => {
		// Middle nodes must re-snap to FINAL target rows after deconflict.
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
	// snapToGrid maps a drop's center to the nearest grid intersection.
	it( 'snaps the canonical first-cell drop to (X_PAD, Y_PAD)', () => {
		// The first cell's center snaps back to its top-left (X_PAD, Y_PAD).
		expect( snapToGrid( X_PAD + NODE_W / 2, Y_PAD + NODE_H / 2 ) ).toEqual(
			{ x: X_PAD, y: Y_PAD }
		);
	} );

	it( 'rounds an off-grid drop to the nearest intersection', () => {
		// A drop one cell right + a hair below — round to (col 2, row 2).
		const cx = X_PAD + NODE_W / 2 + X_STEP + 4;
		const cy = Y_PAD + NODE_H / 2 + Y_STEP + 3;
		expect( snapToGrid( cx, cy ) ).toEqual( {
			x: X_PAD + X_STEP,
			y: Y_PAD + Y_STEP,
		} );
	} );

	// The bucket is a half-step wide and centred on the card, so these two
	// pin the card offset (NODE_W/2, NODE_H/2) the grid is built around.
	it( 'keeps a drop just inside the half-step of the card centre', () => {
		expect(
			snapToGrid(
				X_PAD + NODE_W / 2 + X_STEP / 4 - 1,
				Y_PAD + NODE_H / 2 + Y_STEP / 4 - 0.5
			)
		).toEqual( { x: X_PAD, y: Y_PAD } );
	} );

	it( 'pushes a drop at the half-step boundary onto the next half-cell', () => {
		expect(
			snapToGrid(
				X_PAD + NODE_W / 2 + X_STEP / 4,
				Y_PAD + NODE_H / 2 + Y_STEP / 4
			)
		).toEqual( { x: X_PAD + X_STEP / 2, y: Y_PAD + Y_STEP / 2 } );
	} );
} );

describe( 'autoLayout — disconnected components', () => {
	// A hub fan-out beside two components that share no node with it. The
	// widest column anchors the row assignment, so nothing seeds a row for
	// the outsiders; the spread pass then carried `undefined` into NaN and
	// those cards rendered at y=NaN — invisible, with no error anywhere.
	const SPOKES = [
		'settings:metrotimes',
		'settings:northcoast',
		'settings:ntslo',
		'settings:okgazette',
		'settings:orlando',
		'settings:pittsburgh',
		'settings:sacurrent',
		'settings:sauce',
		'settings:sevendaysvt',
		'settings:springfieldbusinessjournal',
		'settings:thecoast',
		'settings:tucsonweekly',
	];
	const graph = {
		nodes: [
			'null',
			...SPOKES,
			'_topicprobe',
			'_topicprobe:log',
			'settings:consumer',
			'settings-sync',
			'discovery-collector',
			'_repl',
		].map( ( id ) => ( { id } ) ),
		edges: [
			{ from: '_topicprobe', to: '_topicprobe:log' },
			{ from: 'settings:consumer', to: 'settings-sync' },
			...SPOKES.map( ( to ) => ( { from: 'settings-sync', to } ) ),
			...SPOKES.map( ( to ) => ( { from: 'discovery-collector', to } ) ),
			...SPOKES.map( ( from ) => ( { from, to: 'null' } ) ),
		],
	};

	it( 'gives every node a finite position', () => {
		const laid = autoLayout( graph );
		const broken = laid.nodes
			.filter(
				( n ) =>
					! Number.isFinite( n.position.x ) ||
					! Number.isFinite( n.position.y )
			)
			.map( ( n ) => `${ n.id } (${ n.position.x }, ${ n.position.y })` );
		expect( broken ).toEqual( [] );
	} );
} );
