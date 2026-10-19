/**
 * Tests for autoLayout — column layout, barycenter ordering, snap, conflict.
 */

import {
	autoLayout,
	drawnCost,
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
 * The drawn cost of a laid-out graph, read off its positioned nodes.
 *
 * @param {Array<Object>} nodes Positioned nodes.
 * @param {Array<Object>} edges The wires.
 * @return {{crossings: string[], over: string[]}} What `drawnCost` reports.
 */
const drawn = ( nodes, edges ) =>
	drawnCost(
		Object.fromEntries( nodes.map( ( n ) => [ n.id, n.position ] ) ),
		edges
	);

/**
 * A graph written as `a>b c>d …`.
 *
 * @param {string} wires The wires, space-separated.
 * @return {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} The graph.
 */
const wired = ( wires ) => {
	const pairs = wires.split( ' ' ).map( ( p ) => p.split( '>' ) );
	return {
		nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
		edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
	};
};

/**
 * Lay out a graph written as `a>b c>d …`.
 *
 * @param {string} wires The wires, space-separated.
 * @return {{at: Object<string,{x: number, y: number}>, edges: Array<Object>}}
 * Each card's canvas position, and the wires.
 */
const laidOut = ( wires ) => {
	const graph = wired( wires );
	const { nodes } = autoLayout( graph );
	return {
		at: Object.fromEntries( nodes.map( ( n ) => [ n.id, n.position ] ) ),
		edges: graph.edges,
	};
};

/**
 * Lay out a graph written as `a>b c>d …` and read each card's canvas x.
 *
 * @param {string} wires The wires, space-separated.
 * @return {Object<string,number>} Canvas x by id.
 */
const xsOf = ( wires ) =>
	Object.fromEntries(
		Object.entries( laidOut( wires ).at ).map( ( [ id, p ] ) => [
			id,
			p.x,
		] )
	);

describe( 'drawnCost — the one judge of a drawing', () => {
	const wire = ( from, to ) => ( { from, to } );
	// Three columns, rows half a step apart: the lattice a layout lands on.
	const cell = ( c, r ) => ( {
		x: X_PAD + c * X_STEP,
		y: Y_PAD + r * Y_STEP,
	} );

	it( 'names each pair of wires whose order flips across the span both run', () => {
		const at = {
			a: cell( 0, 0 ),
			b: cell( 1, 1 ),
			c: cell( 0, 1 ),
			d: cell( 1, 0 ),
		};
		expect(
			drawnCost( at, [ wire( 'a', 'b' ), wire( 'c', 'd' ) ] ).crossings
		).toEqual( [ 'a→b × c→d' ] );
	} );

	it( 'never crosses two wires sharing a card, nor two that keep their order', () => {
		const at = {
			a: cell( 0, 0 ),
			b: cell( 1, 1 ),
			c: cell( 1, 0 ),
			d: cell( 0, 2 ),
			e: cell( 1, 3 ),
		};
		const wires = [ wire( 'a', 'b' ), wire( 'a', 'c' ), wire( 'd', 'e' ) ];
		expect( drawnCost( at, wires ).crossings ).toEqual( [] );
	} );

	it( 'reads a backward wire as the segment it draws', () => {
		const at = {
			a: cell( 1, 0 ),
			b: cell( 0, 1 ),
			c: cell( 0, 0 ),
			d: cell( 1, 1 ),
		};
		expect(
			drawnCost( at, [ wire( 'a', 'b' ), wire( 'c', 'd' ) ] ).crossings
		).toEqual( [ 'a→b × c→d' ] );
	} );

	it( 'runs a wire over a card within the clearance the layout keeps', () => {
		// The layout keeps a card half a row off a wire, so 50px is on it
		// and a half row (55px) is clear: the judge holds the same margin.
		const at = {
			s: cell( 0, 0 ),
			t: cell( 2, 0 ),
			near: { x: X_PAD + X_STEP, y: Y_PAD + 50 },
			clear: cell( 1, 0.5 ),
			end: cell( 2, 0.25 ),
		};
		expect( drawnCost( at, [ wire( 's', 't' ) ] ).over ).toEqual( [
			's→t over near',
		] );
	} );

	it( 'lists the cards under each wire column by column, top to bottom', () => {
		// Inserted out of order; whole rows put the band's edges on a card
		// exactly, and a card on either edge, or in an end column, is clear.
		const at2 = ( c, r ) => ( { x: X_PAD + c * X_STEP, y: r * Y_STEP } );
		const at = {
			c2: at2( 2, 2 ),
			s: at2( 0, 2 ),
			t: at2( 3, 2 ),
			below: at2( 1, 2.25 ),
			above: at2( 1, 1.75 ),
			topEdge: at2( 1, 1.5 ),
			bottomEdge: at2( 2, 2.5 ),
			u: at2( 1, 5 ),
			v: at2( 3, 5 ),
			w2: at2( 2, 5 ),
			beside: at2( 1, 5.25 ),
		};
		expect(
			drawnCost( at, [ wire( 'u', 'v' ), wire( 's', 't' ) ] ).over
		).toEqual( [
			's→t over above',
			's→t over below',
			's→t over c2',
			'u→v over w2',
		] );
	} );

	it( 'ignores a wire whose ends share a column', () => {
		const at = { a: cell( 0, 0 ), b: cell( 0, 2 ), m: cell( 0, 1 ) };
		expect( drawnCost( at, [ wire( 'a', 'b' ) ] ) ).toEqual( {
			crossings: [],
			over: [],
		} );
	} );

	it( 'never crosses two wires meeting at a card off the lattice', () => {
		// Read along a→c by its slope, c's row rounds 3e-14 off c.
		const at = {
			a: { x: 0, y: 912 / 7 },
			b: { x: 120, y: 908 / 9 },
			c: { x: 360, y: 577 / 3 },
		};
		expect(
			drawnCost( at, [ wire( 'a', 'c' ), wire( 'b', 'c' ) ] ).crossings
		).toEqual( [] );
	} );

	it( 'names the very pairs, in order, that checking every pair finds', () => {
		// Half columns and half rows crowd the lattice with shared cards,
		// collinear wires and crossings exactly on a column.
		let seed = 0x5eed;
		const rand = () => {
			seed = ( seed + 0x6d2b79f5 ) | 0;
			let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
			t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
			return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
		};
		const pick = ( n ) => Math.floor( rand() * n );
		const yAt = ( s, x ) =>
			s.p.y + ( ( s.q.y - s.p.y ) * ( x - s.p.x ) ) / ( s.q.x - s.p.x );
		const pairwise = ( at, wires ) => {
			const segs = wires
				.map( ( w ) => {
					const [ p, q ] = [ at[ w.from ], at[ w.to ] ].sort(
						( a, b ) => a.x - b.x
					);
					return { w, p, q };
				} )
				.filter( ( s ) => s.p.x !== s.q.x )
				.sort( ( a, b ) => a.p.x - b.p.x );
			const found = [];
			segs.forEach( ( a, i ) =>
				segs.slice( i + 1 ).forEach( ( b ) => {
					const lo = b.p.x;
					const hi = Math.min( a.q.x, b.q.x );
					const shared = [ a.w.from, a.w.to ].some(
						( id ) => id === b.w.from || id === b.w.to
					);
					if (
						lo < hi &&
						! shared &&
						( yAt( a, lo ) - yAt( b, lo ) ) *
							( yAt( a, hi ) - yAt( b, hi ) ) <
							0
					) {
						found.push(
							`${ a.w.from }→${ a.w.to } × ${ b.w.from }→${ b.w.to }`
						);
					}
				} )
			);
			return found;
		};
		// Sparse drawings make small groups of wires sharing end columns;
		// three columns of hundreds of wires make large ones.
		for ( const [ trials, cards, columns, count, least ] of [
			[ 200, 24, 9, 40, 1000 ],
			[ 10, 90, 3, 400, 50000 ],
		] ) {
			let crossed = 0;
			for ( let trial = 0; trial < trials; trial++ ) {
				/** @type {Object<string,{x: number, y: number}>} */
				const at = {};
				for ( let c = 0; c < cards; c++ ) {
					at[ `n${ c }` ] = cell(
						pick( columns ) / 2,
						pick( 13 ) / 2
					);
				}
				const ids = Object.keys( at );
				const wires = Array.from( { length: count }, () =>
					wire( ids[ pick( ids.length ) ], ids[ pick( ids.length ) ] )
				);
				const expected = pairwise( at, wires );
				crossed += expected.length;
				expect( drawnCost( at, wires ).crossings ).toEqual( expected );
			}
			expect( crossed ).toBeGreaterThan( least );
		}
	} );
} );

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
		expect( drawn( nodes, edges ).over ).toEqual( [] );
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
		expect( drawn( nodes, edges ).over ).toEqual( [] );
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
		expect( drawn( nodes, edges ).over ).toEqual( [] );
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
	// @longform `tee1` and `tee3` both drain `_output`, and `tee2` drains it as
	// well as `_cwd`, so the three tees and both sinks are one block rather
	// than two the packer placed apart. The tees order by their own feeders —
	// `_metadata` on top, then the echo pair, then `performance:command` — and
	// the edgeless cards stack a row apart below the band at its first
	// column, an empty row clear of it. The tees' wires to `_output` skip a
	// column, so no half step opens before it.
	const graphAExpected3 = {
		_completion: { x: 60, y: 740 },
		_cwd: { x: 540, y: 80 },
		_http: { x: 60, y: 850 },
		_metadata: { x: 60, y: 135 },
		_output: { x: 780, y: 300 },
		echo1: { x: 60, y: 245 },
		echo2: { x: 60, y: 355 },
		'performance:command': { x: 60, y: 465 },
		'performance:view': { x: 540, y: 520 },
		tee1: { x: 300, y: 465 },
		tee2: { x: 300, y: 135 },
		tee3: { x: 300, y: 300 },
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
	// @longform Only `completed:tee` sits in the column after `request-builder`,
	// so its four wires open no half step. The request fan leads, the tee at
	// `completed:partition`'s shoulder, and the job chain runs along the foot,
	// with `_repl` a row clear of it.
	const graphBExpected = {
		_repl: { x: 60, y: 740 },
		'completed:partition': { x: 1020, y: 80 },
		'completed:tee': { x: 780, y: 135 },
		'errors:partition': { x: 1020, y: 300 },
		'firehose:consumer': { x: 60, y: 410 },
		'firehose:tee': { x: 300, y: 410 },
		'gyroscope:partition': { x: 1020, y: 190 },
		'job-router': { x: 540, y: 520 },
		'jobintake:consumer': { x: 300, y: 520 },
		'jobs:partition': { x: 1020, y: 520 },
		'request-builder': { x: 540, y: 300 },
		'requests:partition': { x: 1020, y: 410 },
	};
	it( 'lays out the firehose worker graph (graph B) — already satisfied', () => {
		const got = normalize( posMapOf( autoLayout( graphB ).nodes ) );
		expect( got ).toEqual( normalize( graphBExpected ) );
	} );

	it( 'lays out the performance dashboard graph (graph A)', () => {
		const got = normalize( posMapOf( autoLayout( graphA ).nodes ) );
		expect( got ).toEqual( normalize( graphAExpected3 ) );
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
			expect( got ).toEqual( normalize( graphAExpected3 ) );
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

	it( 'grids a graph whose every edge dangles, as it grids an edgeless one', () => {
		const dangling = [
			{ from: 'echo', to: 'ghost-sink' },
			{ from: 'ghost-source', to: 'alpha' },
		];
		const out = autoLayout( {
			nodes: [
				{ id: 'echo' },
				{ id: 'charlie' },
				{ id: 'alpha' },
				{ id: 'delta' },
				{ id: 'bravo' },
			],
			edges: dangling,
		} );
		const at = Object.fromEntries(
			out.nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at ).toEqual( {
			alpha: { x: X_PAD, y: Y_PAD },
			bravo: { x: X_PAD, y: Y_PAD + Y_STEP },
			charlie: { x: X_PAD, y: Y_PAD + 2 * Y_STEP },
			delta: { x: X_PAD + X_STEP, y: Y_PAD },
			echo: { x: X_PAD + X_STEP, y: Y_PAD + Y_STEP },
		} );
		expect( out.edges ).toBe( dangling );
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

	it( 'stacks a sink no sweep seats on the edge of its column nearer its feeder', () => {
		// a feeds nothing, left of the column holding the most cards, so no
		// sweep gives it a row; e, which feeds it, sits above i, which feeds
		// d, so a stacks above d and e's wire to it crosses none of i's.
		const { at, edges } = laidOut( 'd>g e>a e>c i>c i>d i>g i>h' );
		expect( at.a.y ).toBeLessThan( at.d.y );
		expect(
			drawnCost( at, edges ).crossings.filter( ( hit ) =>
				hit.includes( 'e→a' )
			)
		).toEqual( [] );
	} );

	it( 'stacks the sinks no sweep seats above in the order of their feeders', () => {
		// a and b feed nothing and both stack above d; e, feeding a, sits
		// above f, feeding b, so a stacks above b and their wires stay apart.
		const { at, edges } = laidOut(
			'd>g e>a f>b e>c f>c i>c i>d i>g i>h i>k'
		);
		expect( at.a.y ).toBeLessThan( at.b.y );
		expect( at.b.y ).toBeLessThan( at.d.y );
		expect(
			drawnCost( at, edges ).crossings.filter( ( hit ) =>
				hit.includes( 'e→a' )
			)
		).toEqual( [] );
	} );

	it( 'stacks the sinks no sweep seats on one edge in the order of their feeders', () => {
		// d and k feed nothing and stack together on the edge of their
		// column away from g; b, feeding d, sits above a, feeding k, so d
		// stacks above k and their wires stay apart.
		const { at, edges } = laidOut(
			'a>g a>k b>c b>d b>e b>f c>i e>j f>i g>h g>i g>j h>j'
		);
		expect( at.k.y ).toBeLessThan( at.g.y );
		expect( at.d.y ).toBeLessThan( at.k.y );
		expect(
			drawnCost( at, edges ).crossings.filter( ( hit ) =>
				hit.includes( 'a→k' )
			)
		).toEqual( [] );
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
				{ id: 'topologies:shell' },
			],
			edges: [
				{ from: 'quokka:timer', to: 'quokka:tee' },
				{ from: 'quokka:tee', to: 'quokka:fetch' },
				{ from: 'quokka:in', to: 'quokka:fetch' },
				{ from: 'quokka:in', to: 'quokka:view' },
				{ from: 'quokka:fetch', to: 'topologies:shell' },
			],
		} );
		const colOf = ( id ) =>
			( out.nodes.find( ( n ) => n.id === id ).position.x - X_PAD ) /
			X_STEP;

		// The view shares `quokka:in` with the fetcher, so it shares its column.
		expect( colOf( 'quokka:view' ) ).toBe( colOf( 'quokka:fetch' ) );
		// `topologies:shell` shares its feeder with nobody: one column past that feeder.
		expect( colOf( 'topologies:shell' ) ).toBe(
			colOf( 'quokka:fetch' ) + 1
		);
	} );

	it( 'raises a sink to the furthest consumer sharing its feeder', () => {
		// `zz` is one column deep and `w0` five, both fed by `x`. Seating `zz`
		// by its own depth alone would split `x`'s successors across columns,
		// and a source whose successors span columns is not a pair to seat level
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

	it( 'seats a sink beside its feeder, in the column of the consumer it shares it with, and an isolated node below the band', () => {
		// errors shares request_builder with completed_tee, so it sits in
		// completed_tee's column, short of the band's last; the edgeless _repl
		// does not count toward the band and stacks under it at column 0.
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
		const maxCol = Math.max(
			...out.nodes.map( ( n ) => ( n.position.x - X_PAD ) / X_STEP )
		);
		expect( colOf( 'errors' ) ).toBe( colOf( 'completed_tee' ) );
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

	it( 'seats every card left of each card it feeds', () => {
		// y's sinks sit beside it, short of the long chain's last column, so y
		// relaxes toward that chain no further than the column before them.
		const wires = 'a0>a1 a1>a2 a2>a3 a3>a4 a4>a5 a2>y y>s1 y>s2 y>s3';
		const x = xsOf( wires );
		expect(
			wires
				.split( ' ' )
				.map( ( p ) => p.split( '>' ) )
				.filter( ( [ from, to ] ) => x[ from ] >= x[ to ] )
		).toEqual( [] );
	} );

	it( 'seats a sink in the column of an interior sibling a loop holds', () => {
		// n0 and n1 form a loop; n3 feeds n0 and the sink n4, which sits
		// beside n3 in n0's column.
		const x = xsOf( 'n5>n1 n3>n0 n1>n0 n3>n4 n2>n5 n0>n1' );
		expect( x.n4 ).toBe( x.n0 );
		expect( x.n4 ).toBeGreaterThan( x.n3 );
	} );

	it( 'seats a sink past a feeder inside a loop', () => {
		// n1, n2 and n6 form a loop; n2 feeds n1 and the sink n4.
		const x = xsOf(
			'n2>n4 n6>n2 n2>n1 n7>n0 n1>n6 n5>n2 n3>n7 n3>n0 n5>n7 n5>n1'
		);
		expect( x.n4 ).toBeGreaterThan( x.n2 );
	} );

	it( 'runs a loop on from where its feeder enters it', () => {
		// z enters the loop b, c at c; only the closing wire b>c runs back.
		const x = xsOf( 'z>c c>b b>c b>d' );
		expect( x.c ).toBeGreaterThan( x.z );
		expect( x.b ).toBeGreaterThan( x.c );
		expect( x.d ).toBeGreaterThan( x.b );
	} );

	it( 'relaxes a card past the card its loop closes back to', () => {
		// n1 closes a loop to n0 and relaxes toward n3 and n5, crossing nothing.
		const pairs = 'n0>n1 n0>n2 n1>n3 n2>n4 n1>n5 n2>n6 n2>n7 n1>n0 n4>n5'
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).crossings ).toEqual( [] );
	} );

	it( 'runs a loop on from a feeder that also wires to itself', () => {
		const x = xsOf( 'z>c c>b b>c b>d z>z' );
		expect( x.c ).toBeGreaterThan( x.z );
		expect( x.b ).toBeGreaterThan( x.c );
		expect( x.d ).toBeGreaterThan( x.b );
	} );

	it( "never counts a card's wire to itself among its feeders", () => {
		// n4's wire to itself would lift its fan-in to the four a hub has.
		const x = xsOf(
			'n4>n5 n5>n4 n3>n2 n5>n0 n1>n3 n4>n4 n2>n1 n1>n5 n3>n4 n0>n4'
		);
		expect( x.n4 ).toBeGreaterThan( x.n3 );
		expect( x.n4 ).toBeGreaterThan( x.n0 );
	} );

	it( 'runs a loop on from where a hub enters it', () => {
		// H enters the loop xb, xa at xb, whatever their ids' order.
		const slices = [ 1, 2, 3, 4 ].map(
			( k ) => `s${ k }>t${ k } t${ k }>H`
		);
		const x = xsOf( [ ...slices, 'H>xb xb>xa xa>xb xa>xz' ].join( ' ' ) );
		expect( x.xb ).toBeGreaterThan( x.H );
		expect( x.xa ).toBeGreaterThan( x.xb );
		expect( x.xz ).toBeGreaterThan( x.xa );
	} );

	it( 'layers a loop of hubs on from where a hub enters it', () => {
		// Each hub takes four slices; Hz enters the loop Ha, Hb at Hb.
		const slices = [ 'Ha', 'Hb', 'Hz' ].flatMap( ( hub ) =>
			[ 1, 2, 3, 4 ].map(
				( k ) =>
					`${ hub }s${ k }>${ hub }t${ k } ${ hub }t${ k }>${ hub }`
			)
		);
		const x = xsOf( [ ...slices, 'Hz>Hb Hb>Ha Ha>Hb' ].join( ' ' ) );
		expect( x.Hb ).toBeGreaterThan( x.Hz );
		expect( x.Ha ).toBeGreaterThan( x.Hb );
	} );

	it( "stretches a sink whose feeder's other wire closes a loop", () => {
		// c feeds s and closes the loop a, b, c; s shares c with no consumer.
		const x = xsOf( 'a>b b>c c>a c>s b>d d>e e>f' );
		expect( x.s ).toBeGreaterThan( x.e );
	} );

	it( 'breaks a loop the same way whatever order its wires come in', () => {
		const wires = 'a>b a>c b>c c>b b>d c>e';
		expect( xsOf( 'a>c a>b b>c c>b b>d c>e' ) ).toEqual( xsOf( wires ) );
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

	it( 'stacks the bands wired to both hubs between those wired to one', () => {
		// Alphabetically the bands wired to ha, to hb and to both interleave;
		// stacked by their hubs, only the two wired to both cross.
		const graph = wired(
			'p0:in>p0:out p0:out>ha p0:out>hb p1:in>p1:out p1:out>ha ' +
				'p2:in>p2:out p2:out>hb p3:in>p3:out p3:out>ha p3:out>hb ' +
				'p4:in>p4:out p4:out>ha p5:in>p5:out p5:out>hb'
		);
		const g = gridOf( graph );
		expect(
			[ 'p0', 'p1', 'p2', 'p3', 'p4', 'p5' ].sort(
				( a, b ) => g[ `${ a }:out` ].row - g[ `${ b }:out` ].row
			)
		).toEqual( [ 'p1', 'p4', 'p0', 'p3', 'p2', 'p5' ] );
		expect(
			drawn( autoLayout( graph ).nodes, graph.edges ).crossings
		).toHaveLength( 1 );
	} );

	it( 'stacks a band wired to both hubs nearer the hub its longer wire reaches', () => {
		// b0 reaches hb from its first card and ha from its last, so it
		// stacks below b4, whose wires to both start in its last column.
		const graph = wired(
			'b0:0>b0:1 b0:1>ha b0:0>hb b1:0>b1:1 b1:1>ha b2:0>b2:1 ' +
				'b2:1>hb b3:0>b3:1 b3:1>b3:2 b3:2>hb b4:0>b4:1 b4:1>b4:2 ' +
				'b4:2>b4:3 b4:3>ha b4:3>hb b5:0>b5:1 b5:1>ha'
		);
		expect(
			drawn( autoLayout( graph ).nodes, graph.edges ).crossings
		).toEqual( [] );
	} );

	it( 'puts each hub in the column right after the slices that feed it, on their middle row', () => {
		// Every publication feeds `fleet:cache`, so the sheet is ONE block and
		// packs as one stack; a hub on a far edge would still sit columns away
		// from most of its feeders, which is what this pins.
		const g = gridOf( pubs( 8 ) );
		for ( const pub of PUBS ) {
			const rows = JOBS.map(
				( job ) => g[ `${ pub }:${ job }:buffer` ].row
			);
			const cols = JOBS.map(
				( job ) => g[ `${ pub }:${ job }:buffer` ].col
			);
			// Half a step clear: a hub's column carries the fan-in gap.
			expect( g[ `${ pub }:hub` ].col ).toBe( Math.max( ...cols ) + 1.5 );
			// On the middle row, or half a row off it where the fleet hub
			// shares the column and the two spread around the middle.
			const mid = ( Math.min( ...rows ) + Math.max( ...rows ) ) / 2;
			expect(
				Math.abs( g[ `${ pub }:hub` ].row - mid )
			).toBeLessThanOrEqual( 0.5 );
		}
	} );

	it( 'packs blocks no wire joins into stacks of their own', () => {
		// The same eight publications with nothing shared between them: eight
		// blocks, which the packer spreads across stacks rather than running
		// one column the height of the sheet.
		const edges = [];
		for ( const pub of PUBS ) {
			for ( const job of JOBS ) {
				edges.push(
					{
						from: `${ pub }:${ job }`,
						to: `${ pub }:${ job }:buffer`,
					},
					{ from: `${ pub }:${ job }:buffer`, to: `${ pub }:hub` }
				);
			}
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
		const stackStarts = new Set(
			PUBS.map( ( pub ) =>
				Math.min(
					...JOBS.map(
						( job ) => g[ `${ pub }:${ job }:buffer` ].col
					)
				)
			)
		);
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
		expect( drawn( nodes, edges ).over ).toEqual( [] );
	} );

	it( "keeps a wire from a band straight to its hub off the band's own chain", () => {
		// chronogram's router feeds a two-step chain to the hub AND the hub
		// directly; the direct wire would run along the chain's row, through
		// both of its cards, because a wire to a hub is not a wire inside the
		// band.
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
			drawn( nodes, edges ).over.filter( ( hit ) =>
				/over (pub:balancer|korell:template)$/.test( hit )
			)
		).toEqual( [] );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
	} );

	it( 'packs equal-width blocks alphabetically', () => {
		// A hub block keyed by its hub, which sorts after the hub-less band
		// keyed by its first node; blocks arrive hub first, but the packer
		// takes them by key. Three wires meet a node in each, so both draw
		// three and a half columns wide, and width decides nothing.
		const edges = [
			{ from: 'm:in', to: 'm:mid' },
			{ from: 'm:in2', to: 'm:mid' },
			{ from: 'm:in3', to: 'm:mid' },
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
		// a-top is a hub too, so its column opens half a step clear.
		expect( g[ 'a-top' ].col ).toBe( g.h1.col + 1.5 );
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
		expect( drawn( autoLayout( graph ).nodes, edges ).over ).toEqual( [] );
		const buffers = JOBS.map( ( job ) => g[ `pub:${ job }:buffer` ] );
		const last = buffers[ 0 ].col;
		expect( buffers.every( ( b ) => b.col === last ) ).toBe( true );
		// The timeout feeds only the hub, so it feeds from the buffers'
		// column, under the last buffer.
		expect( g[ 'pub:timeout' ].col ).toBe( last );
		expect( g[ 'pub:timeout' ].row ).toBeGreaterThan(
			Math.max( ...buffers.map( ( b ) => b.row ) )
		);
		// Five wires meet the hub across one boundary: half a step opens.
		expect( g[ 'pub:set_stream' ].col ).toBe( last + 1.5 );
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
		// direct wire skips the head and the middle, and clearing only wires
		// INTO a hub would draw it through both.
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
			drawn( nodes, edges ).over.filter( ( hit ) =>
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
		// wires would span column 1 and push settings-sync past them all.
		const graph = hubControl();
		const g = gridOf( graph );
		const spokeRows = SPOKES.map( ( id ) => g[ id ].row );
		// Its wires fan out to every spoke, so half a step opens between.
		expect( g[ 'discovery-collector' ].col ).toBe(
			g[ SPOKES[ 0 ] ].col - 1.5
		);
		expect( g[ 'settings-sync' ].row ).toBe( g[ 'settings:consumer' ].row );
		expect( g[ 'settings-sync' ].row ).toBeLessThan(
			Math.max( ...spokeRows )
		);
		const { nodes } = autoLayout( graph );
		expect( drawn( nodes, graph.edges ).over ).toEqual( [] );
	} );

	it( 'seats the small blocks beside the fan, opening no column past it', () => {
		// The spoke column outgrows the square; the probe pair and the REPL
		// take the rows beside its fan, nearest the middle, not a new column.
		const graph = hubControl();
		const g = gridOf( graph );
		for ( const id of Object.keys( g ) ) {
			expect( [ id, g[ id ].col <= g.null.col ] ).toEqual( [ id, true ] );
		}
		expect( g.topicprobe.col ).toBe( g[ 'settings:consumer' ].col );
		expect( g._repl.col ).toBe( g.topicprobe.col );
		expect( g._repl.row ).not.toBe( g.topicprobe.row );
		const { nodes } = autoLayout( graph );
		expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		expect( drawn( nodes, graph.edges ).over ).toEqual( [] );
	} );

	// Seeded random graphs whose packing can stack a block onto one that has
	// taken room in the canvas, and run a wire between blocks over it.
	const seedGraph = ( seed ) => ( {
		nodes: SEEDS[ seed ].nodes.map( ( id ) => ( { id } ) ),
		edges: SEEDS[ seed ].edges.map( ( [ from, to ] ) => ( { from, to } ) ),
	} );

	it( 'lays out a hub nudge that carries a chain of followers along', () => {
		// A hub on a wire into the consumers carries its sole consumer chain,
		// two and three cards past any column the movers read spans for.
		const pairs = (
			'h0b0n0>h0b0n1 h0b0n1>h0b0n2 h0b0n2>hub0 h0b1n0>hub0 ' +
			'h0b2n0>h0b2n1 h0b2n1>h0b2n2 h0b2n2>hub0 h0b3n0>h0b3n1 ' +
			'h0b3n1>hub0 h0b4n0>h0b4n1 h0b4n1>hub0 hub0>h0c0n0 ' +
			'h0c0n0>h0c0n1 hub0>h0c1n0 h0c1n0>h0c1n1 h0c1n1>h0c1n2 ' +
			'h0c1n2>h0c1n3 hub0>hub1 h1b0n0>h1b0n1 h1b0n1>hub1 ' +
			'h1b1n0>h1b1n1 h1b1n1>h1b1n2 h1b1n2>hub1 h1b2n0>hub1 ' +
			'hub1>h1c0n0 h1c0n0>h1c0n1 h1c0n1>h1c0n2 hub1>hub2 ' +
			'h2b0n0>hub2 h2b1n0>hub2 h2b2n0>hub2 hub2>h2c0n0 ' +
			'h2c0n0>h2c0n1 h2c0n1>h2c0n2'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const ids = [ ...new Set( pairs.flat() ) ];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
		} );
		expect(
			nodes.filter(
				( n ) =>
					! Number.isFinite( n.position.x ) ||
					! Number.isFinite( n.position.y )
			)
		).toEqual( [] );
		expect( nodes ).toHaveLength( ids.length );
	} );

	it( 'nudges no card into the rows of another band its hub feeds', () => {
		// The hub feeds c0, c1 and c2, stacked right of it and shifted level
		// with it; clearing their hub wires keeps each in its own rows.
		const pairs = (
			'f0l0n1>f0l1n0 f0l0n0>f0l1n1 f0l0n1>f0l1n2 f0l0n0>f0l1n2 ' +
			'f0l1n2>f0l2n0 f0l1n2>f0l2n1 f0l2n0>hub f1l0n1>f1l1n0 ' +
			'f1l0n1>f1l1n1 f1l0n0>f1l1n2 f1l1n1>f1l2n0 f1l1n0>f1l2n0 ' +
			'f1l2n0>f1l3n0 f1l3n0>hub f2l0n0>f2l1n0 f2l0n0>f2l1n1 ' +
			'f2l1n1>f2l2n0 f2l1n0>f2l2n1 f2l2n1>f2l3n0 f2l2n0>f2l3n1 ' +
			'f2l3n0>hub f3l0n0>f3l1n0 f3l0n1>f3l1n1 f3l1n0>hub ' +
			'hub>c0l0n0 c0l0n0>c0l1n0 hub>c1l0n0 hub>c1l0n1 ' +
			'c1l0n0>c1l1n0 hub>c1l1n0 c1l0n0>c1l1n1 hub>c1l1n1 ' +
			'c1l0n1>c1l1n2 hub>c1l1n2 c1l1n2>c1l2n0 c1l1n0>c1l2n0 ' +
			'c1l1n0>c1l2n1 hub>c1l2n1 hub>c2l0n0 c2l0n0>c2l1n0 ' +
			'hub>c2l1n0 c2l0n0>c2l1n1 c2l0n0>c2l1n2'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const g = gridOf( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
		} );
		const bands = [ 'c0', 'c1', 'c2' ].map( ( b ) =>
			Object.keys( g ).filter( ( id ) => id.startsWith( `${ b }l` ) )
		);
		const spans = bands.map( ( ids ) => [
			Math.min( ...ids.map( ( id ) => g[ id ].row ) ),
			Math.max( ...ids.map( ( id ) => g[ id ].row ) ),
		] );
		const inside = bands.flatMap( ( ids, k ) =>
			ids.filter( ( id ) =>
				spans.some(
					( [ lo, hi ], j ) =>
						j !== k && g[ id ].row >= lo && g[ id ].row <= hi
				)
			)
		);
		expect( inside ).toEqual( [] );
	} );

	it( 'judges a pull against the order its block picked, not the band’s own', () => {
		// The block keeps the sweeps' plain order; weighed against that order
		// unpulled, the pull draws 9 crossings and no card covered, where
		// against the band's exchanged order it draws 11 and covers 1.
		const pairs = (
			'b0l0n0>b0l1n0 b0l0n0>b0l1n1 b0l0n0>b0l1n2 b0l0n0>b0l1n3 ' +
			'b0l1n0>b0l2n0 b0l0n0>b0l2n0 b0l1n2>b0l2n1 b0l1n3>b0l2n2 ' +
			'b0l1n3>b0l2n3 b0l2n3>b0l3n0 b0l2n2>b0l3n1 b0l3n0>hub ' +
			'b0l0n0>hub b1l0n1>b1l1n0 b1l0n1>b1l1n1 b1l0n2>b1l1n2 ' +
			'b1l1n0>hub b2l0n0>b2l1n0 b2l0n0>b2l1n1 b2l0n0>b2l1n2 ' +
			'b2l0n0>b2l1n3 b2l1n2>b2l2n0 b2l1n0>b2l2n0 b2l1n0>b2l2n1 ' +
			'b2l2n0>hub b2l0n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const cost = drawn( nodes, edges );
		expect( [ cost.crossings.length, cost.over.length ] ).toEqual( [
			9, 0,
		] );
	} );

	it( 'judges a pin trial on its pulled layout alone', () => {
		// A pin trial carries no unpulled twin, so the block's judgement of
		// its pulls cannot swap a pinned band back: 7 crossings, 1 covered,
		// where a twin draws 8 and covers 2.
		const pairs = (
			'b0l0n1>b0l1n0 b0l0n1>b0l1n1 b0l0n1>b0l1n2 b0l0n1>b0l1n3 ' +
			'b0l1n1>b0l2n0 b0l1n0>b0l2n1 b0l0n0>b0l2n1 b0l1n0>b0l2n2 ' +
			'b0l1n2>b0l2n3 b0l0n1>b0l2n3 b0l2n3>b0l3n0 b0l3n0>hub ' +
			'b0l0n0>hub b1l0n2>b1l1n0 b1l0n1>b1l1n1 b1l0n1>b1l1n2 ' +
			'b1l1n1>b1l2n0 b1l0n0>b1l2n0 b1l2n0>b1l3n0 b1l1n2>b1l3n0 ' +
			'b1l2n0>b1l3n1 b1l2n0>b1l3n2 b1l2n0>b1l3n3 b1l3n0>b1l4n0 ' +
			'b1l3n3>b1l4n1 b1l4n0>hub b1l0n0>hub b2l0n0>b2l1n0 ' +
			'b2l1n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const cost = drawn( nodes, edges );
		expect( [ cost.crossings.length, cost.over.length ] ).toEqual( [
			7, 1,
		] );
	} );

	it( 'carries a card’s sole follower when a hub wire nudges the card', () => {
		// b0l0n0's wire to the hub moves b0l1n0; b0l2n0, which b0l1n0 alone
		// feeds and which it alone feeds, keeps its row.
		const pairs = (
			'b0l0n0>b0l1n0 b0l1n0>b0l2n0 b0l2n0>b0l3n0 b0l2n0>b0l3n1 ' +
			'b0l2n0>b0l3n2 b0l3n0>hub b0l0n0>hub b1l0n0>b1l1n0 ' +
			'b1l1n0>hub b1l0n0>hub b2l0n0>b2l1n0 b2l0n0>b2l1n1 ' +
			'b2l0n0>b2l1n2 b2l1n0>hub b3l0n1>b3l1n0 b3l1n0>b3l2n0 ' +
			'b3l1n0>b3l2n1 b3l2n0>b3l3n0 b3l3n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const g = gridOf( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
		} );
		expect( g.b0l2n0.col ).toBe( g.b0l1n0.col + 1 );
		expect( g.b0l2n0.row ).toBe( g.b0l1n0.row );
	} );

	it( 'nudges no card into the rows of another band feeding its hub', () => {
		// Four bands feed one hub; clearing their hub wires keeps each band
		// in the rows between its neighbours, so no two share a row.
		const pairs = (
			'b0l0n0>b0l1n0 b0l0n0>b0l1n1 b0l1n1>b0l2n0 b0l2n0>hub ' +
			'b1l0n1>b1l1n0 b1l0n0>b1l1n0 b1l0n1>b1l1n1 b1l0n0>b1l1n1 ' +
			'b1l0n0>b1l1n2 b1l1n0>b1l2n0 b1l2n0>b1l3n0 b1l2n0>b1l3n1 ' +
			'b1l2n0>b1l3n2 b1l3n0>hub b1l0n0>hub b2l0n0>b2l1n0 ' +
			'b2l0n0>b2l1n1 b2l1n1>b2l2n0 b2l2n0>hub b2l0n0>hub ' +
			'b3l0n0>b3l1n0 b3l0n0>b3l1n1 b3l0n0>b3l1n2 b3l1n2>b3l2n0 ' +
			'b3l1n2>b3l2n1 b3l1n1>b3l2n2 b3l1n0>b3l2n2 b3l2n1>b3l3n0 ' +
			'b3l3n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const g = gridOf( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const bands = [ 'b0', 'b1', 'b2', 'b3' ].map( ( b ) =>
			Object.keys( g ).filter( ( id ) => id.startsWith( `${ b }l` ) )
		);
		const spans = bands.map( ( ids ) => [
			Math.min( ...ids.map( ( id ) => g[ id ].row ) ),
			Math.max( ...ids.map( ( id ) => g[ id ].row ) ),
		] );
		const inside = bands.flatMap( ( ids, k ) =>
			ids.filter( ( id ) =>
				spans.some(
					( [ lo, hi ], j ) =>
						j !== k && g[ id ].row > lo && g[ id ].row < hi
				)
			)
		);
		expect( inside ).toEqual( [] );
	} );

	it.each( Object.keys( SEEDS ) )(
		'stacks no block onto one packed into room (seed %s)',
		( seed ) => {
			const { nodes } = autoLayout( seedGraph( seed ) );
			expect( minColumnGap( nodes ) ).toBeGreaterThanOrEqual( NODE_H );
		}
	);

	it( 'keeps a late source in the seat the spread opened beside it', () => {
		// A wire nudge that ignored k2src's seat would crowd it and reseat it
		// three columns back, its wire running over the band.
		const graph = seedGraph( 'c134623' );
		const { nodes } = autoLayout( graph );
		const at = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at.k2l3n0.x - at.k2src.x ).toBeLessThanOrEqual( 2 * X_STEP );
		expect( Math.abs( at.k2src.y - at.k2l3n0.y ) ).toBeLessThanOrEqual(
			Y_STEP
		);
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'k2src→' )
			)
		).toEqual( [] );
	} );

	it( 'packs an edgeless card clear of the wires between blocks', () => {
		const graph = seedGraph( '134623' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
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
			// Where no seat within a row keeps the wire off every card, the
			// cheapest clear one is still close.
			const graph = seedGraph( seed );
			const g = gridOf( graph );
			expect(
				Math.abs( g[ source ].row - g[ fed ].row )
			).toBeLessThanOrEqual( 3 );
			const { nodes } = autoLayout( graph );
			expect(
				drawn( nodes, graph.edges ).over.filter( ( hit ) =>
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
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				/ over k1src$/.test( hit )
			)
		).toEqual( [] );
	} );

	it( 'reseats a source after the hub wires have moved what it feeds', () => {
		// k2src seats against the row the hub pass leaves k2l4n0 on, on a
		// seat whose wire to k2l4n0 passes no card.
		const graph = seedGraph( '14962' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'k2src→' )
			)
		).toEqual( [] );
	} );

	it( 'seats a late source inside its own band, above the band stacked beneath', () => {
		// url-detail's timer feeds only its fetcher, two columns on, so it is
		// seated last: in its band's own column, on a row the band opens,
		// below every card of the band above and above every card of the
		// band beneath, and never above its band's top.
		const edges = [];
		for ( const s of [ 'a', 'b', 'url-lookup' ] ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: 'topologies:shell' }
			);
		}
		edges.push(
			{ from: 'url-detail:in', to: 'url-detail:transform' },
			{ from: 'url-detail:transform', to: 'url-detail:view' },
			{ from: 'url-detail:in', to: 'url-detail:fetch' },
			{ from: 'url-detail:timer', to: 'url-detail:fetch' },
			{ from: 'url-detail:fetch', to: 'topologies:shell' }
		);
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const g = gridOf( { nodes: ids.map( ( id ) => ( { id } ) ), edges } );

		expect( g[ 'url-detail:timer' ].col ).toBe( g[ 'url-detail:in' ].col );
		const band = ( s ) =>
			[ 'timer', 'tee', 'in', 'fetch', 'result' ].map(
				( k ) => g[ `${ s }:${ k }` ].row
			);
		// Downward only: the band's top is the row the stack gave it, as high
		// as its fetcher a row under the band above's result allows, and the
		// band beneath stacks below the seat.
		expect( g[ 'url-detail:fetch' ].row ).toBe( g[ 'b:result' ].row + 1 );
		expect( g[ 'url-detail:timer' ].row ).toBe(
			Math.min(
				...[ 'timer', 'in', 'fetch', 'transform', 'view' ].map(
					( k ) => g[ `url-detail:${ k }` ].row
				)
			)
		);
		expect( g[ 'url-detail:timer' ].row ).toBeGreaterThan(
			Math.max( ...band( 'b' ) )
		);
		expect( g[ 'url-detail:timer' ].row ).toBeLessThan(
			Math.min( ...band( 'url-lookup' ) )
		);
	} );

	it( 'opens a row in its own column for a late source parked anywhere else', () => {
		// The overview station's url graph. url-detail's timer feeds only its
		// fetcher, two columns on, and every seat in column 1 parks it behind
		// url-detail:in:current, so the timer keeps column 0 and its band
		// opens a row there, its wire clear of every card.
		const edges = [];
		for ( const s of [ 'url-deeplink', 'url-lookup' ] ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:in:current` },
				{ from: `${ s }:in:current`, to: `${ s }:result` },
				{ from: `${ s }:fetch`, to: 'url:shell' }
			);
		}
		edges.push(
			{ from: 'url-detail:timer', to: 'url-detail:fetch' },
			{ from: 'url-detail:in', to: 'url-detail:fetch' },
			{ from: 'url-detail:in', to: 'url-detail:in:current' },
			{ from: 'url-detail:in:current', to: 'url-detail:transform' },
			{ from: 'url-detail:transform', to: 'url-detail:view' },
			{ from: 'url-detail:view', to: 'url:shell' },
			{ from: 'url-detail:fetch', to: 'url:shell' }
		);
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const graph = { nodes: ids.map( ( id ) => ( { id } ) ), edges };
		const g = gridOf( graph );
		const timer = g[ 'url-detail:timer' ];

		expect( timer.col ).toBe( 0 );
		expect( timer.col ).toBe( g[ 'url-detail:in' ].col );
		expect( g[ 'url-detail:fetch' ].col ).toBe( 2 );
		expect( timer.row ).toBeLessThan( g[ 'url-detail:in' ].row );
		for ( const id of ids.filter( ( x ) =>
			x.startsWith( 'url-deeplink:' )
		) ) {
			expect( [ id, timer.row > g[ id ].row ] ).toEqual( [ id, true ] );
		}
		expect(
			drawn( autoLayout( graph ).nodes, edges ).over.filter( ( hit ) =>
				hit.startsWith( 'url-detail:timer→' )
			)
		).toEqual( [] );
	} );

	it( 'opens a late source a row that stretches no wire over a card', () => {
		// The row a late source opens moves every card below it, stretching
		// each wire that crosses the row; the row chosen keeps a stretched
		// wire off every card too, so b1l0n0's wire to the hub clears b0l1n2.
		const edges = [
			[ 'b0l0n0', 'b0l1n0' ],
			[ 'b0l0n0', 'b0l1n1' ],
			[ 'b0l0n0', 'b0l1n2' ],
			[ 'b0l0n0', 'b0l1n3' ],
			[ 'b0l1n3', 'b0l2n0' ],
			[ 'b0l1n0', 'b0l2n0' ],
			[ 'b0l2n0', 'b0l3n0' ],
			[ 'b0l2n0', 'b0l3n1' ],
			[ 'b0l3n0', 'b0l4n0' ],
			[ 'b0l4n0', 'hub' ],
			[ 'b0src', 'b0l4n0' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n0', 'b1l1n1' ],
			[ 'b1l0n0', 'b1l1n2' ],
			[ 'b1l0n0', 'b1l1n3' ],
			[ 'b1l1n0', 'hub' ],
			[ 'b1l0n0', 'hub' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).over ).toEqual( [] );
	} );

	it( 'lets a late source take its band’s top row, the band cut beneath it', () => {
		// The band's top stays where the stack put it while a cut is on trial,
		// so a cut at the top row pushes the band down and leaves the row to
		// the source, drawing this graph with no crossing and no card covered.
		const edges = [
			[ 'b0l0n0', 'b0l1n0' ],
			[ 'b0l1n0', 'b0l2n0' ],
			[ 'b0l2n0', 'b0l3n0' ],
			[ 'b0l3n0', 'hub' ],
			[ 'b0l0n0', 'hub' ],
			[ 'b0src', 'b0l3n0' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l1n0', 'hub' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ) ).toEqual( { crossings: [], over: [] } );
	} );

	it( 'opens no row whose cut hides the source’s own wire over a card', () => {
		// A cut that uncovers one card scores as low as one that keeps the
		// source's wire clear, so the source's own wire decides first.
		const edges = [
			[ 'b0l0n1', 'b0l1n0' ],
			[ 'b0l0n0', 'b0l1n1' ],
			[ 'b0l1n1', 'b0l2n0' ],
			[ 'b0l1n0', 'b0l2n1' ],
			[ 'b0l1n1', 'b0l2n2' ],
			[ 'b0l0n0', 'b0l2n2' ],
			[ 'b0l2n0', 'b0l3n0' ],
			[ 'b0l2n0', 'b0l3n1' ],
			[ 'b0l1n1', 'b0l3n1' ],
			[ 'b0l2n0', 'b0l3n2' ],
			[ 'b0l1n1', 'b0l3n2' ],
			[ 'b0src', 'b0l2n0' ],
			[ 'b0l3n0', 'hub' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n0', 'b1l1n1' ],
			[ 'b1l0n0', 'b1l1n2' ],
			[ 'b1l1n1', 'b1l2n0' ],
			[ 'b1l0n0', 'b1l2n0' ],
			[ 'b1l1n1', 'b1l2n1' ],
			[ 'b1l0n0', 'b1l2n1' ],
			[ 'b1l2n1', 'b1l3n0' ],
			[ 'b1l1n2', 'b1l3n0' ],
			[ 'b1l2n0', 'b1l3n1' ],
			[ 'b1l2n1', 'b1l3n2' ],
			[ 'b1src', 'b1l2n0' ],
			[ 'b2l0n0', 'b2l1n0' ],
			[ 'b2l1n0', 'b2l2n0' ],
			[ 'b2l1n0', 'b2l2n1' ],
			[ 'b2l1n0', 'b2l2n2' ],
			[ 'b2l2n1', 'b2l3n0' ],
			[ 'b2l3n0', 'b2l4n0' ],
			[ 'b2l3n0', 'b2l4n1' ],
			[ 'b2l3n0', 'b2l4n2' ],
			[ 'b2l2n0', 'b2l4n2' ],
			[ 'b2src', 'b2l4n0' ],
			[ 'b2l4n0', 'hub' ],
			[ 'b3l0n0', 'b3l1n0' ],
			[ 'b3l0n0', 'b3l1n1' ],
			[ 'b3l1n0', 'b3l2n0' ],
			[ 'b3src', 'b3l2n0' ],
			[ 'b3l2n0', 'hub' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect(
			drawn( nodes, edges ).over.filter( ( hit ) =>
				hit.startsWith( 'b2src→' )
			)
		).toEqual( [] );
	} );

	it( 'takes the clean row its search stops at, not a cheaper-scored one before it', () => {
		// Seed c134623 with late sources added. A row where late0's own wire
		// passes a card but its cut uncovers another scores as low as a clean
		// row; the search stops at the clean row and must seat late0 there.
		// Its wire to hub0 still passes k0l0n1, which feeds hub0 alone and
		// sits on hub0's row in the column before it.
		const graph = seedGraph( 'c134623' );
		const extra = [
			[ 'late0', 'k1l1n0' ],
			[ 'late0', 'k5l3n1' ],
			[ 'late0', 'hub0' ],
			[ 'late1', 'k3l2n1' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const edges = [ ...graph.edges, ...extra ];
		const nodes = [
			...graph.nodes,
			...[ 'late0', 'late1' ].map( ( id ) => ( { id } ) ),
		];
		expect(
			drawn( autoLayout( { nodes, edges } ).nodes, edges ).over.filter(
				( hit ) => hit.startsWith( 'late0→' )
			)
		).toEqual( [ 'late0→hub0 over k0l0n1' ] );
	} );

	it( 'seats in full a pin trial the cheaper drawing turns down', () => {
		// Without its late sources seated, moving b2l2n0 toward the hub draws
		// one crossing more; seated in full, it draws no card under a wire.
		const edges = [
			[ 'b0l0n1', 'b0l1n0' ],
			[ 'b0l0n1', 'b0l1n1' ],
			[ 'b0l1n1', 'b0l2n0' ],
			[ 'b0l0n0', 'b0l2n0' ],
			[ 'b0l1n1', 'b0l2n1' ],
			[ 'b0l1n1', 'b0l2n2' ],
			[ 'b0src', 'b0l2n0' ],
			[ 'b0l2n0', 'hub' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n1', 'b1l1n1' ],
			[ 'b1l0n1', 'b1l1n2' ],
			[ 'b1l1n0', 'b1l2n0' ],
			[ 'b1l1n0', 'b1l2n1' ],
			[ 'b1l0n0', 'b1l2n1' ],
			[ 'b1l2n0', 'b1l3n0' ],
			[ 'b1src', 'b1l3n0' ],
			[ 'b1l3n0', 'hub' ],
			[ 'b2l0n2', 'b2l1n0' ],
			[ 'b2l1n0', 'b2l2n0' ],
			[ 'b2l1n0', 'b2l2n1' ],
			[ 'b2l1n0', 'b2l2n2' ],
			[ 'b2src', 'b2l2n0' ],
			[ 'b2l2n0', 'hub' ],
			[ 'b3l0n1', 'b3l1n0' ],
			[ 'b3l0n2', 'b3l1n1' ],
			[ 'b3l1n1', 'b3l2n0' ],
			[ 'b3l2n0', 'b3l3n0' ],
			[ 'b3l2n0', 'b3l3n1' ],
			[ 'b3l1n1', 'b3l3n1' ],
			[ 'b3l2n0', 'b3l3n2' ],
			[ 'b3l1n1', 'b3l3n2' ],
			[ 'b3src', 'b3l2n0' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).over ).toEqual( [] );
	} );

	it( 'stacks the band beneath a row under the late source that grows a band', () => {
		// b0src seats half a row below b0's bottom card without a cut; the
		// chain b0z stacked beneath b0 rises to a row under it, a half row.
		const edges = [
			[ 'b0l0n1', 'b0l1n0' ],
			[ 'b0l0n0', 'b0l1n1' ],
			[ 'b0l1n0', 'b0l2n0' ],
			[ 'b0l0n1', 'b0l2n0' ],
			[ 'b0l1n0', 'b0l2n1' ],
			[ 'b0l2n0', 'b0l3n0' ],
			[ 'b0l1n0', 'b0l3n0' ],
			[ 'b0l2n0', 'b0l3n1' ],
			[ 'b0src', 'b0l3n0' ],
			[ 'b0l3n0', 'hub' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n0', 'b1l1n1' ],
			[ 'b1l0n0', 'b1l1n2' ],
			[ 'b1l1n0', 'b1l2n0' ],
			[ 'b1l1n1', 'b1l2n1' ],
			[ 'b1l0n0', 'b1l2n1' ],
			[ 'b1l1n0', 'b1l2n2' ],
			[ 'b1src', 'b1l2n0' ],
			[ 'b2l0n0', 'b2l1n0' ],
			[ 'b2l0n0', 'b2l1n1' ],
			[ 'b2l1n0', 'b2l2n0' ],
			[ 'b2l1n0', 'b2l2n1' ],
			[ 'b2l1n0', 'b2l2n2' ],
			[ 'b2src', 'b2l2n0' ],
			[ 'b2l2n0', 'hub' ],
			[ 'b0zA', 'b0zB' ],
			[ 'b0zB', 'b0zC' ],
			[ 'b0zC', 'hub' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const g = gridOf( { nodes: ids.map( ( id ) => ( { id } ) ), edges } );
		expect( g.b0src.row % 1 ).toBe( 0.5 );
		for ( const id of [ 'b0zA', 'b0zB', 'b0zC' ] ) {
			expect( [ id, g[ id ].row ] ).toEqual( [ id, g.b0src.row + 1 ] );
		}
		expect( g.b0zC.col ).toBe( g.b0src.col );
	} );

	it( 'tries a pin whose hub wire a later move leaves over a card', () => {
		// Seed c71271 with two late sources feeding k2 and hub0. A pass moves
		// another pin; k0l2n0's wire to hub0 then runs over k1l1n0, so the
		// pass after tries it and it moves into k1l1n0's column.
		const graph = seedGraph( 'c71271' );
		const edges = [
			...graph.edges,
			...[
				[ 'late0', 'k2l3n0' ],
				[ 'late0', 'hub0' ],
				[ 'late1', 'k2l3n1' ],
				[ 'late1', 'hub0' ],
			].map( ( [ from, to ] ) => ( { from, to } ) ),
		];
		const nodes = [ ...graph.nodes, { id: 'late0' }, { id: 'late1' } ];
		const g = gridOf( { nodes, edges } );
		expect( g.k0l2n0.col ).toBe( g.k1l1n0.col );
		expect(
			drawn( autoLayout( { nodes, edges } ).nodes, edges ).over.filter(
				( hit ) => hit.startsWith( 'k0l2n0→' )
			)
		).toEqual( [] );
	} );

	it( 'leaves a hub feeder in its band’s column while its wire covers no card', () => {
		// Six bands feed one hub. No move leaves b3l2n0's wire to the hub
		// over a card, so it keeps its band's column.
		const pairs = (
			'b0l0n0>b0l1n1 b0l1n1>b0l2n0 b0l2n0>b0l3n0 b0l3n0>hub ' +
			'b1l0n0>b1l1n1 b1l1n1>b1l2n0 b1l1n1>b1l2n1 b1l2n0>hub ' +
			'b2l0n0>b2l1n0 b2l1n0>hub b3l0n0>b3l1n0 b3l1n0>b3l2n0 ' +
			'b3l1n0>b3l2n1 b3l1n0>b3l2n2 b3l2n0>hub b4l0n0>b4l1n0 ' +
			'b4l0n0>b4l1n1 b4l0n0>b4l1n2 b4l0n0>b4l1n3 b4l1n0>hub ' +
			'b5l0n0>b5l1n0 b5l1n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const graph = {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		};
		const g = gridOf( graph );
		// The feeders' column: the rightmost a card left of the hub holds.
		const feeders = Math.max(
			...Object.values( g )
				.map( ( p ) => p.col )
				.filter( ( c ) => c < g.hub.col )
		);
		expect( g.b3l2n0.col ).toBeLessThan( feeders );
		expect(
			drawn( autoLayout( graph ).nodes, edges ).over.filter( ( hit ) =>
				hit.startsWith( 'b3l2n0→hub' )
			)
		).toEqual( [] );
	} );

	it( 'judges pin trials across five tiles of seed 134623 to fewer crossings', () => {
		// The cheaper drawing picks the moves, the block seated in full keeps
		// them, and every move it left is tried in full: 457 crossings, 184
		// cards covered, with each tile's bands stacked as tight as their
		// columns allow and no nudge leaving a band's own rows.
		const seed = SEEDS[ '134623' ];
		const name = ( t, id ) =>
			/^hub\d+$/.test( id ) ? id : `t${ t }:${ id }`;
		const ids = new Set();
		const edges = [];
		for ( let t = 0; t < 5; t++ ) {
			seed.nodes.forEach( ( id ) => ids.add( name( t, id ) ) );
			for ( const [ from, to ] of seed.edges ) {
				edges.push( { from: name( t, from ), to: name( t, to ) } );
			}
		}
		const { nodes } = autoLayout( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const cost = drawn( nodes, edges );
		expect( [ cost.crossings.length, cost.over.length ] ).toEqual( [
			457, 184,
		] );
	} );

	it( 'tries a pin again after a later pass moves another', () => {
		// A pin clear at its turn is tried again in full after each pass that
		// moves one: 6 crossings and 3 cards covered, where trying it no more
		// leaves 7 and 5.
		const { at, edges } = laidOut(
			'b0l0n0>b0l1n0 b0l0n0>b0l1n1 b0l0n0>b0l1n2 b0l0n2>b0l1n3 ' +
				'b0l0n0>b0l1n3 b0l1n3>b0l2n0 b0l1n1>b0l2n1 b0l0n3>b0l2n1 ' +
				'b0l1n0>b0l2n2 b0l1n1>b0l2n3 b0l0n0>b0l2n3 b0l2n0>hub ' +
				'b1l0n1>b1l1n0 b1l0n0>b1l1n1 b1l1n1>b1l2n0 b1l1n0>b1l2n1 ' +
				'b1l0n0>b1l2n1 b1l2n0>hub b1l0n0>hub b1src>b1l2n0 ' +
				'b2l0n1>b2l1n0 b2l0n0>b2l1n0 b2l0n0>b2l1n1 b2l0n1>b2l1n2 ' +
				'b2l0n2>b2l1n2 b2l0n2>b2l1n3 b2l1n0>b2l2n0 b2l0n0>b2l2n0 ' +
				'b2l2n0>b2l3n0 b2l2n0>b2l3n1 b2l3n1>b2l4n0 b2l2n0>b2l4n0 ' +
				'b2l3n0>b2l4n1 b2l2n0>b2l4n1 b2l4n0>hub b2src>b2l4n0 ' +
				'b3l0n0>b3l1n0 b3l0n0>b3l1n1 b3l0n0>b3l1n2 b3l0n0>b3l1n3 ' +
				'b3l1n3>b3l2n0 b3l1n3>b3l2n1 b3l1n3>b3l2n2 b3l2n0>hub ' +
				'b3src>b3l2n0'
		);
		const cost = drawnCost( at, edges );
		expect( [ cost.crossings.length, cost.over.length ] ).toEqual( [
			6, 3,
		] );
	} );

	it( 'reseats a source whose fallback moved no card, as any other', () => {
		// A seat that cut nothing does not open a row: the block reseats b1src
		// level with b1l4n0 rather than holding its band-level seat.
		const edges = [
			[ 'b0l0n1', 'b0l1n0' ],
			[ 'b0l0n0', 'b0l1n0' ],
			[ 'b0l1n0', 'hub' ],
			[ 'b0l0n0', 'hub' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n0', 'b1l1n1' ],
			[ 'b1l0n0', 'b1l1n2' ],
			[ 'b1l1n0', 'b1l2n0' ],
			[ 'b1l2n0', 'b1l3n0' ],
			[ 'b1l2n0', 'b1l3n1' ],
			[ 'b1l2n0', 'b1l3n2' ],
			[ 'b1l3n0', 'b1l4n0' ],
			[ 'b1l4n0', 'hub' ],
			[ 'b1l0n0', 'hub' ],
			[ 'b1src', 'b1l4n0' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const g = gridOf( { nodes: ids.map( ( id ) => ( { id } ) ), edges } );
		expect( g.b1src.row ).toBe( g.b1l4n0.row );
	} );

	it( 'opens a late source a row within three of what it feeds', () => {
		// No row near b2l4n0 leaves b2src's wire clear of every card, so it
		// takes the least-crossed row the seat search reaches, never a clear
		// one rows further off what it feeds.
		const edges = [
			[ 'b0l0n0', 'b0l1n0' ],
			[ 'b0l1n0', 'b0l2n1' ],
			[ 'b0l2n1', 'b0l3n2' ],
			[ 'b0l3n2', 'b0l4n0' ],
			[ 'b0l3n0', 'b0l4n0' ],
			[ 'b0l3n2', 'b0l4n1' ],
			[ 'b0l4n0', 'hub' ],
			[ 'b0src', 'b0l4n0' ],
			[ 'b1l0n0', 'b1l1n0' ],
			[ 'b1l0n0', 'b1l1n1' ],
			[ 'b1l0n0', 'hub' ],
			[ 'b2l0n1', 'b2l1n1' ],
			[ 'b2l1n1', 'b2l2n0' ],
			[ 'b2l2n0', 'b2l3n1' ],
			[ 'b2l3n1', 'b2l4n0' ],
			[ 'b2l4n0', 'hub' ],
			[ 'b2src', 'b2l4n0' ],
			[ 'b3l0n1', 'b3l1n0' ],
			[ 'b3l0n0', 'b3l1n0' ],
			[ 'b3l1n0', 'hub' ],
			[ 'b4l0n0', 'b4l1n0' ],
			[ 'b4l0n0', 'b4l1n1' ],
			[ 'b4l0n0', 'b4l1n2' ],
			[ 'b4l1n0', 'hub' ],
			[ 'b5l2n0', 'hub' ],
			[ 'b6l0n0', 'b6l1n0' ],
			[ 'b6l1n0', 'hub' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const g = gridOf( { nodes: ids.map( ( id ) => ( { id } ) ), edges } );
		const fed = edges
			.filter( ( e ) => 'b2src' === e.from )
			.map( ( e ) => g[ e.to ].row );
		const mid = ( Math.min( ...fed ) + Math.max( ...fed ) ) / 2;
		expect( g.b2src.col ).toBe( 0 );
		expect( Math.abs( g.b2src.row - mid ) ).toBeLessThanOrEqual( 3 );
	} );

	it( "runs a consumer band's source wire back to its hub clear of the band", () => {
		// k4src feeds hub0 and a node in the band hub0 feeds, so its wire runs
		// back across that band. No seat right of its band's first column
		// clears the middle tier, so it keeps that column, and no row opened
		// there clears every card: its wire to hub0 passes none, and the one
		// forward passes one. Pin which: a count alone passes just as well
		// when the wire goes missing, or crosses another.
		const graph = seedGraph( 'c71271' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'k4src→' )
			)
		).toEqual( [ 'k4src→k4l4n0 over k4l2n2' ] );
	} );

	it( "keeps the sweeps' order where an exchange draws worse", () => {
		// The exchange pass uncrosses a wire in this graph's column order, but
		// the rows the block passes then derive cross 5 wires, against 2 for
		// the sweeps' own order.
		const pairs = (
			'b0l0n0>b0l1n0 b0l0n1>b0l1n1 b0l0n0>b0l1n2 b0l1n1>b0l2n1 ' +
			'b0l1n0>b0l2n1 b0l1n2>b0l2n2 b0l0n0>hub b2l0n0>b2l1n0 ' +
			'b2l0n0>b2l1n1 b2l0n0>b2l1n2 b2l1n2>b2l2n0 b2l2n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).crossings ).toHaveLength( 2 );
		expect( drawn( nodes, edges ).over ).toHaveLength( 0 );
	} );

	it( 'keeps the cards off the long wires of a node only a hub feeds', () => {
		// a is fed by the hub alone, so inside its band it has no feeder:
		// taken for a source, its wire to c would take no placeholder and run
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
		expect( drawn( nodes, edges ).over ).toEqual( [] );
	} );

	it( 'seats a late source right of a hub it feeds from behind', () => {
		// b0src feeds hub and the end of a band hub feeds; in hub's column its
		// wire would cross hub's to b1l0n0.
		const x = xsOf(
			'b0l0n1>b0l1n0 b0l0n0>b0l1n0 b0l1n0>b0l2n0 b0l1n0>b0l2n2 ' +
				'b0l2n2>b0l3n0 hub>b0l0n0 b0src>b0l3n0 b0src>hub ' +
				'b1l0n0>b1l1n0 hub>b1l0n0 b1src>hub b2l5n0>hub b2src>hub'
		);
		expect( x.b0src ).toBeGreaterThan( x.hub );
		expect( x.b0src ).toBeLessThan( x.b0l3n0 );
	} );

	it( 'runs a late source right of its hub over no card (seed c134623)', () => {
		// k6src sits right of its hub, in a band that hub feeds.
		const graph = seedGraph( 'c134623' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'k6src→' )
			)
		).toEqual( [] );
	} );

	it( "runs a band head's wire back to its hub over no card (seed 703214)", () => {
		// k3l0n0 feeds hub0 and its own band's fan.
		const graph = seedGraph( '703214' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
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
		// k2l0n0 feeds columns 2 and 4. Seated last, its wires would lose their
		// placeholders, and those to column 4 would run over two of its own
		// successors in column 2.
		const graph = seedGraph( '82291' );
		const { nodes } = autoLayout( graph );
		expect(
			drawn( nodes, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'k2l0n0→' )
			)
		).toEqual( [] );
	} );

	it( 'seats a source left of every node it feeds', () => {
		// s feeds a1 and a3; seated by cost alone it would take column 2,
		// above a2, and draw its wire to a1 backward.
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
		expect( drawn( nodes, graph.edges ).over ).toEqual( [] );
	} );

	it( 'keeps a source in a band its hub feeds right of that hub', () => {
		// k6src feeds hub0 and its own band, which hub0 feeds; the fallback
		// sent it left of hub0, and its band wire crossed the hub's column.
		const g = gridOf( seedGraph( 'c190056' ) );
		expect( g.k6src.col ).toBeGreaterThan( g.hub0.col );
	} );

	it( 'keeps a sink fed only by a source level with it', () => {
		// zz has no feeder but x, so no sweep can seat it from x while x has
		// no row, and it would drop to the bottom of its column.
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
		// column's p cards it would sit rows from w0, and a re-spread to seat
		// it would move n0 after w0 had centred on it.
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
	// A browser-realm-shaped graph: five polled slices, six receiver slices,
	// and the four backbone nodes every slice is wired into.
	//
	// Fan-in over the non-dangling edges, which is what hub detection reads:
	//   X:tee 1, X:fetch 1, X:result 1, X:view 1, _http 1,
	//   topologies:shell 5 (the fetches), _output 6 (5 results and _http),
	//   _cwd 6 (5 fetches and _metadata).
	// The median fan-in of the fed nodes is 1, so the cut is max( 4, 3 ) = 4
	// and exactly topologies:shell, _output and _cwd clear it; a fetch at 1 does not,
	// and _http and _metadata are bridges: every neighbour they have is a hub.
	const POLL_SLICES = [ 'a', 'b', 'd', 'e', 'f' ];
	const VIEW_SLICES = [ 'c', 'g', 'h', 'i', 'j', 'k' ];

	// Every node an edge names, plus `extra` edgeless ones.
	const graphOf = ( edges, extra = [] ) => ( {
		nodes: [
			...new Set( [
				...extra,
				...edges.flatMap( ( e ) => [ e.from, e.to ] ),
			] ),
		].map( ( id ) => ( { id } ) ),
		edges,
	} );

	const hubGraph = () => {
		const edges = [];
		for ( const s of POLL_SLICES ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: `${ s }:result` },
				{ from: `${ s }:fetch`, to: 'topologies:shell' },
				{ from: `${ s }:fetch`, to: '_cwd' },
				{ from: `${ s }:result`, to: '_output' }
			);
		}
		for ( const s of VIEW_SLICES ) {
			edges.push( { from: `${ s }:in`, to: `${ s }:view` } );
		}
		edges.push(
			{ from: 'topologies:shell', to: '_http' },
			{ from: '_http', to: '_output' },
			{ from: '_metadata', to: '_cwd' }
		);
		return graphOf( edges, [ '_heartbeat' ] );
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

		// Each slice gets its own band: no two in one stack share a row.
		const stacks = {};
		for ( const s of [ ...POLL_SLICES, ...VIEW_SLICES ] ) {
			const poll = POLL_SLICES.includes( s );
			const head = at[ `${ s }:${ poll ? 'timer' : 'in' }` ];
			( stacks[ head.x ] ??= [] ).push(
				at[ `${ s }:${ poll ? 'tee' : 'in' }` ].y
			);
		}
		for ( const rows of Object.values( stacks ) ) {
			expect( new Set( rows ).size ).toBe( rows.length );
		}

		// A two-node slice spans two columns, not the whole graph's depth.
		expect( at[ 'c:view' ].x ).toBe( at[ 'c:in' ].x + X_STEP );

		// Every fed hub sits right of every band, and so does a bridge — a
		// node whose every neighbour is a hub — rather than stacking as a loner.
		const backbone = [
			'topologies:shell',
			'_http',
			'_output',
			'_cwd',
			'_metadata',
		];
		const fetchX = POLL_SLICES.map( ( s ) => at[ `${ s }:fetch` ].x );
		for ( const id of backbone ) {
			expect( at[ id ].x ).toBeGreaterThan( Math.max( ...fetchX ) );
		}
		expect( at._cwd.x ).toBeGreaterThan( at._metadata.x );

		// The hub chain topologies:shell -> _http -> _output takes three columns.
		expect( at._output.x ).toBeGreaterThan( at._http.x );
		expect( at._http.x ).toBeGreaterThan( at[ 'topologies:shell' ].x );

		// An edgeless node past the square's height waits for every other
		// block, then takes room the stacks leave, an empty row clear of every
		// card in its column, rather than opening a column right of them all.
		const others = Object.entries( at )
			.filter( ( [ id ] ) => '_heartbeat' !== id )
			.map( ( [ , p ] ) => p );
		expect( at._heartbeat.x ).toBeLessThan(
			Math.max( ...others.map( ( p ) => p.x ) )
		);
		expect(
			others.filter(
				( p ) =>
					p.x === at._heartbeat.x &&
					Math.abs( p.y - at._heartbeat.y ) < 2 * Y_STEP
			)
		).toEqual( [] );
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
		return graphOf( edges );
	};

	// Every component bands, hub or no hub: a two-node slice never stretches
	// to another component's depth. A hub leaves its component for the column
	// right after its feeders, on their middle row; an ordinary node stays.
	it( 'bands every component, and leaves a node three feed in its band', () => {
		const at = positionsOf( starGraph( 3 ) );
		// Three wires in open the gap; the pair opens none, so keeps a step.
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		expect( at.hub.x ).toBe( at.s0.x + 1.5 * X_STEP );
	} );

	it( 'treats a node four feed as a hub, half a column clear of its feeders on their middle row', () => {
		const at = positionsOf( starGraph( 4 ) );
		const feeders = [ 's0', 's1', 's2', 's3' ].map( ( id ) => at[ id ] );
		// The feeders, fed by nothing, take the canvas's first column.
		expect( feeders.map( ( p ) => p.x ) ).toEqual( [
			X_PAD,
			X_PAD,
			X_PAD,
			X_PAD,
		] );
		// The pair stacks in the hub's columns but opens none of its gaps.
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		// Half a step more, so the converging wires have room to fan in.
		expect( at.hub.x ).toBe(
			Math.max( ...feeders.map( ( p ) => p.x ) ) + 1.5 * X_STEP
		);
		const ys = feeders.map( ( p ) => p.y );
		expect( at.hub.y ).toBe(
			( Math.min( ...ys ) + Math.max( ...ys ) ) / 2
		);
	} );

	it( 'opens a half step only in the block whose wires meet there', () => {
		const at = positionsOf(
			graphOf( [
				{ from: 'tee', to: 'tee-4' },
				{ from: 'tee-2', to: 'tee-4' },
				{ from: 'tee-3', to: 'tee-4' },
				{ from: 'tee-4', to: 'tee-5' },
				{ from: 'tee-6', to: 'tee-7' },
				{ from: 'tee-7', to: 'tee-8' },
			] )
		);
		expect( at[ 'tee-4' ].x ).toBe( at.tee.x + 1.5 * X_STEP );
		expect( at[ 'tee-7' ].x ).toBe( at[ 'tee-6' ].x + X_STEP );
		expect( at[ 'tee-8' ].x ).toBe( at[ 'tee-7' ].x + X_STEP );
	} );

	it( "packs a block by its drawn width, so its half steps reach no other block's card", () => {
		// Two blocks of four busy boundaries each, two whole steps of half
		// steps, packed beside ten chains of seven.
		const edges = [];
		for ( const k of [ 0, 1 ] ) {
			for ( const i of [ 0, 1, 2, 3 ] ) {
				edges.push(
					{ from: `k${ k }a${ i }`, to: `k${ k }b${ i }` },
					{ from: `k${ k }b${ i }`, to: `k${ k }hub` }
				);
			}
			let prev = `k${ k }hub`;
			for ( const t of [ 1, 2, 3, 4 ] ) {
				for ( const i of [ 0, 1 ] ) {
					edges.push( {
						from: `k${ k }c${ t }${ i }`,
						to: `k${ k }t${ t }`,
					} );
				}
				edges.push( { from: prev, to: `k${ k }t${ t }` } );
				prev = `k${ k }t${ t }`;
			}
			edges.push( { from: prev, to: `k${ k }out` } );
		}
		for ( let z = 0; z < 10; z++ ) {
			for ( let i = 0; i < 6; i++ ) {
				edges.push( {
					from: `z${ z }n${ i }`,
					to: `z${ z }n${ i + 1 }`,
				} );
			}
		}
		const cards = Object.entries( positionsOf( graphOf( edges ) ) );
		// A card renders 196 wide and 84 tall.
		const overlaps = [];
		cards.forEach( ( [ a, p ], i ) => {
			for ( const [ b, q ] of cards.slice( i + 1 ) ) {
				if (
					Math.abs( p.x - q.x ) < 196 &&
					Math.abs( p.y - q.y ) < 84
				) {
					overlaps.push( `${ a }~${ b }` );
				}
			}
		} );
		expect( overlaps ).toEqual( [] );
	} );

	it( 'adds half a step at each busy boundary: gaps accumulate', () => {
		const edges = [];
		for ( const i of [ 0, 1, 2, 3 ] ) {
			edges.push(
				{ from: `a${ i }`, to: `b${ i }` },
				{ from: `b${ i }`, to: 'hub' }
			);
		}
		for ( const i of [ 0, 1, 2 ] ) {
			edges.push( { from: `c${ i }`, to: 'tail' } );
		}
		edges.push( { from: 'hub', to: 'tail' }, { from: 'tail', to: 'out' } );
		const at = positionsOf( graphOf( edges ) );

		expect( at.a0.x ).toBe( X_PAD );
		expect( at.b0.x ).toBe( X_PAD + X_STEP );
		expect( at.hub.x ).toBe( at.b0.x + 1.5 * X_STEP );
		expect( at.tail.x ).toBe( at.hub.x + 1.5 * X_STEP );
		// No hub in the last column: an ordinary step.
		expect( at.out.x ).toBe( at.tail.x + X_STEP );
	} );

	it( 'opens the gap before any node three wires enter, hub or not', () => {
		// The debug station's egress: six remotes and `_http` drain `_output`,
		// which is not a hub, since `_http` alone besides it is fed. `_http` takes
		// two wires, so its column keeps an ordinary step.
		const remotes = [ 'agg.p0', 'c.p0', 'c.p1', 'c.p2', 'c.p3', 'ni.p0' ];
		const edges = [
			{ from: '_heartbeat', to: '_http' },
			{ from: 'catalog:fetch', to: '_http' },
			{ from: '_http', to: '_output' },
			...remotes.map( ( r ) => ( { from: r, to: '_output' } ) ),
		];
		const at = positionsOf( graphOf( edges ) );

		expect( at._http.x ).toBe( at._heartbeat.x + X_STEP );
		expect( at._output.x ).toBe( at._http.x + 1.5 * X_STEP );
	} );

	it( 'opens the gap after a node three wires leave', () => {
		const at = positionsOf(
			graphOf( [
				{ from: 'consumer', to: 'tee' },
				{ from: 'tee', to: 'p0' },
				{ from: 'tee', to: 'p1' },
				{ from: 'tee', to: 'p2' },
			] )
		);

		expect( at.tee.x ).toBe( at.consumer.x + X_STEP );
		expect( at.p0.x ).toBe( at.tee.x + 1.5 * X_STEP );
	} );

	it( 'opens no gap where the busy wires skip the next column', () => {
		// request-builder's shape: four wires leave, one to the next column, and
		// three run on to the column after it, where the tee also lands.
		const at = positionsOf(
			graphOf( [
				{ from: 'src', to: 'rb' },
				{ from: 'rb', to: 'tee' },
				{ from: 'tee', to: 'g' },
				{ from: 'rb', to: 'g' },
				{ from: 'rb', to: 'p0' },
				{ from: 'rb', to: 'p1' },
			] )
		);

		expect( at.tee.x ).toBe( at.rb.x + X_STEP );
		expect( at.g.x ).toBe( at.tee.x + X_STEP );
		expect( at.p0.x ).toBe( at.g.x );
	} );

	it( "orders a sink by its own feeders, not a late source's provisional seat", () => {
		// The live firehose shape: `tick` is seated last beside `sieve`, so
		// its column-0 seat during the sweeps must not pull `jobs` above `done`.
		const edges = [
			{ from: 'hose', to: 'rb' },
			{ from: 'hose', to: 'router' },
			{ from: 'rb', to: 'req' },
			{ from: 'rb', to: 'alerts' },
			{ from: 'rb', to: 'err' },
			{ from: 'rb', to: 'gyro' },
			{ from: 'rb', to: 'tee' },
			{ from: 'tee', to: 'gyro' },
			{ from: 'tee', to: 'done' },
			{ from: 'intake', to: 'router' },
			{ from: 'router', to: 'sieve' },
			{ from: 'sieve', to: 'jobs' },
			{ from: 'tick', to: 'jobs' },
		];
		const at = positionsOf( graphOf( edges ) );

		expect( at.tee.y ).toBeLessThan( at.sieve.y );
		expect( at.done.y ).toBeLessThan( at.jobs.y );
	} );

	it( 'orders a sink by its own column even when its feeder is shared', () => {
		// sieve serves two in the last column, so tick alone told jobs apart:
		// its column-0 seat, not sieve's, set jobs above done.
		const at = positionsOf(
			graphOf( [
				{ from: 'hose', to: 'rb' },
				{ from: 'hose', to: 'router' },
				{ from: 'rb', to: 'req' },
				{ from: 'rb', to: 'alerts' },
				{ from: 'rb', to: 'err' },
				{ from: 'rb', to: 'gyro' },
				{ from: 'rb', to: 'tee' },
				{ from: 'tee', to: 'gyro' },
				{ from: 'tee', to: 'done' },
				{ from: 'intake', to: 'router' },
				{ from: 'router', to: 'sieve' },
				{ from: 'sieve', to: 'jobs' },
				{ from: 'sieve', to: 'dlq' },
				{ from: 'tick', to: 'jobs' },
			] )
		);

		expect( at.tee.y ).toBeLessThan( at.sieve.y );
		expect( at.done.y ).toBeLessThan( at.jobs.y );
	} );

	it( 'settles the anchor on rows its own order laid, not the sweep order', () => {
		// The aggregator status graph: a shared tee feeds both fetchers, and
		// each slice's receiver tee feeds its fetcher and its view. The fetchers
		// meet in the middle; each view sits outside, beside its own tee.
		const at = positionsOf(
			graphOf( [
				{ from: 'aggregator:timer', to: 'aggregator:tee' },
				{ from: 'aggregator:tee', to: 'summary:fetch' },
				{ from: 'aggregator:tee', to: 'servers:fetch' },
				{ from: 'summary:in', to: 'summary:fetch' },
				{ from: 'summary:in', to: 'summary:view' },
				{ from: 'servers:in', to: 'servers:fetch' },
				{ from: 'servers:in', to: 'servers:view' },
			] )
		);
		const column = [
			'servers:view',
			'servers:fetch',
			'summary:fetch',
			'summary:view',
		];

		const byRow = [ ...column ].sort( ( a, b ) => at[ a ].y - at[ b ].y );
		expect( [ column, [ ...column ].reverse() ] ).toContainEqual( byRow );
	} );

	it( 'straddles a late source and a card fanning to the same spokes', () => {
		// The hub's shape: `sync` and `discover` each feed all three spokes.
		const spokes = [ 'bdn', 'dp1', 'dp2' ];
		const at = positionsOf(
			graphOf( [
				{ from: 'consumer', to: 'sync' },
				...spokes.flatMap( ( s ) => [
					{ from: 'sync', to: s },
					{ from: 'discover', to: s },
					{ from: s, to: 'null' },
				] ),
			] )
		);

		expect( at.discover.x ).toBe( at.sync.x );
		expect(
			[ at.discover.y, at.sync.y ].sort( ( a, b ) => a - b )
		).toEqual( [ at.dp1.y - Y_STEP / 2, at.dp1.y + Y_STEP / 2 ] );
		expect( at.consumer.y ).toBe( at.sync.y );
	} );

	it( 'keeps a chain level where a late source lands right of the anchor', () => {
		// @longform A five-card column of tees anchors the layout, left of the
		// pair. Rows seat rightward from the anchor, so a straddle there would
		// re-spread sync's column after the spokes centred on it: sync holds.
		const spokes = [ 'bdn', 'dp1', 'dp2' ];
		const at = positionsOf(
			graphOf( [
				...[ 0, 1, 2, 3, 4 ].map( ( i ) => ( {
					from: 'root',
					to: `t${ i }`,
				} ) ),
				{ from: 't0', to: 'consumer' },
				{ from: 't1', to: 'consumer' },
				{ from: 't2', to: 'sync' },
				{ from: 't3', to: 'sync' },
				{ from: 't4', to: 'leaf' },
				{ from: 'consumer', to: 'sync' },
				...spokes.flatMap( ( s ) => [
					{ from: 'sync', to: s },
					{ from: 'discover', to: s },
				] ),
			] )
		);

		expect( at.discover.x ).toBe( at.sync.x );
		expect( at.sync.y ).toBe( at.dp1.y );
		expect( Math.abs( at.discover.y - at.sync.y ) ).toBe( Y_STEP );
	} );

	it( 'opens one gap where three wires leave and three enter across a boundary', () => {
		const at = positionsOf(
			graphOf( [
				{ from: 'src', to: 'tee' },
				{ from: 'tee', to: 'm' },
				{ from: 'tee', to: 'a' },
				{ from: 'tee', to: 'b' },
				{ from: 'q', to: 'm' },
				{ from: 'r', to: 'm' },
			] )
		);

		expect( at.m.x ).toBe( at.tee.x + 1.5 * X_STEP );
	} );

	it( 'leaves a node fanning out to seven in its band: only fan-in makes a hub', () => {
		const at = positionsOf( starGraph( 7, true ) );
		expect( at.y.x - at.x.x ).toBe( X_STEP );
		// Seven wires leave the hub, so half a step opens after its column.
		expect( at.hub.x ).toBe( at.s0.x - 1.5 * X_STEP );
	} );

	// The debug sheet as a log-viewer realm draws it: two polled slices, so
	// the widest fan-in is two and nothing is a hub. Each chain takes a column
	// per node, on rows of its own.
	it( 'bands a hubless sheet: no chain stretches to the far column', () => {
		const edges = [
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
				{ from: `${ s }:fetch`, to: 'topologies:shell' },
				{ from: `${ s }:fetch`, to: '_cwd' }
			);
		}
		const ids = new Set( [
			'_completion',
			'_stdout',
			'_stream',
			'log-viewer-rail:timer',
		] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const at = positionsOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );

		expect( at[ 'log-viewer:view' ].x ).toBe(
			at[ 'log-viewer:stream' ].x + X_STEP
		);
		expect( at._output.x ).toBe( at._heartbeat.x + 2 * X_STEP );
		// Each chain runs across one row, and the two share none with the slices.
		expect( at[ 'log-viewer:view' ].y ).toBe( at[ 'log-viewer:stream' ].y );
		expect( at._output.y ).toBe( at._heartbeat.y );
		const sliceYs = [ 'step', 'catalog' ].flatMap( ( s ) =>
			[ 'timer', 'tee', 'fetch', 'in', 'result' ].map(
				( p ) => at[ `log-viewer-${ s }:${ p }` ].y
			)
		);
		for ( const y of [ at[ 'log-viewer:stream' ].y, at._heartbeat.y ] ) {
			expect( sliceYs ).not.toContain( y );
		}
	} );

	// The station's own realm as the debug sheet draws it: five polled slices
	// whose fetchers all target `topologies:shell`, which feeds nothing back. One
	// layering cannot hold a slice together here: the sweep against the flow
	// keys every feeder of `topologies:shell` alike, so a slice's `in` and `timer`
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
				{ from: `${ s }:fetch`, to: 'topologies:shell' },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` }
			);
		}
		edges.push(
			{ from: 'topicprobe:stream', to: 'topicprobe:view' },
			{ from: '_metadata', to: '_cwd' },
			{ from: '_heartbeat', to: '_http' },
			{ from: '_http', to: '_output' }
		);
		const ids = new Set( [
			'_completion',
			'_stdout',
			'_stream',
			'freshness:timer',
		] );
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
			expect( at[ 'topologies:shell' ].x ).toBeGreaterThan(
				at[ `${ s }:fetch` ].x
			);
		}
	} );

	// @longform A band wired to two hubs picks one home and keeps its wires to
	// the other, whose block the packer would place on its own — leaving the
	// wire nothing holding its direction, so it runs right to left. A wire
	// between two blocks means they are one block, and these three seeds each
	// carry such a wire.
	it.each( [ '29924', '703214', 'c134623' ] )(
		'draws no wire backward across what were two blocks (seed %s)',
		( seed ) => {
			const g = {
				nodes: SEEDS[ seed ].nodes.map( ( id ) => ( { id } ) ),
				edges: SEEDS[ seed ].edges.map( ( [ from, to ] ) => ( {
					from,
					to,
				} ) ),
			};
			const at = positionsOf( g );
			const backward = g.edges.filter(
				( e ) => at[ e.to ].x < at[ e.from ].x
			);
			expect( backward ).toEqual( [] );
		}
	);

	// @longform An egress drained by two slices and one stray two-node chain:
	// the stray part is under SLICE_MIN, and refusing the whole promotion for
	// it stranded `hub0` and `k0l1n0` in a column of their own, eight wide.
	// A part too small is nobody else's business; one too big, or one another
	// hub already serves, still refuses.
	it( 'promotes an egress its qualifying slices drain, past one stray feeder', () => {
		const edges = [
			[ 'k0l0n0', 'k0l1n0' ],
			[ 'k0l0n0', 'k0l1n1' ],
			[ 'k0l0n0', 'k0l1n2' ],
			[ 'k0src', 'k0l1n0' ],
			[ 'k0l1n2', 'hub0' ],
			[ 'k1l0n0', 'k1l1n0' ],
			[ 'k1l0n0', 'k1l1n1' ],
			[ 'k1l0n0', 'k1l1n2' ],
			[ 'k1l0n0', 'k1l2n0' ],
			[ 'k1l1n0', 'k1l2n1' ],
			[ 'k1l1n2', 'hub0' ],
			[ 'k2l0n1', 'k2l1n0' ],
			[ 'k2l0n0', 'k2l1n0' ],
			[ 'k2l0n0', 'k2l1n1' ],
			[ 'k2l0n1', 'k2l1n2' ],
			[ 'k2l0n2', 'k2l1n3' ],
			[ 'k2l1n2', 'k2l2n0' ],
			[ 'k2l2n0', 'k2l3n0' ],
			[ 'k2l2n0', 'k2l3n1' ],
			[ 'k2src', 'k2l3n0' ],
			[ 'k2l1n3', 'hub0' ],
		].map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = new Set( [ 'lone0', 'lone1' ] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const at = positionsOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		// The edgeless pair stacks past the sheet; only the sheet counts.
		const columns = Object.entries( at )
			.filter( ( [ id ] ) => ! id.startsWith( 'lone' ) )
			.map( ( [ , p ] ) => p.x );
		const wide =
			( Math.max( ...columns ) - Math.min( ...columns ) ) / X_STEP + 1;

		// Parts of five and six nodes qualify and the two-node one abstains,
		// so the egress leaves its band and the sheet stays four columns, plus
		// two half steps where three wires meet — refusing on the stray part
		// would run it to eight.
		expect( wide ).toBeLessThanOrEqual( 5 );
	} );

	// The same shape at three slices, as the debug overlay's Sessions page
	// draws it. Three feeders sit under the hub cut, so without this nothing
	// subtracts `topologies:shell` and one band holds all three: the sweep against the
	// flow keys every feeder of it alike and pulls the slices' rows together.
	it( 'keeps each of three slices sharing one egress in its own band', () => {
		const slices = [ 'sessions', 'sessions:create', 'sessions:revoke' ];
		const edges = [];
		for ( const s of slices ) {
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: 'topologies:shell' },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` }
			);
		}
		const ids = new Set();
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		const at = positionsOf( {
			nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
			edges,
		} );
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
			expect( at[ 'topologies:shell' ].x ).toBeGreaterThan(
				at[ `${ s }:fetch` ].x
			);
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
		// Six wires enter each sink, so their column opens half a step clear.
		for ( const id of sinks ) {
			expect( at[ id ].x ).toBe( X_PAD + 1.5 * X_STEP );
		}
		// The pair's one wire opens no gap of its own.
		expect( at.y.x ).toBe( X_PAD + X_STEP );
	} );

	// @longform The station's fleet board: ONE batched poll whose tee feeds the
	// fetchers of TWO slices, so both land in a single band. Keyed on the mean
	// of its feeders, `worker-status:fetch` followed that shared tee and sorted
	// above `topology-manager:view`, splitting each slice across the other's
	// rows. Its other feeder serves only its own slice, and that is the one to
	// key on.
	const fleetBoard = () => {
		const edges = [];
		const slice = ( s ) =>
			edges.push(
				{ from: `${ s }:timer`, to: `${ s }:tee` },
				{ from: `${ s }:tee`, to: `${ s }:fetch` },
				{ from: `${ s }:in`, to: `${ s }:result` },
				{ from: `${ s }:in`, to: `${ s }:fetch` },
				{ from: `${ s }:fetch`, to: 'topologies:shell' }
			);
		slice( 'topologies:activate' );
		slice( 'topologies:deactivate' );
		slice( 'workers:restart' );
		edges.push(
			{ from: 'topology-manager:timer', to: 'topology-manager:tee' },
			{ from: 'topology-manager:tee', to: 'worker-status:fetch' },
			{ from: 'topology-manager:tee', to: 'topology-manager:fetch' },
			{ from: 'worker-status:fetch', to: 'topologies:shell' },
			{ from: 'topology-manager:fetch', to: 'topologies:shell' },
			{ from: 'worker-status:in', to: 'worker-status:transform' },
			{ from: 'worker-status:in', to: 'worker-status:fetch' },
			{ from: 'worker-status:transform', to: 'worker-status:view' },
			{ from: 'topology-manager:in', to: 'topology-manager:view' },
			{ from: 'topology-manager:in', to: 'topology-manager:fetch' },
			{ from: '_heartbeat', to: '_http' },
			{ from: '_http', to: '_output' },
			{ from: '_metadata', to: '_cwd' },
			{ from: 'topicprobe:stream', to: 'topicprobe:view' }
		);
		const ids = new Set( [
			'_completion',
			'_stdout',
			'_stream',
			'freshness:timer',
		] );
		for ( const e of edges ) {
			ids.add( e.from );
			ids.add( e.to );
		}
		return { nodes: [ ...ids ].map( ( id ) => ( { id } ) ), edges };
	};

	it( 'seats a view beside its own fetcher where one tee feeds two slices', () => {
		const at = positionsOf( fleetBoard() );
		const span = ( ids ) => {
			const ys = ids.map( ( id ) => at[ id ].y );
			return [ Math.min( ...ys ), Math.max( ...ys ) ];
		};

		// Each view sits within a row of the fetcher answering into it.
		for ( const s of [ 'topology-manager', 'worker-status' ] ) {
			expect(
				Math.abs( at[ `${ s }:view` ].y - at[ `${ s }:fetch` ].y )
			).toBeLessThanOrEqual( Y_STEP );
		}

		// And neither slice's rows straddle the other's.
		const spans = [
			span( [ 'topology-manager:fetch', 'topology-manager:view' ] ),
			span( [ 'worker-status:fetch', 'worker-status:view' ] ),
		].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		expect( spans[ 1 ][ 0 ] ).toBeGreaterThan( spans[ 0 ][ 1 ] );
	} );
} );

describe( 'autoLayout — clearance across a hub gap', () => {
	it( 'keeps a band card off its hub wire where the half step before the hub bends it', () => {
		// Three chains feed the hub from the column before it, so a half step
		// opens there and `a`'s wire to the hub runs half a step longer.
		const pairs = [
			[ 'a', 'b' ],
			[ 'b', 'c' ],
			[ 'b', 'd' ],
			[ 'a', 'hub' ],
		];
		for ( let i = 0; i < 3; i++ ) {
			pairs.push(
				[ `x${ i }c0`, `x${ i }c1` ],
				[ `x${ i }c1`, `x${ i }c2` ],
				[ `x${ i }c2`, 'hub' ]
			);
		}
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [ ...new Set( pairs.flat() ) ];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		const at = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at.hub.x - at.x0c2.x ).toBe( 1.5 * X_STEP );
		expect(
			drawn( nodes, edges ).over.filter( ( o ) =>
				/^a→hub over [bcd]$/.test( o )
			)
		).toEqual( [] );
	} );
} );

describe( 'autoLayout — a band moved toward its hub keeps its block’s order', () => {
	it( 'lays the moved band in the sweeps’ plain order where its block kept that order', () => {
		// Three slices feed one hub. The block keeps the plain order, and band
		// b0's last card, which feeds the hub, moves into the column b2's last
		// card holds; laid out in that order, no b0 wire crosses another.
		const pairs = (
			'b0l0n1>b0l1n0 b0l0n0>b0l1n0 b0l0n0>b0l1n1 b0l0n1>b0l1n2 ' +
			'b0l0n1>b0l1n3 b0l1n0>hub b2l0n0>b2l1n0 b2l0n0>b2l1n1 ' +
			'b2l0n0>b2l1n3 b2l1n0>b2l2n0 b2l2n0>hub b3l0n0>b3l1n0 ' +
			'b3l1n0>hub'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		const at = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at.b0l1n0.x ).toBe( at.b2l2n0.x );
		expect(
			drawn( nodes, edges ).crossings.filter( ( c ) =>
				/^b0\S+ × b0/.test( c )
			)
		).toEqual( [] );
	} );
} );

describe( 'autoLayout — a seat measures the half steps earlier seats opened', () => {
	it( 'seats a late source off a hub wire, at the columns’ final x', () => {
		// Six slices into one hub; three hold a source seated last. Each seat
		// can open a half step, which bends `k3l0n1`'s wire to the hub.
		const pairs = (
			'k0l0n0>k0l1n0 k0l0n0>k0l1n1 k0l0n1>k0l1n2 k0l1n0>k0l2n0 ' +
			'k0l1n1>k0l2n1 k0l2n1>k0l3n0 k0l1n2>k0l3n0 k0l2n0>k0l3n1 ' +
			'k0l3n0>hub0 k1l0n1>k1l1n0 k1l0n0>k1l1n1 k2l0n1>k2l1n0 ' +
			'k2l0n2>k2l1n1 k2l1n1>k2l2n0 k2l2n0>k2l3n0 k2l2n0>k2l3n1 ' +
			'k2l1n1>k2l3n1 k2src>k2l3n1 k2l0n2>hub0 k3l0n1>k3l1n0 ' +
			'k3l1n0>k3l2n0 k3l0n0>k3l2n0 k3l2n0>k3l3n0 k3l0n2>k3l3n0 ' +
			'k3src>k3l3n0 k3l0n1>hub0 k4l0n0>k4l1n0 k4l0n0>k4l1n1 ' +
			'k4l1n0>k4l2n0 k4l0n0>k4l2n0 k4l1n1>k4l2n1 k4l1n0>k4l2n2 ' +
			'k4l0n0>k4l2n2 k4src>k4l2n2 k4l1n1>hub0 k5l0n1>k5l1n0 ' +
			'k5l1n0>k5l2n0 k5l0n0>k5l2n0 k5l1n0>k5l2n1 k5l2n0>hub0'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const ids = [ ...new Set( [ ...pairs.flat(), 'k2l0n0', 'k5l0n2' ] ) ];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect(
			drawn( nodes, edges ).over.filter( ( o ) =>
				/ over k3src$/.test( o )
			)
		).toEqual( [] );
	} );
} );

describe( 'autoLayout — a seat measures the half step its own move closes', () => {
	it( 'seats a card that fans level with its long wire', () => {
		// e fans alone into f0 to f3 and runs one wire on to x0. Level with
		// that wire it draws 2 crossings, where between its fan's first two
		// targets it draws 5.
		const { at, edges } = laidOut(
			't>e e>f0 f0>g0 h0>g0 e>f1 e>f2 f2>g2 e>f3 f3>g3 k0>k1 k1>k2 ' +
				'e>x0 k2>x0'
		);
		const cost = drawnCost( at, edges );
		expect( [ cost.crossings.length, cost.over.length ] ).toEqual( [
			2, 0,
		] );
	} );

	it( 'packs no block into the half step a chain head steps into', () => {
		// a:c0 steps into the half step a:tee's fan opens; lone0 stays out of
		// it, as out of any half step between two columns.
		const graph = wired(
			'a:tee>a:f0 a:in0>a:f0 a:tee>a:f1 a:in1>a:f1 a:tee>a:f2 ' +
				'a:in2>a:f2 a:timer>a:tee a:src0>a:c0 a:c0>a:v0 a:in0>a:c0 ' +
				'a:src1>a:c1 a:c1>a:v1 a:in1>a:c1 z0:0>z0:1'
		);
		graph.nodes.push( { id: 'lone0' } );
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at[ 'a:c0' ].x - at[ 'a:tee' ].x ).toBe( X_STEP / 2 );
		expect( [
			at.lone0.x,
			at.lone0.x > at[ 'a:tee' ].x && at.lone0.x < at[ 'a:f0' ].x,
		] ).toEqual( [ at.lone0.x, false ] );
	} );

	it.each( [
		[
			'k0l1n0>hub k2l1n0>hub k4l0n1>k4l1n0 k4l0n1>k4l1n1 ' +
				'k4l0n1>k4l1n3 k4l0n2>k4l1n3 k4l1n0>k4l2n0 k4l1n0>k4l2n1 ' +
				'k4l1n1>k4l2n1 k4l1n0>k4l2n2 k4l2n0>k4l3n0 k4l2n2>k4l3n1 ' +
				'k4l2n2>k4l3n2 k4l2n0>k4l3n3 k4l2n1>k4l3n4 k4l3n0>k4c0x0 ' +
				'k4c0x1>k4c0x2 k4c0x2>k4l3n0 k4l0n2>k4c1x0 k4c1x0>k4c1x1 ' +
				'k4c1x1>k4c1x2 k4c1x2>k4c1x3 k4l3n0>hub k5l4n3>k5l5n0 ' +
				'k5l0n1>k5c0x0 k5c0x0>k5c0x1 k5c0x1>k5c0x2 k5c0x2>k5l5n0 ' +
				'k5l5n0>hub k5src>k5l5n0',
		],
		[
			'k0l4n0>hub k2l0n4>k2l1n0 k2l0n1>k2l1n0 k2l0n3>k2l1n2 ' +
				'k2l0n4>k2l1n3 k2l0n3>k2l1n4 k2l0n1>k2l1n4 k2l1n0>k2c0x0 ' +
				'k2c0x0>k2c0x1 k2c0x1>k2c0x2 k2l1n0>hub k4l0n0>k4l1n2 ' +
				'k4l1n2>k4l2n0 k4l2n0>k4l3n0 k4l1n2>k4l3n0 k4l2n0>k4l3n1 ' +
				'k4l2n0>k4l3n2 k4l0n2>k4l3n3 k4l3n4>k4l4n0 k4l3n4>k4l4n1 ' +
				'k4l3n3>k4l4n2 k4l3n1>k4l4n1 k4l3n1>k4l4n2 k4l3n1>k4l4n3 ' +
				'k4l4n0>hub',
		],
	] )( 'steps no chain head onto a card of the next column', ( wires ) => {
		// A head steps a step short of its follower's column, wherever its
		// follower steps, so no card reaches past its own column's half step.
		const { at } = laidOut( wires );
		const ids = Object.keys( at );
		const overlapping = ids.flatMap( ( a ) =>
			ids
				.filter(
					( b ) =>
						a < b &&
						Math.abs( at[ a ].x - at[ b ].x ) < NODE_W &&
						Math.abs( at[ a ].y - at[ b ].y ) < NODE_H
				)
				.map( ( b ) => `${ a } ${ b }` )
		);
		expect( overlapping ).toEqual( [] );
	} );

	it( 'seats no fan by its first targets where a late source feeds it (seed 87109)', () => {
		// k1src, seated last, feeds k1l3n3 of k1l2n0's fan; k1l2n0 keeps its
		// fan's middle, and k1src's wire crosses none of the fan's.
		const edges = SEEDS[ '87109' ].edges.map( ( [ from, to ] ) => ( {
			from,
			to,
		} ) );
		const { nodes } = autoLayout( {
			nodes: SEEDS[ '87109' ].nodes.map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).crossings ).toEqual( [] );
	} );

	it( 'seats a fanning source clear of the cards beside the column it leaves', () => {
		// k2l0n0 fans into column 2: its seat in column 0 closes the half
		// step its wires open from column 1, and its wire to k2l2n0 clears
		// k2l1n3 on the columns as they stand with it seated there.
		const pairs = (
			'k2l0n1>k2l1n0 k2l0n1>k2l1n1 k2l0n0>k2l1n2 k2l0n1>k2l1n3 ' +
			'k2l0n1>k2l1n4 k2l0n0>k2l1n4 k2l0n0>k2l1n5 k2l0n1>k2l1n6 ' +
			'k2l0n1>k2l1n7 k2l0n0>k2l1n8 k2l0n1>k2l1n8 k2l0n0>k2l2n0 ' +
			'k2l1n3>k2l2n0 k2l2n0>k2l3n0 k2l0n1>k2l3n1 k2l2n0>k2l4n0 ' +
			'k2l3n1>k2l4n1 k2l1n2>k2l4n2 k2l3n0>k2l4n2 k2src>k2l4n0'
		)
			.split( ' ' )
			.map( ( p ) => p.split( '>' ) );
		const edges = pairs.map( ( [ from, to ] ) => ( { from, to } ) );
		const { nodes } = autoLayout( {
			nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( { id } ) ),
			edges,
		} );
		expect( drawn( nodes, edges ).over ).toEqual( [] );
	} );
} );

describe( 'autoLayout — a waiting block grows a stack before it widens the canvas', () => {
	it( 'stacks a small run under the first stack rather than open a third', () => {
		// The square is 17 rows: eight three-card chains, a row apart, fill
		// stack 0 to row 14, nine two-card chains wait and open stack 1, and
		// the two lone cards fit under stack 0 within the square's height.
		const edges = [];
		for ( let i = 0; i < 8; i++ ) {
			const id = `a${ String( i ).padStart( 2, '0' ) }`;
			edges.push(
				{ from: `${ id }:x`, to: `${ id }:y` },
				{ from: `${ id }:y`, to: `${ id }:z` }
			);
		}
		for ( let i = 0; i < 9; i++ ) {
			const id = `b${ String( i ).padStart( 2, '0' ) }`;
			edges.push( { from: `${ id }:x`, to: `${ id }:y` } );
		}
		const ids = [
			'lone:p',
			'lone:q',
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		];
		const { nodes } = autoLayout( {
			nodes: ids.map( ( id ) => ( { id } ) ),
			edges,
		} );
		const at = Object.fromEntries(
			nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const right = Math.max(
			...ids
				.filter( ( id ) => id.startsWith( 'b' ) )
				.map( ( id ) => at[ id ].x )
		);
		expect( ids.filter( ( id ) => at[ id ].x > right ) ).toEqual( [] );
		expect( at[ 'lone:p' ].x ).toBe( at[ 'a00:x' ].x );
	} );
} );

describe( 'autoLayout — tight bands, a row between groups, a card beside its feeder', () => {
	/**
	 * Each card's column and row in X_STEP and Y_STEP units from `first`.
	 *
	 * @param {Object<string,{x: number, y: number}>} at    Position by id.
	 * @param {string}                                first The stack's first card.
	 * @param {Array<[string, number, number]>}       cards Each card, column and row.
	 * @return {Array<[string, number, number]>} What the layout gives each.
	 */
	const relative = ( at, first, cards ) =>
		cards.map( ( [ id ] ) => [
			id,
			( at[ id ].x - at[ first ].x ) / X_STEP,
			( at[ id ].y - at[ first ].y ) / Y_STEP,
		] );

	/**
	 * Lay a graph given as wire pairs out.
	 *
	 * @param {Array<[string, string]>} pairs The wires.
	 * @return {Object<string,{x: number, y: number}>} Position by id.
	 */
	const layOut = ( pairs ) =>
		Object.fromEntries(
			autoLayout( {
				nodes: [ ...new Set( pairs.flat() ) ].map( ( id ) => ( {
					id,
				} ) ),
				edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
			} ).nodes.map( ( n ) => [ n.id, n.position ] )
		);

	/**
	 * A `useCommandOnce` slice's wires: a timer through a tee into the
	 * fetcher, and the receiver feeding the fetcher and its gate, which
	 * feeds the result.
	 *
	 * @param {string} s   The scope.
	 * @param {string} hub What the fetcher feeds.
	 * @return {Array<[string, string]>} The wires.
	 */
	const oneShot = ( s, hub ) => [
		[ `${ s }:timer`, `${ s }:tee` ],
		[ `${ s }:tee`, `${ s }:fetch` ],
		[ `${ s }:in`, `${ s }:fetch` ],
		[ `${ s }:in`, `${ s }:in:current` ],
		[ `${ s }:in:current`, `${ s }:result` ],
		[ `${ s }:fetch`, hub ],
	];

	/**
	 * A one-shot slice's six cards from its timer's row `r`.
	 *
	 * @param {string} s The scope.
	 * @param {number} r The timer's row.
	 * @param {number} f The fetcher's column.
	 * @return {Array<[string, number, number]>} Each card, column and row.
	 */
	const oneShotAt = ( s, r, f = 2 ) => [
		[ `${ s }:timer`, 0, r ],
		[ `${ s }:tee`, 1, r ],
		[ `${ s }:fetch`, f, 2 === f ? r + 0.5 : r ],
		[ `${ s }:in`, 0, r + 1 ],
		[ `${ s }:in:current`, 1, r + 1.5 ],
		[ `${ s }:result`, 2, r + 1.5 ],
	];

	// The station's fleet board, wired as `useTopologyManager` mounts it.
	const fleet = [
		...oneShot( 'topologies:activate', 'topologies:shell' ),
		...oneShot( 'topologies:deactivate', 'topologies:shell' ),
		...oneShot( 'workers:restart', 'topologies:shell' ),
		[ 'topology-manager:in', 'topology-manager:in:current' ],
		[ 'topology-manager:in:current', 'topology-manager:view' ],
		[ 'topology-manager:in', 'topology-manager:fetch' ],
		[ 'topology-manager:timer', 'topology-manager:tee' ],
		[ 'topology-manager:tee', 'topology-manager:fetch' ],
		[ 'topology-manager:tee', 'worker-status:fetch' ],
		[ 'topology-manager:fetch', 'topologies:shell' ],
		[ 'worker-status:fetch', 'topologies:shell' ],
		[ 'worker-status:in', 'worker-status:fetch' ],
		[ 'worker-status:in', 'worker-status:in:current' ],
		[ 'worker-status:in:current', 'worker-status:transform' ],
		[ 'worker-status:transform', 'worker-status:view' ],
		[ '_heartbeat', '_http' ],
		[ '_http', '_output' ],
		[ '_metadata', '_cwd' ],
		[ 'topicprobe:stream', 'topicprobe:view' ],
	];

	// @longform A url-detail band between two one-shots, all three feeding
	// `egress`: the middle band's timer feeds its fetcher two columns on, and
	// its view chain reaches a column past the one-shots' results.
	const urlGroup = [
		...oneShot( 'a', 'egress' ),
		[ 'b:timer', 'b:fetch' ],
		[ 'b:in', 'b:fetch' ],
		[ 'b:in', 'b:in:current' ],
		[ 'b:in:current', 'b:transform' ],
		[ 'b:transform', 'b:view' ],
		[ 'b:fetch', 'egress' ],
		...oneShot( 'c', 'egress' ),
	];

	it( 'stacks the bands feeding one hub as tight as their columns allow', () => {
		const at = layOut( urlGroup );
		const table = [
			[ 'a:timer', 0, 0 ],
			[ 'b:timer', 0, 2 ],
			[ 'c:timer', 0, 4.5 ],
		];
		expect( relative( at, 'a:timer', table ) ).toEqual( table );
		// Each band sits a row below the card above it in its tightest column.
		const rowOf = ( id ) => ( at[ id ].y - at[ 'a:timer' ].y ) / Y_STEP;
		const colOf = ( id ) => ( at[ id ].x - at[ 'a:timer' ].x ) / X_STEP;
		const cards = [ ...new Set( urlGroup.flat() ) ].filter(
			( id ) => 'egress' !== id
		);
		for ( const [ band, above ] of [
			[ 'b', [ 'a' ] ],
			[ 'c', [ 'a', 'b' ] ],
		] ) {
			const gaps = cards
				.filter( ( id ) => id.startsWith( `${ band }:` ) )
				.flatMap( ( id ) =>
					cards
						.filter(
							( o ) =>
								above.some( ( s ) =>
									o.startsWith( `${ s }:` )
								) && colOf( o ) === colOf( id )
						)
						.map( ( o ) => rowOf( id ) - rowOf( o ) )
				);
			expect( [ band, Math.min( ...gaps ) ] ).toEqual( [ band, 1 ] );
		}
	} );

	it( 'leaves exactly one empty row between groups stacked in one column', () => {
		const at = layOut( [
			...oneShot( 'g1a', 'g1:egress' ),
			...oneShot( 'g1b', 'g1:egress' ),
			...oneShot( 'g2a', 'g2:egress' ),
			...oneShot( 'g2b', 'g2:egress' ),
			[ 'z:head', 'z:mid' ],
			[ 'z:mid', 'z:tail' ],
		] );
		const rows = ( prefix ) =>
			Object.keys( at )
				.filter( ( id ) => id.startsWith( prefix ) )
				.map( ( id ) => ( at[ id ].y - at[ 'g1a:timer' ].y ) / Y_STEP );
		const bottom = ( prefix ) => Math.max( ...rows( prefix ) );
		const top = ( prefix ) => Math.min( ...rows( prefix ) );
		expect( at[ 'g2a:timer' ].x ).toBe( at[ 'g1a:timer' ].x );
		expect( at[ 'z:head' ].x ).toBe( at[ 'g1a:timer' ].x );
		expect( top( 'g2' ) ).toBe( bottom( 'g1' ) + 2 );
		expect( top( 'z:' ) ).toBe( bottom( 'g2' ) + 2 );
	} );

	it( 'stacks lone cards a row apart, the run an empty row clear of a group', () => {
		const at = Object.fromEntries(
			autoLayout( {
				nodes: [
					'x:a',
					'x:b',
					'x:c',
					'lone:p',
					'lone:q',
					'lone:r',
				].map( ( id ) => ( { id } ) ),
				edges: [
					{ from: 'x:a', to: 'x:b' },
					{ from: 'x:b', to: 'x:c' },
				],
			} ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const rowOf = ( id ) => ( at[ id ].y - at[ 'x:a' ].y ) / Y_STEP;
		expect(
			[ 'lone:p', 'lone:q', 'lone:r' ].map( ( id ) => [
				at[ id ].x === at[ 'x:a' ].x,
				rowOf( id ),
			] )
		).toEqual( [
			[ true, 2 ],
			[ true, 3 ],
			[ true, 4 ],
		] );
	} );

	it( 'keeps a long run of lone cards a row apart where it splits', () => {
		// Thirty-three lone cards outgrow the square; each column of them
		// still stacks one row apart.
		const ids = [ 'x:a', 'x:b', 'x:c' ];
		for ( let i = 0; i < 33; i++ ) {
			ids.push( `lone:${ String( i ).padStart( 2, '0' ) }` );
		}
		const at = Object.fromEntries(
			autoLayout( {
				nodes: ids.map( ( id ) => ( { id } ) ),
				edges: [
					{ from: 'x:a', to: 'x:b' },
					{ from: 'x:b', to: 'x:c' },
				],
			} ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		/** @type {Object<number,Array<number>>} */
		const byX = {};
		for ( const id of ids.filter( ( i ) => i.startsWith( 'lone:' ) ) ) {
			( byX[ at[ id ].x ] ??= [] ).push( at[ id ].y );
		}
		const steps = Object.values( byX ).flatMap( ( ys ) =>
			ys
				.sort( ( p, q ) => p - q )
				.slice( 1 )
				.map( ( y, k ) => ( y - ys[ k ] ) / Y_STEP )
		);
		expect( Object.keys( byX ).length ).toBeGreaterThan( 1 );
		expect( new Set( steps ) ).toEqual( new Set( [ 1 ] ) );
	} );

	it( 'moves a band’s hub feeder right only where its wire would cross a card', () => {
		// From column 2, c:fetch's wire to egress would cross b:view.
		const at = layOut( urlGroup );
		expect( at[ 'a:fetch' ].x ).toBe( at[ 'a:result' ].x );
		expect( at[ 'c:fetch' ].x ).toBe( at[ 'b:view' ].x );
		expect(
			drawnCost(
				at,
				urlGroup.map( ( [ from, to ] ) => ( { from, to } ) )
			).over
		).toEqual( [] );
	} );

	it( 'seats a view chain in the columns right after the card feeding it', () => {
		const at = layOut( [
			...oneShot( 'p', 'hub' ),
			...oneShot( 'q', 'hub' ),
			[ 'm:in', 'm:in:current' ],
			[ 'm:in:current', 'm:view' ],
			[ 'm:in', 'm:fetch' ],
			[ 'm:timer', 'm:tee' ],
			[ 'm:tee', 'm:fetch' ],
			[ 'm:tee', 'w:fetch' ],
			[ 'm:fetch', 'hub' ],
			[ 'w:fetch', 'hub' ],
			[ 'w:in', 'w:fetch' ],
			[ 'w:in', 'w:in:current' ],
			[ 'w:in:current', 'w:transform' ],
			[ 'w:transform', 'w:view' ],
		] );
		const colOf = ( id ) => ( at[ id ].x - at[ 'm:in' ].x ) / X_STEP;
		expect(
			[ 'm:in:current', 'm:view', 'm:tee', 'm:fetch' ].map( colOf )
		).toEqual( [ 1, 2, 2, 3 ] );
		expect( at[ 'm:view' ].y ).toBe( at[ 'm:in:current' ].y );
	} );

	it( 'lays the fleet board out as its acceptance table', () => {
		const at = layOut( fleet );
		const table = [
			...oneShotAt( 'topologies:activate', 0 ),
			...oneShotAt( 'topologies:deactivate', 2.5 ),
			// The fetchers' middle, 4.75, rounds up as each hub's row does.
			[ 'topologies:shell', 4.5, 5 ],
			[ 'topology-manager:in:current', 1, 5 ],
			[ 'topology-manager:view', 2, 5 ],
			[ 'topology-manager:in', 0, 5.5 ],
			[ 'topology-manager:fetch', 3, 6 ],
			[ 'topology-manager:timer', 1, 6.5 ],
			[ 'topology-manager:tee', 2, 6.5 ],
			[ 'worker-status:fetch', 3, 7 ],
			[ 'worker-status:in', 0, 7 ],
			[ 'worker-status:in:current', 1, 8 ],
			[ 'worker-status:transform', 2, 8 ],
			[ 'worker-status:view', 3, 8 ],
			...oneShotAt( 'workers:restart', 9, 3 ),
			[ '_heartbeat', 0, 12.5 ],
			[ '_http', 1, 12.5 ],
			[ '_output', 2, 12.5 ],
			[ '_metadata', 0, 14.5 ],
			[ '_cwd', 1, 14.5 ],
			[ 'topicprobe:stream', 0, 16.5 ],
			[ 'topicprobe:view', 1, 16.5 ],
		];
		expect( relative( at, 'topologies:activate:timer', table ) ).toEqual(
			table
		);
	} );
} );
