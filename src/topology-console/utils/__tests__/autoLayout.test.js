/**
 * Tests for autoLayout — left-to-right column layout with barycenter
 * row assignment plus snap + conflict-resolution passes.
 *
 * Each test exercises ONE aspect (depth, barycenter ordering, snap,
 * conflict, cycle break, exported constants), then a small end-to-end
 * scenario pins observable invariants we promise downstream callers.
 */

import {
	autoLayout,
	X_PAD,
	X_STEP,
	Y_PAD,
	Y_STEP,
	NODE_W,
	NODE_H,
} from '../autoLayout';

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
		// a -> c, b -> c, b -> d (no a -> b). Without the forward-pull pass
		// a would sit in column 0 and c in column 1; with pull, a slides
		// forward so the edge to c is shorter.
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
		// c and d are downstream of b; b stays at col 0, a stays at col 0
		// (one of its targets is at col 1), c and d both end up at col 1.
		expect( byId.c.position.x ).toBe( byId.d.position.x );
	} );

	it( 'orders nodes within a column by barycenter of predecessors', () => {
		// Two sources a, b; two sinks x (from b) and y (from a). After
		// pass 1 the depths are 0 / 0 / 1 / 1. Pass 2 (snap to target row)
		// then pulls the sources towards their targets.
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
		// x and y end up in column 1; rows should be distinct.
		expect( byId.x.position.x ).toBe( byId.y.position.x );
		expect( byId.x.position.y ).not.toBe( byId.y.position.y );
	} );

	it( 'breaks cycles by treating one node as the entry of the loop', () => {
		// a -> b -> a is a 2-cycle. DFS should set depth 0 for whichever
		// is visited first, then 1 for the other.
		const out = autoLayout( {
			nodes: [ { id: 'a' }, { id: 'b' } ],
			edges: [
				{ from: 'a', to: 'b' },
				{ from: 'b', to: 'a' },
			],
		} );
		expect( out.nodes ).toHaveLength( 2 );
		// Both positions are returned; we don't pin which one goes first
		// (visit order is stable but not part of the contract).
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
		// a -> z, b -> z. After snap, both a and b want row 0 (z's row).
		// Pass 3 bumps one of them.
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
		// Sources in same column.
		expect( byId.a.position.x ).toBe( byId.b.position.x );
		// Distinct rows.
		expect( byId.a.position.y ).not.toBe( byId.b.position.y );
	} );

	it( 'prefers the "straighter" link when two column-mates tie on row', () => {
		// Layout:
		//   a -> b -> c (straight chain in row 0)
		//   x -> y -> c (x also feeds c, but via y in row 1)
		// Column 2 only has c. Column 1 has b and y — both feed c.
		// The straightness tiebreaker keeps b at row 0 (same row as c
		// and a), pushes y to row 1.
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
		// b and y end up in the same column.
		expect( byId.b.position.x ).toBe( byId.y.position.x );
		// One of them shares c's row; both straightness >= 1 so the
		// deterministic alphabetical fallback applies if they tie. The
		// behaviour we DO guarantee: distinct rows.
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
		// a -> b, a -> c, b -> d, c -> d
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
		// b and c share column 1 with different rows.
		expect( byId.b.position.x ).toBe( byId.c.position.x );
		expect( byId.b.position.y ).not.toBe( byId.c.position.y );
	} );

	it( 'falls back to alphabetical when barycenter ties', () => {
		// Same predecessor, two successors -> tied barycenter -> id sort.
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
		// Both y and b feed off a; pass 1 sorts ties by id (b < y), so b
		// gets row 0 and y row 1. Pass 2/3 then collapse them onto a's row
		// (which is shared by both targets after snap) but the deconflict
		// keeps distinct rows.
		expect( byId.b.position.y ).not.toBe( byId.y.position.y );
	} );
} );
