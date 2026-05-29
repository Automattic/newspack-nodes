/**
 * Tests for autoLayout — column layout, barycenter ordering, snap, conflict.
 */

import {
	autoLayout,
	snapToGrid,
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

	it( 'pairs each source with its target on the same row when col 0 fans into col 1', () => {
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
		// Pairs: each source on its target's row.
		expect( rowOf( '_metadata' ) ).toBe( rowOf( '_cwd' ) );
		expect( rowOf( '_heartbeat' ) ).toBe( rowOf( '_http' ) );
		expect( rowOf( '_sse' ) ).toBe( rowOf( '_output' ) );
		// _uptime shares _cwd but loses the pair to _metadata — it takes a
		// nearby free row instead of pushing the pair off.
		expect( rowOf( '_uptime' ) ).not.toBe( rowOf( '_cwd' ) );
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
