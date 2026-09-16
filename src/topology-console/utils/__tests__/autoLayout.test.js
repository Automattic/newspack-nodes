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
import SEEDS from './fixtures/autoLayout-seeds.json';

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

describe( 'autoLayout — no overlapping nodes', () => {
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

/**
 * The cards a wire sweeps through. A wire spanning two or more columns
 * crosses every column between as a cubic that, over a card's width,
 * runs nearly the whole way from its source row to its sink row, so a
 * card in a between column whose centre lies inside that span, within
 * half a card of it, is drawn over. The margin is a card's half height.
 *
 * @param {Array<Object>} nodes Positioned nodes.
 * @param {Array<Object>} edges The wires.
 * @return {Array<string>} `from→to over id` for every card a wire crosses.
 */
function wiresThroughCards( nodes, edges ) {
	const by = Object.fromEntries( nodes.map( ( n ) => [ n.id, n ] ) );
	const hits = [];
	for ( const { from, to } of edges ) {
		const a = by[ from ].position;
		const b = by[ to ].position;
		const lo = Math.min( a.y, b.y );
		const hi = Math.max( a.y, b.y );
		for ( const n of nodes ) {
			const between = ( n.position.x - a.x ) * ( n.position.x - b.x ) < 0;
			if ( ! between ) {
				continue;
			}
			if (
				n.position.y > lo - NODE_H / 2 &&
				n.position.y < hi + NODE_H / 2
			) {
				hits.push( `${ from }→${ to } over ${ n.id }` );
			}
		}
	}
	return hits;
}

describe( 'autoLayout — no wire through a card', () => {
	it( 'routes a fan-out past a tee in the column between', () => {
		// The event logger's complete topology: request-builder feeds four
		// partitions two columns on AND the tee between, which feeds two
		// of its own. The tee has to leave the rows those four wires span.
		const edges = [
			[ 'firehose:consumer', 'request-builder' ],
			[ 'request-builder', 'alerts:partition' ],
			[ 'request-builder', 'errors:partition' ],
			[ 'request-builder', 'requests:partition' ],
			[ 'request-builder', 'gyroscope:partition' ],
			[ 'request-builder', 'completed:tee' ],
			[ 'completed:tee', 'completed:partition' ],
			[ 'completed:tee', 'gyroscope:partition' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( wiresThroughCards( nodes, edges ) ).toEqual( [] );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'links a wire three columns long through every column between', () => {
		// S feeds a three-step chain AND its far end directly. With the
		// placeholders chained only backwards, the sweeps saw no successor
		// for the interior ones and parked the source under its own chain.
		const edges = [
			[ 's', 'x1' ],
			[ 'x1', 'x2' ],
			[ 'x2', 'x3' ],
			[ 'x3', 'p1' ],
			[ 'x3', 'p2' ],
			[ 'x3', 'p3' ],
			[ 's', 'p1' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( wiresThroughCards( nodes, edges ) ).toEqual( [] );
		const y = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position.y ] )
		);
		// The source sits between its chain and the wire, not below both.
		expect( y.s ).toBeLessThan( y.x1 );
		expect( y.x1 ).toBe( y.x2 );
		expect( y.x2 ).toBe( y.x3 );
	} );

	it( 'weighs a wire declared twice once', () => {
		const once = [
			[ 'a', 'b' ],
			[ 'b', 'c' ],
			[ 'a', 'c' ],
			[ 'a', 'd' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const twice = [ ...once, { from: 'a', to: 'c' } ];
		const nodes = [ 'a', 'b', 'c', 'd' ].map( ( id ) => ( { id } ) );
		expect( autoLayout( { nodes, edges: twice } ).nodes ).toEqual(
			autoLayout( { nodes, edges: once } ).nodes
		);
	} );

	it( 'never chases two columns down the canvas', () => {
		// S fans out to L0..L3, each L feeds its own R and the next one's,
		// every R feeds T, and L1 → m → R1 parks L1 between the fan and its
		// targets. Nudging L1 moves its wires across the R column, nudging
		// an R moves its wires back across the L column: an unbounded pass
		// walked both columns down the canvas. A bounded one stays compact.
		const n = 4;
		const edges = [];
		for ( let i = 0; i < n; i++ ) {
			edges.push( { from: 's', to: `l${ i }` } );
			edges.push( { from: `l${ i }`, to: `r${ i }` } );
			if ( i + 1 < n ) {
				edges.push( { from: `l${ i + 1 }`, to: `r${ i }` } );
			}
			edges.push( { from: `r${ i }`, to: 't' } );
		}
		edges.push( { from: 'l1', to: 'm' }, { from: 'm', to: 'r1' } );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		const rows = nodes.map( ( n2 ) => ( n2.position.y - Y_PAD ) / Y_STEP );
		expect( Math.max( ...rows ) - Math.min( ...rows ) ).toBeLessThan(
			ids.length
		);
	} );

	it( 'holds for the firehose worker graph too', () => {
		const edges = [
			[ 'completed:tee', 'completed:partition' ],
			[ 'completed:tee', 'gyroscope:partition' ],
			[ 'firehose:consumer', 'firehose:tee' ],
			[ 'firehose:tee', 'request-builder' ],
			[ 'firehose:tee', 'job-router' ],
			[ 'job-router', 'jobs:partition' ],
			[ 'jobintake:consumer', 'job-router' ],
			[ 'request-builder', 'requests:partition' ],
			[ 'request-builder', 'errors:partition' ],
			[ 'request-builder', 'completed:tee' ],
			[ 'request-builder', 'gyroscope:partition' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( wiresThroughCards( nodes, edges ) ).toEqual( [] );
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
	// The two edgeless nodes stack below the band, at its first column.
	const graphAExpected1 = {
		_completion: { x: 60, y: 520 },
		_cwd: { x: 540, y: 410 },
		_http: { x: 60, y: 630 },
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
		_completion: { x: 60, y: 685 },
		_cwd: { x: 540, y: 575 },
		_http: { x: 60, y: 795 },
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
	const graphBExpected = {
		_repl: { x: 60, y: 630 },
		'completed:partition': { x: 1020, y: 190 },
		'completed:tee': { x: 780, y: 245 },
		'errors:partition': { x: 1020, y: 410 },
		'firehose:consumer': { x: 60, y: 245 },
		'firehose:tee': { x: 300, y: 245 },
		'gyroscope:partition': { x: 1020, y: 300 },
		'job-router': { x: 540, y: 80 },
		'jobintake:consumer': { x: 300, y: 80 },
		'jobs:partition': { x: 1020, y: 80 },
		'request-builder': { x: 540, y: 410 },
		'requests:partition': { x: 1020, y: 520 },
	};
	it( 'lays out the firehose worker graph (graph B) — already satisfied', () => {
		const got = normalize( posMapOf( autoLayout( graphB ).nodes ) );
		expect( got ).toEqual( normalize( graphBExpected ) );
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
			expect( got ).toEqual( normalize( graphBExpected ) );
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

	it( 'seats a sink beside the consumers it shares a feeder with', () => {
		// A slice's view answers the same tee its fetcher does, so it belongs
		// in the fetcher's column. Pinned to the band's far column instead, its
		// wire crosses every card between — which is what dragged the debug
		// overlay's session views a column past the fetchers feeding them.
		const out = autoLayout( {
			nodes: [
				{ id: 'quokka:timer' },
				{ id: 'quokka:tee' },
				{ id: 'quokka:fetch' },
				{ id: 'quokka:in' },
				{ id: 'quokka:view' },
				{ id: '_shell' },
			],
			edges: [
				{ from: 'quokka:timer', to: 'quokka:tee' },
				{ from: 'quokka:tee', to: 'quokka:fetch' },
				{ from: 'quokka:in', to: 'quokka:fetch' },
				{ from: 'quokka:in', to: 'quokka:view' },
				{ from: 'quokka:fetch', to: '_shell' },
			],
		} );
		const colOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.x - X_PAD ) /
			X_STEP;

		// The view shares `quokka:in` with the fetcher, so it shares its column.
		expect( colOf( 'quokka:view' ) ).toBe( colOf( 'quokka:fetch' ) );
		// `_shell` shares its feeder with nobody: one column past that feeder.
		expect( colOf( '_shell' ) ).toBe( colOf( 'quokka:fetch' ) + 1 );
	} );

	it( 'raises a sink to the furthest consumer sharing its feeder', () => {
		// `zz` is one column deep and `w0` five, both fed by `x`. Seating `zz`
		// by its own depth alone would split `x`'s successors across columns,
		// and a source whose successors span columns is no pair to seat level
		// with them — which is how `x` drifted three rows off its own sink.
		const out = autoLayout( {
			nodes: [
				{ id: 'chain0' },
				{ id: 'chain1' },
				{ id: 'chain2' },
				{ id: 'chain3' },
				{ id: 'x' },
				{ id: 'w0' },
				{ id: 'zz' },
			],
			edges: [
				{ from: 'chain0', to: 'chain1' },
				{ from: 'chain1', to: 'chain2' },
				{ from: 'chain2', to: 'chain3' },
				{ from: 'chain3', to: 'w0' },
				{ from: 'x', to: 'w0' },
				{ from: 'x', to: 'zz' },
			],
		} );
		const colOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.x - X_PAD ) /
			X_STEP;

		// Both of x's successors in one column, though zz's own depth is 1.
		expect( colOf( 'zz' ) ).toBe( colOf( 'w0' ) );
		expect( colOf( 'zz' ) ).toBeGreaterThan( 2 );
	} );

	it( 'pushes every sink (no outgoing) to the max-depth column, and an isolated node below the band', () => {
		// Sinks at mixed depths cluster rightmost; the edgeless _repl is no
		// part of the band and stacks under it at column 0.
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
		// Every sink lands in the rightmost column; _repl goes below.
		const maxCol = Math.max(
			...out.nodes.map( ( n ) => ( n.position.x - X_PAD ) / X_STEP )
		);
		expect( colOf( 'errors' ) ).toBe( maxCol );
		expect( colOf( 'completed' ) ).toBe( maxCol );
		expect( colOf( 'gyroscope' ) ).toBe( maxCol );
		expect( colOf( '_repl' ) ).toBe( 0 );
		const rowOf = ( id ) =>
			out.nodes.find( ( n ) => n.id === id ).position.y;
		expect( rowOf( '_repl' ) ).toBeGreaterThan(
			Math.max(
				...out.nodes
					.filter( ( n ) => '_repl' !== n.id )
					.map( ( n ) => n.position.y )
			)
		);
		// Internal nodes stay at their topological depth.
		expect( colOf( 'consumer' ) ).toBe( 0 );
		expect( colOf( 'tee' ) ).toBe( 1 );
		expect( colOf( 'request_builder' ) ).toBe( 2 );
		expect( colOf( 'completed_tee' ) ).toBeLessThan( maxCol );
	} );

	it( 'seats a source one column before the nearest node it feeds', () => {
		// jobintake_consumer feeds only job_router, two columns in; on column
		// 0 its wire would span the column between. The longest chain's head
		// still takes column 0, since its successor cannot move left.
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
		expect( colOf( 'jobintake_consumer' ) ).toBe(
			colOf( 'job_router' ) - 1
		);
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
			'topicprobe',
			'topicprobe:log',
			'settings:consumer',
			'settings-sync',
			'discovery-collector',
			'_repl',
		].map( ( id ) => ( { id } ) ),
		edges: [
			{ from: 'topicprobe', to: 'topicprobe:log' },
			{ from: 'settings:consumer', to: 'settings-sync' },
			...SPOKES.map( ( to ) => ( { from: 'settings-sync', to } ) ),
			...SPOKES.map( ( to ) => ( { from: 'discovery-collector', to } ) ),
			...SPOKES.map( ( from ) => ( { from, to: 'null' } ) ),
		],
	};

	it( 'keeps the fan in flow order with the sink it feeds to the right', () => {
		// Only `null` is a hub: twelve spokes feed it. The two feeders fan OUT
		// and stay in the fan's band with their spokes, consumer first, and
		// the hub takes the column past the band.
		const at = {};
		for ( const n of autoLayout( graph ).nodes ) {
			at[ n.id ] = n.position;
		}
		const spokeX = SPOKES.map( ( id ) => at[ id ].x );
		expect( at[ 'settings-sync' ].x ).toBeLessThan( Math.min( ...spokeX ) );
		expect( at[ 'discovery-collector' ].x ).toBeLessThan(
			Math.min( ...spokeX )
		);
		expect( at.null.x ).toBeGreaterThan( Math.max( ...spokeX ) );
		expect( at[ 'settings:consumer' ].x ).toBeLessThan(
			at[ 'settings-sync' ].x
		);
	} );

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

describe( 'autoLayout — hubs beside their feeders, blocks packed', () => {
	const positionsOf = ( graph ) =>
		Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
	const gridOf = ( graph ) => {
		const at = positionsOf( graph );
		return Object.fromEntries(
			Object.entries( at ).map( ( [ id, p ] ) => [
				id,
				{
					col: ( p.x - X_PAD ) / X_STEP,
					row: ( p.y - Y_PAD ) / Y_STEP,
				},
			] )
		);
	};

	const PUBS = [
		'aan',
		'bend',
		'cltampa',
		'dal',
		'elpaso',
		'flagstaff',
		'gotham',
		'hou',
	];
	const JOBS = [ 'import', 'patch', 'template', 'purge' ];

	// Publications, each with four two-node slices feeding its own hub, plus
	// one fleet hub every slice feeds and one hub-less pair.
	const pubs = ( count ) => {
		const edges = [];
		for ( const pub of PUBS.slice( 0, count ) ) {
			for ( const job of JOBS ) {
				edges.push(
					{
						from: `${ pub }:${ job }`,
						to: `${ pub }:${ job }:buffer`,
					},
					{ from: `${ pub }:${ job }:buffer`, to: `${ pub }:hub` },
					{ from: `${ pub }:${ job }:buffer`, to: 'fleet:cache' }
				);
			}
		}
		edges.push( { from: 'lone:in', to: 'lone:out' } );
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	it( 'puts each hub in the column right after the slices that feed it, on their middle row', () => {
		// Eight publications pack into several stacks, so a hub on a far
		// edge would sit columns away from most of its feeders.
		const g = gridOf( pubs( 8 ) );
		const stackStarts = new Set();
		for ( const pub of PUBS ) {
			const rows = JOBS.map(
				( job ) => g[ `${ pub }:${ job }:buffer` ].row
			);
			const cols = JOBS.map(
				( job ) => g[ `${ pub }:${ job }:buffer` ].col
			);
			expect( g[ `${ pub }:hub` ].col ).toBe( Math.max( ...cols ) + 1 );
			// On the middle row, or half a row off it where the fleet hub
			// shares the column and the two spread around the middle.
			const mid = ( Math.min( ...rows ) + Math.max( ...rows ) ) / 2;
			expect(
				Math.abs( g[ `${ pub }:hub` ].row - mid )
			).toBeLessThanOrEqual( 0.5 );
			stackStarts.add( Math.min( ...cols ) );
		}
		expect( stackStarts.size ).toBeGreaterThan( 1 );
	} );

	it( 'attaches a hub fed from several groups beside the group holding most of its feeders', () => {
		// fleet:cache is fed by every slice; each slice's own hub has fewer
		// feeders, so the slices group by publication and fleet:cache lands
		// beside one of them rather than on a far edge past everything.
		const g = gridOf( pubs( 8 ) );
		const pubCols = PUBS.map( ( pub ) => g[ `${ pub }:hub` ].col );
		expect( pubCols ).toContain( g[ 'fleet:cache' ].col );
	} );

	it( 'packs the blocks side by side toward a square canvas instead of one tall stack', () => {
		// Forty hub-less pairs: one stack would be 40 rows by 2 columns.
		const edges = [];
		for ( let i = 0; i < 40; i++ ) {
			edges.push( { from: `p${ i }:in`, to: `p${ i }:out` } );
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const xs = nodes.map( ( n ) => n.position.x );
		const ys = nodes.map( ( n ) => n.position.y );
		const width = Math.max( ...xs ) - Math.min( ...xs ) + X_STEP;
		const height = Math.max( ...ys ) - Math.min( ...ys ) + Y_STEP;
		expect( width / height ).toBeGreaterThan( 0.5 );
		expect( width / height ).toBeLessThan( 2 );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		expect( wiresThroughCards( nodes, edges ) ).toEqual( [] );
	} );

	it( "keeps a wire from a band straight to its hub off the band's own chain", () => {
		// chronogram's router feeds a two-step chain to the hub AND the hub
		// directly; the direct wire ran along the chain's row, through both
		// of its cards, because a wire to a hub is not a wire inside the band.
		const edges = [];
		for ( const job of JOBS ) {
			edges.push(
				{ from: `pub:${ job }`, to: `pub:${ job }:buffer` },
				{ from: `pub:${ job }:buffer`, to: 'pub:hub' }
			);
		}
		edges.push(
			{ from: 'pub:router', to: 'pub:balancer' },
			{ from: 'pub:balancer', to: 'korell:template' },
			{ from: 'korell:template', to: 'pub:hub' },
			{ from: 'pub:router', to: 'pub:hub' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		// The hub's fan-in still crosses the bands between it and the
		// router's; what must not happen is the wire through its own chain.
		expect(
			wiresThroughCards( nodes, edges ).filter( ( hit ) =>
				/over (pub:balancer|korell:template)$/.test( hit )
			)
		).toEqual( [] );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'packs equal-width blocks alphabetically', () => {
		// A hub block keyed by its hub, which sorts after the hub-less band
		// keyed by its first node; blocks arrive hub first, but the packer
		// takes them by key. Both are three wide, so width decides nothing.
		const edges = [
			{ from: 'm:in', to: 'm:mid' },
			{ from: 'm:mid', to: 'm:out' },
		];
		for ( const f of [ 'a0', 'a1', 'a2', 'a3' ] ) {
			edges.push(
				{ from: `${ f }:in`, to: `${ f }:mid` },
				{ from: `${ f }:mid`, to: 'zzz-hub' }
			);
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const g = gridOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( g[ 'm:in' ].row ).toBeLessThan( g[ 'a0:in' ].row );
	} );

	it( "keeps a card nudged off its hub wire clear of the next band's cards", () => {
		// s1 is a three-step chain whose head also feeds the hub; s0 is a
		// pair. Nudging s1's middle card must not land it half a row from
		// s0's, though s0 is another band.
		const edges = [
			{ from: 's0:a', to: 's0:b' },
			{ from: 's0:b', to: 'hub' },
			{ from: 's1:a', to: 's1:b' },
			{ from: 's1:b', to: 's1:c' },
			{ from: 's1:a', to: 'hub' },
			{ from: 's2:a', to: 'hub' },
			{ from: 's3:a', to: 'hub' },
		];
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'keeps a hub fed only by hubs beside them', () => {
		// Each feeder runs through a mid, so the fed nodes' median fan-in is
		// 1 and the four h's and a-top are hubs; a-top sorts before every h.
		const edges = [];
		for ( const h of [ 'h1', 'h2', 'h3', 'h4' ] ) {
			for ( const f of [ 'p', 'q', 'r', 's' ] ) {
				edges.push(
					{ from: `${ h }:${ f }`, to: `${ h }:${ f }:mid` },
					{ from: `${ h }:${ f }:mid`, to: h }
				);
			}
			edges.push( { from: h, to: 'a-top' } );
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const g = gridOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( g[ 'a-top' ].col ).toBe( g.h1.col + 1 );
	} );

	it( 'continues a chain past its hub: a band the hub feeds sits to the right of it', () => {
		// chronogram's job tees and its timeout feed the set_stream hub,
		// which feeds the router, whose chain runs on to the template
		// worker. The hub is not the end of that chain, so the router's
		// band goes right of it rather than wrapping a wire back to the left.
		const edges = [];
		for ( const job of JOBS ) {
			edges.push(
				{ from: `pub:${ job }`, to: `pub:${ job }:buffer` },
				{ from: `pub:${ job }:buffer`, to: 'pub:set_stream' }
			);
		}
		edges.push(
			{ from: 'pub:timeout', to: 'pub:set_stream' },
			{ from: 'pub:set_stream', to: 'pub:router' },
			{ from: 'pub:router', to: 'pub:balancer' },
			{ from: 'pub:balancer', to: 'korell:template' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const graph = { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
		const g = gridOf( graph );
		// The buffers' wires to the hub cross the bridge's column: it is
		// seated off their path, not on the hub's row in front of it.
		expect( wiresThroughCards( autoLayout( graph ).nodes, edges ) ).toEqual(
			[]
		);
		const buffers = JOBS.map( ( job ) => g[ `pub:${ job }:buffer` ].col );
		// The timeout's every neighbour is the hub, so it is a bridge: it
		// leads the hub chain, right after the buffers.
		expect( g[ 'pub:timeout' ].col ).toBe( Math.max( ...buffers ) + 1 );
		expect( g[ 'pub:set_stream' ].col ).toBe( g[ 'pub:timeout' ].col + 1 );
		expect( g[ 'pub:router' ].col ).toBe( g[ 'pub:set_stream' ].col + 1 );
		expect( g[ 'pub:balancer' ].col ).toBe( g[ 'pub:router' ].col + 1 );
		expect( g[ 'korell:template' ].col ).toBe(
			g[ 'pub:balancer' ].col + 1
		);
		// The chain hangs level with the hub, not off the block's top row.
		expect(
			Math.abs( g[ 'pub:router' ].row - g[ 'pub:set_stream' ].row )
		).toBeLessThanOrEqual( 0.5 );
	} );

	it( 'clears a stack of chains outward from the hub, not past each other', () => {
		// Twelve chains whose head feeds the hub directly. Cleared top-down
		// with "below first", a chain under the hub found the next chain in
		// its way and leapt past every chain beneath it; the block doubled.
		const edges = [];
		const n = 12;
		for ( let i = 0; i < n; i++ ) {
			const p = `p${ String( i ).padStart( 2, '0' ) }`;
			edges.push(
				{ from: `${ p }:router`, to: `${ p }:balancer` },
				{ from: `${ p }:balancer`, to: `${ p }:template` },
				{ from: `${ p }:template`, to: 'hub' },
				{ from: `${ p }:router`, to: 'hub' }
			);
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const g = gridOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		for ( let i = 0; i < n; i++ ) {
			const p = `p${ String( i ).padStart( 2, '0' ) }`;
			expect(
				Math.abs(
					g[ `${ p }:balancer` ].row - g[ `${ p }:router` ].row
				)
			).toBeLessThanOrEqual( 1 );
		}
		const rows = Object.values( g ).map( ( c ) => c.row );
		expect( Math.max( ...rows ) - Math.min( ...rows ) ).toBeLessThan(
			n + 2
		);
	} );

	it( 'keeps a wire from a hub into a consumer chain off the chain', () => {
		// The hub feeds the chain's tail directly as well as its head: the
		// direct wire skips the head and the middle, and was drawn through
		// both, since only wires INTO a hub were cleared.
		const edges = [];
		for ( const f of [ 'a', 'b', 'c', 'd' ] ) {
			edges.push(
				{ from: `${ f }:in`, to: `${ f }:mid` },
				{ from: `${ f }:mid`, to: 'hub' }
			);
		}
		edges.push(
			{ from: 'hub', to: 'c:a' },
			{ from: 'c:a', to: 'c:b' },
			{ from: 'c:b', to: 'c:c' },
			{ from: 'hub', to: 'c:c' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect(
			wiresThroughCards( nodes, edges ).filter( ( hit ) =>
				/over c:/.test( hit )
			)
		).toEqual( [] );
	} );

	it( 'leaves a small graph in one stack', () => {
		const g = gridOf( pubs( 2 ) );
		// Every block starts at column 0: nothing was packed to the right.
		const starts = [ 'aan:import', 'bend:import', 'lone:in' ].map(
			( id ) => g[ id ].col
		);
		expect( starts ).toEqual( [ 0, 0, 0 ] );
	} );

	// The hub-control topology: two producers fanning into one HTTP_Out per
	// spoke, every one of those feeding a Null, beside a topic probe pair and
	// the edgeless REPL partition.
	const SPOKES = Array.from(
		{ length: 24 },
		( _, i ) => `settings:s${ String( i ).padStart( 2, '0' ) }`
	);
	const hubControl = () => {
		const edges = [
			{ from: 'topicprobe', to: 'topicprobe:log' },
			{ from: 'settings:consumer', to: 'settings-sync' },
		];
		for ( const spoke of SPOKES ) {
			edges.push(
				{ from: 'settings-sync', to: spoke },
				{ from: 'discovery-collector', to: spoke },
				{ from: spoke, to: 'null' }
			);
		}
		const ids = new Set( [ '_repl' ] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	it( 'keeps a fan-out source beside its fan, not across the chain it shares', () => {
		// discovery-collector feeds only the spokes; on column 0 its 24
		// wires spanned column 1, and settings-sync was pushed past them all.
		const graph = hubControl();
		const g = gridOf( graph );
		const spokeRows = SPOKES.map( ( id ) => g[ id ].row );
		expect( g[ 'discovery-collector' ].col ).toBe(
			g[ SPOKES[ 0 ] ].col - 1
		);
		expect( g[ 'settings-sync' ].row ).toBe( g[ 'settings:consumer' ].row );
		expect( g[ 'settings-sync' ].row ).toBeLessThan(
			Math.max( ...spokeRows )
		);
		const { nodes } = autoLayout( graph );
		expect( wiresThroughCards( nodes, graph.edges ) ).toEqual( [] );
	} );

	it( "packs a small block into the room beside a tall block's feeders", () => {
		// The spoke column outgrows the square, so a second stack opened past
		// the hub for the probe pair and the REPL, far from everything else.
		const graph = hubControl();
		const g = gridOf( graph );
		const spokeRows = SPOKES.map( ( id ) => g[ id ].row );
		for ( const id of [ 'topicprobe', 'topicprobe:log', '_repl' ] ) {
			expect( g[ id ].col ).toBeLessThan( g.null.col );
			expect( g[ id ].row ).toBeGreaterThan( Math.min( ...spokeRows ) );
			expect( g[ id ].row ).toBeLessThan( Math.max( ...spokeRows ) );
		}
		const { nodes } = autoLayout( graph );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		expect( wiresThroughCards( nodes, graph.edges ) ).toEqual( [] );
	} );

	// Seeded random graphs whose packing once stacked a block onto one that
	// had taken room in the canvas, and ran a wire between blocks over it.
	const seedGraph = ( seed ) => ( {
		nodes: SEEDS[ seed ].nodes.map( ( id ) => ( { id } ) ),
		edges: SEEDS[ seed ].edges.map( ( [ from, to ] ) => ( { from, to } ) ),
	} );

	it.each( Object.keys( SEEDS ) )(
		'stacks no block onto one packed into room (seed %s)',
		( seed ) => {
			const { nodes } = autoLayout( seedGraph( seed ) );
			expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		}
	);

	it( 'packs an edgeless card clear of the wires between blocks', () => {
		const graph = seedGraph( '134623' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				/ over lone\d+$/.test( hit )
			)
		).toEqual( [] );
	} );

	it.each( [
		[ '29924', 'k1src', 'k1l2n0' ],
		[ '82291', 'k2src', 'k2l4n0' ],
	] )(
		'keeps a source near the one node it feeds, its wire clear (seed %s)',
		( seed, source, fed ) => {
			// A hub wire or a crowded column once stranded each four or five
			// rows off; where no seat within a row keeps the wire off every
			// card, the cheapest clear one is still close.
			const graph = seedGraph( seed );
			const g = gridOf( graph );
			expect(
				Math.abs( g[ source ].row - g[ fed ].row )
			).toBeLessThanOrEqual( 3 );
			const { nodes } = autoLayout( graph );
			expect(
				wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
					hit.startsWith( `${ source }→` )
				)
			).toEqual( [] );
		}
	);

	it( 'reseats a source clear of the long wires inside its own band', () => {
		// The hub-wire reseat saw only hub wires, and put k1src on the wire
		// from k1l0n0 to k1l1n2 in its own band.
		const graph = seedGraph( '52367' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				/ over k1src$/.test( hit )
			)
		).toEqual( [] );
	} );

	it( 'reseats a source after the hub wires have moved what it feeds', () => {
		// Reseated before the hub pass moved k2l4n0 down, k2src was left a
		// four-column wire through four cards away from it.
		const graph = seedGraph( '14962' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				hit.startsWith( 'k2src→' )
			)
		).toEqual( [] );
	} );

	it( "runs a consumer band's source wire back to its hub clear of the band", () => {
		// k4src feeds hub0 and a node in the band hub0 feeds. Seated before
		// that node, it ran its wire back to hub0 across the band's cards.
		const graph = seedGraph( 'c71271' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				hit.startsWith( 'k4src→' )
			)
		).toEqual( [] );
	} );

	it( 'keeps the cards off the long wires of a node only a hub feeds', () => {
		// a is fed by the hub alone, so inside its band it had no feeder:
		// taken for a source, its wire to c took no placeholder and ran
		// through b.
		const edges = [ 0, 1, 2, 3, 4 ].map( ( i ) => ( {
			from: `f${ i }`,
			to: 'hub',
		} ) );
		edges.push(
			{ from: 'hub', to: 'a' },
			{ from: 'a', to: 'b' },
			{ from: 'b', to: 'c' },
			{ from: 'a', to: 'c' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( wiresThroughCards( nodes, edges ) ).toEqual( [] );
	} );

	it( 'keeps a source wired out of its block in the column its band gave it', () => {
		// k6src sits right of its hub, in a band that hub feeds; sent to the
		// block's first column, its wires crossed the hub and the feeders.
		const graph = seedGraph( 'c134623' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				hit.startsWith( 'k6src→' )
			)
		).toEqual( [] );
	} );

	it( 'keeps a source wired out of its block from crossing the blocks between', () => {
		// hub0 sits in another block, out of the seat pass's sight; seated
		// by its in-block fan, k3l0n0 moved right and its wire back to hub0
		// crossed seventeen cards of the blocks between.
		const graph = seedGraph( '703214' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				hit.startsWith( 'k3l0n0→hub0' )
			)
		).toEqual( [] );
	} );

	const chain = ( pairs ) => {
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = new Set( pairs.flat() );
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	it( 'keeps the placeholders of a source that feeds more than one column', () => {
		// k2l0n0 feeds columns 2 and 4. Seated last, its wires lost their
		// placeholders, and those to column 4 ran over two of its own
		// successors in column 2.
		const graph = seedGraph( '82291' );
		const { nodes } = autoLayout( graph );
		expect(
			wiresThroughCards( nodes, graph.edges ).filter( ( hit ) =>
				hit.startsWith( 'k2l0n0→' )
			)
		).toEqual( [] );
	} );

	it( 'seats a source left of every node it feeds', () => {
		// s feeds a1 and a3; seated by cost alone it took column 2, above
		// a2, and drew its wire to a1 backward.
		const g = gridOf(
			chain( [
				[ 's', 'a1' ],
				[ 'a1', 'a2' ],
				[ 'a2', 'a3' ],
				[ 's', 'a3' ],
			] )
		);
		expect( g.s.col ).toBeLessThan( g.a1.col );
	} );

	it( 'keeps a chain off the wire of a source that skips down it', () => {
		// s sits beside a1 and also feeds a4: no seat keeps s→a4 off the
		// chain, so the chain has to step aside, as it does for any wire.
		const graph = chain( [
			[ 's', 'a1' ],
			[ 'a1', 'a2' ],
			[ 'a2', 'a3' ],
			[ 'a3', 'a4' ],
			[ 's', 'a4' ],
			[ 's', 'b1' ],
			[ 'b1', 'b2' ],
		] );
		const { nodes } = autoLayout( graph );
		expect( wiresThroughCards( nodes, graph.edges ) ).toEqual( [] );
	} );

	it( 'keeps a source in a band its hub feeds right of that hub', () => {
		// k6src feeds hub0 and its own band, which hub0 feeds; the fallback
		// sent it left of hub0, and its band wire crossed the hub's column.
		const g = gridOf( seedGraph( 'c190056' ) );
		expect( g.k6src.col ).toBeGreaterThan( g.hub0.col );
	} );

	it( 'keeps a sink fed only by a source level with it', () => {
		// zz has no feeder but x, so no sweep could seat it from x while x
		// had no row, and it dropped to the bottom of its column.
		const edges = [];
		for ( let i = 0; i < 6; i++ ) {
			edges.push( { from: 's', to: `m${ i }` } );
			edges.push( { from: `m${ i }`, to: i < 3 ? 'n0' : 'n5' } );
		}
		for ( let i = 0; i < 3; i++ ) {
			edges.push(
				{ from: `m${ i + 3 }`, to: `p${ i }` },
				{ from: `p${ i }`, to: `q${ i }` }
			);
		}
		edges.push(
			{ from: 'n0', to: 'w0' },
			{ from: 'n5', to: 'z5' },
			{ from: 'x', to: 'w0' },
			{ from: 'x', to: 'zz' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const g = gridOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( Math.abs( g.zz.row - g.x.row ) ).toBeLessThanOrEqual( 1 );
	} );

	it( 'seats a source right of the widest column beside what it feeds', () => {
		// x feeds only w0, so it takes column 2, right of the six-card column
		// the rows spring from, and no sweep seeds it: stacked under its
		// column's p cards it sat rows from w0, and a re-spread to seat it
		// moved n0 after w0 had centred on it.
		const edges = [];
		for ( let i = 0; i < 6; i++ ) {
			edges.push( { from: 's', to: `m${ i }` } );
			edges.push( { from: `m${ i }`, to: i < 3 ? 'n0' : 'n5' } );
		}
		for ( let i = 0; i < 3; i++ ) {
			edges.push(
				{ from: `m${ i + 3 }`, to: `p${ i }` },
				{ from: `p${ i }`, to: `q${ i }` }
			);
		}
		edges.push(
			{ from: 'n0', to: 'w0' },
			{ from: 'n5', to: 'z5' },
			{ from: 'x', to: 'w0' }
		);
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const g = gridOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( g.x.col ).toBe( g.w0.col - 1 );
		expect( Math.abs( g.x.row - g.w0.row ) ).toBeLessThanOrEqual( 1 );
		expect( g.n0.row ).toBe( g.w0.row );
	} );
} );

describe( 'autoLayout — hub bands', () => {
	// A browser-realm-shaped graph: five polled slices, five receiver slices,
	// and the four backbone nodes every slice is wired into.
	//
	// Fan-in over the non-dangling edges, which is what hub detection reads:
	//   X:tee 1, X:fetch 1, X:result 1, X:view 1, _http 1,
	//   _shell 5 (the fetches), _output 6 (5 results and _http),
	//   _cwd 6 (5 fetches and _metadata).
	// The median fan-in of the fed nodes is 1, so the cut is max( 4, 3 ) = 4
	// and exactly _shell, _output and _cwd clear it; a fetch at 1 does not,
	// and _http and _metadata are bridges: every neighbour they have is a hub.
	const POLL_SLICES = [ 'a', 'b', 'd', 'e', 'f' ];
	const VIEW_SLICES = [ 'c', 'g', 'h', 'i', 'j' ];

	const hubGraph = () => {
		const edges = [];
		for ( const s of POLL_SLICES ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: `${ s }:result` },
				{ from: `${ s }:fetch`, to: '_shell' },
				{ from: `${ s }:fetch`, to: '_cwd' },
				{ from: `${ s }:result`, to: '_output' }
			);
		}
		for ( const s of VIEW_SLICES ) {
			edges.push( { from: `${ s }:in`, to: `${ s }:view` } );
		}
		edges.push(
			{ from: '_shell', to: '_http' },
			{ from: '_http', to: '_output' },
			{ from: '_metadata', to: '_cwd' }
		);
		const ids = new Set( [ '_heartbeat' ] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	const positionsOf = ( graph ) => {
		const out = {};
		for ( const n of autoLayout( graph ).nodes ) {
			out[ n.id ] = n.position;
		}
		return out;
	};

	it( 'keeps each slice on one row, unstretched, with the hubs to the right', () => {
		const at = positionsOf( hubGraph() );

		// A slice runs straight across one row up to its fetch; the result
		// steps half a row off it, since the fetch's wire to the hubs runs
		// on past the result's column and would be drawn through it.
		const sliceA = [ 'a:timer', 'a:tee', 'a:fetch' ];
		expect( new Set( sliceA.map( ( id ) => at[ id ].y ) ).size ).toBe( 1 );
		expect( Math.abs( at[ 'a:result' ].y - at[ 'a:fetch' ].y ) ).toBe(
			Y_STEP / 2
		);

		// Each slice gets its own band.
		const bandY = [ ...POLL_SLICES, ...VIEW_SLICES ].map(
			( s ) =>
				at[ `${ s }:${ POLL_SLICES.includes( s ) ? 'tee' : 'in' }` ].y
		);
		expect( new Set( bandY ).size ).toBe( bandY.length );

		// A two-node slice spans two columns, not the whole graph's depth.
		expect( at[ 'c:view' ].x ).toBe( at[ 'c:in' ].x + X_STEP );

		// Every fed hub sits right of every band, and so does a bridge — a
		// node whose every neighbour is a hub — rather than stacking as a loner.
		const backbone = [ '_shell', '_http', '_output', '_cwd', '_metadata' ];
		const fetchX = POLL_SLICES.map( ( s ) => at[ `${ s }:fetch` ].x );
		for ( const id of backbone ) {
			expect( at[ id ].x ).toBeGreaterThan( Math.max( ...fetchX ) );
		}
		expect( at._cwd.x ).toBeGreaterThan( at._metadata.x );

		// The hub chain _shell -> _http -> _output takes three columns.
		expect( at._output.x ).toBeGreaterThan( at._http.x );
		expect( at._http.x ).toBeGreaterThan( at._shell.x );

		// An edgeless node is the narrowest block, so it packs last: into
		// room the canvas already has, clear of every card, before any new
		// stack opens past the hubs.
		const others = Object.entries( at )
			.filter( ( [ id ] ) => '_heartbeat' !== id )
			.map( ( [ , p ] ) => p );
		expect( at._heartbeat.x ).toBeLessThanOrEqual(
			Math.max( ...others.map( ( p ) => p.x ) )
		);
		expect( at._heartbeat.y ).toBeLessThanOrEqual(
			Math.max( ...others.map( ( p ) => p.y ) )
		);
		expect(
			minColumnGap( autoLayout( hubGraph() ).nodes )
		).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'lays the same graph out identically whatever order the nodes arrive in', () => {
		const graph = hubGraph();
		const shuffled = {
			nodes: [ ...graph.nodes ].reverse(),
			edges: graph.edges,
		};
		expect( positionsOf( shuffled ) ).toEqual( positionsOf( graph ) );
	} );

	// A star of `spokes` feeders into `hub`, beside a chain and a pair. One
	// feeder short of the cut the hub stays in its star's band; one edge
	// later it leaves for the backbone. A fan OUT of the same size is a
	// wire: its consumers order with the flow.
	const starGraph = ( spokes, fanOut = false ) => {
		const edges = [
			{ from: 'c1', to: 'c2' },
			{ from: 'c2', to: 'c3' },
			{ from: 'x', to: 'y' },
		];
		for ( let i = 0; i < spokes; i++ ) {
			edges.push(
				fanOut
					? { from: 'hub', to: `s${ i }` }
					: { from: `s${ i }`, to: 'hub' }
			);
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	// Every component bands, hub or no hub: a two-node slice never stretches
	// to another component's depth. A hub leaves its component for the column
	// right after its feeders, on their middle row; an ordinary node stays.
	it( 'bands every component, and leaves a node three feed in its band', () => {
		const at = positionsOf( starGraph( 3 ) );
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		expect( at.hub.x ).toBe( at.s0.x + X_STEP );
	} );

	it( 'treats a node four feed as a hub, beside its feeders on their middle row', () => {
		const at = positionsOf( starGraph( 4 ) );
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		const feeders = [ 's0', 's1', 's2', 's3' ].map( ( id ) => at[ id ] );
		expect( at.hub.x ).toBe(
			Math.max( ...feeders.map( ( p ) => p.x ) ) + X_STEP
		);
		const ys = feeders.map( ( p ) => p.y );
		expect( at.hub.y ).toBe(
			( Math.min( ...ys ) + Math.max( ...ys ) ) / 2
		);
	} );

	it( 'leaves a node fanning out to seven in its band: only fan-in makes a hub', () => {
		const at = positionsOf( starGraph( 7, true ) );
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		expect( at.hub.x ).toBe( at.s0.x - X_STEP );
	} );

	// The debug sheet as a log-viewer realm draws it: two polled slices, so
	// the widest fan-in is two and nothing is a hub. The three-node chains
	// still take three columns each, on rows of their own.
	it( 'bands a hubless sheet: no chain stretches to the far column', () => {
		const edges = [
			{ from: 'log-viewer:link', to: 'log-viewer:stream' },
			{ from: 'log-viewer:stream', to: 'log-viewer:view' },
			{ from: '_heartbeat', to: '_http' },
			{ from: '_http', to: '_output' },
			{ from: '_metadata', to: '_cwd' },
		];
		for ( const s of [ 'log-viewer-step', 'log-viewer-catalog' ] ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` },
				{ from: `${ s }:fetch`, to: '_shell' },
				{ from: `${ s }:fetch`, to: '_cwd' }
			);
		}
		const ids = new Set( [ '_completion', '_stdout', 'log-rail:timer' ] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const at = positionsOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );

		expect( at[ 'log-viewer:view' ].x ).toBe(
			at[ 'log-viewer:link' ].x + 2 * X_STEP
		);
		expect( at._output.x ).toBe( at._heartbeat.x + 2 * X_STEP );
		// Each chain runs across one row, and the two share none with the slices.
		expect( at[ 'log-viewer:view' ].y ).toBe( at[ 'log-viewer:link' ].y );
		expect( at._output.y ).toBe( at._heartbeat.y );
		const sliceYs = [ 'step', 'catalog' ].flatMap( ( s ) =>
			[ 'timer', 'tee', 'fetch', 'in', 'result' ].map(
				( p ) => at[ `log-viewer-${ s }:${ p }` ].y
			)
		);
		for ( const y of [ at[ 'log-viewer:link' ].y, at._heartbeat.y ] ) {
			expect( sliceYs ).not.toContain( y );
		}
	} );

	// The station's own realm as the debug sheet draws it: five polled slices
	// whose fetchers all target `_shell`, which feeds nothing back. One
	// layering cannot hold a slice together here: the sweep against the flow
	// keys every feeder of `_shell` alike, so a slice's `in` and `timer`
	// come apart. Nothing in it reaches a fan-in of six.
	const debugRealm = () => {
		const edges = [];
		const slices = [
			'workers:restart',
			'topology-manager',
			'topologies:deactivate',
			'topologies:activate',
			'worker-status',
		];
		for ( const s of slices ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: '_shell' },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` }
			);
		}
		edges.push(
			{ from: 'topicprobe:link', to: 'topicprobe:stream' },
			{ from: 'topicprobe:stream', to: 'topicprobe:view' },
			{ from: '_metadata', to: '_cwd' },
			{ from: '_heartbeat', to: '_http' },
			{ from: '_http', to: '_output' }
		);
		const ids = new Set( [ '_completion', '_stdout', 'freshness:timer' ] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { slices, nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	it( 'keeps each of five slices sharing one egress together, in its own band', () => {
		const { slices, ...graph } = debugRealm();
		const at = positionsOf( graph );
		const spans = slices.map( ( s ) => {
			const ys = [ 'timer', 'tee', 'fetch', 'in', 'result' ].map(
				( part ) => at[ `${ s }:${ part }` ].y
			);
			return [ Math.min( ...ys ), Math.max( ...ys ) ];
		} );
		// A slice spans two rows at most, and no slice starts inside another.
		for ( const [ lo, hi ] of spans ) {
			expect( hi - lo ).toBeLessThanOrEqual( 1.5 * Y_STEP );
		}
		const sorted = [ ...spans ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		for ( let i = 1; i < sorted.length; i++ ) {
			expect( sorted[ i ][ 0 ] ).toBeGreaterThan( sorted[ i - 1 ][ 1 ] );
		}
		// The egress sits right of every slice.
		for ( const s of slices ) {
			expect( at._shell.x ).toBeGreaterThan( at[ `${ s }:fetch` ].x );
		}
	} );

	it( 'holds a much-fed node to three times the median, so a dense graph stays one component', () => {
		// 6 sources x 6 sinks fully connected: every sink has a fan-in of 6,
		// the median over the fed nodes is 6, and the cut is 18 — no hub.
		// Plus a two-node component so a banded layout would be visible.
		const sources = [ 'p0', 'p1', 'p2', 'p3', 'p4', 'p5' ];
		const sinks = [ 'q0', 'q1', 'q2', 'q3', 'q4', 'q5' ];
		const edges = [ { from: 'x', to: 'y' } ];
		for ( const from of sources ) {
			for ( const to of sinks ) {
				edges.push( { from, to } );
			}
		}
		const at = positionsOf( {
			nodes: [ ...sources, ...sinks, 'x', 'y' ].map( ( id ) => ( {
				id,
			} ) ),
			edges,
		} );
		for ( const id of [ ...sources, 'x' ] ) {
			expect( at[ id ].x ).toBe( X_PAD );
		}
		for ( const id of [ ...sinks, 'y' ] ) {
			expect( at[ id ].x ).toBe( X_PAD + X_STEP );
		}
	} );
} );
