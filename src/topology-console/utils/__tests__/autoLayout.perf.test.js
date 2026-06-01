/**
 * Perf regression for the topology-console layout on the large `test.tsl`
 * topology (3145 nodes, 3200 edges).
 *
 * `computeNodePositions`'s "overrides present" branch used to call
 * `placeNewNode` once per unplaced node. Each call scans all edges (O(E)) and
 * does `Object.values(positions).some(...)` per collision step (O(P)), so a
 * flood of unplaced nodes — a different/reconnected graph the saved overrides
 * don't cover — was O(N·E) of synchronous work that froze the console for ~40s
 * when leaving the topology. `computeNodePositions` now batches a large unplaced
 * set through one `autoLayout` pass. These pin both paths to a time budget.
 */
import fs from 'fs';
import path from 'path';
import { autoLayout, computeNodePositions } from '../autoLayout';
import { parseTsl } from '../parseTsl';

const BUDGET_MS = 4000;

const fixture = () =>
	parseTsl(
		fs.readFileSync(
			path.join( __dirname, 'fixtures', 'test.tsl' ),
			'utf8'
		)
	);

describe( 'topology-console layout — large topology perf (test.tsl)', () => {
	it( 'autoLayout (no-overrides path) lays out 3145 nodes well under budget', () => {
		const parsed = fixture();
		const start = Date.now();
		const out = autoLayout( parsed );
		const elapsed = Date.now() - start;
		// eslint-disable-next-line no-console
		console.log(
			`[autoLayout] ${ parsed.nodes.length } nodes ${ elapsed }ms`
		);
		expect( out.nodes ).toHaveLength( parsed.nodes.length );
		expect( elapsed ).toBeLessThan( BUDGET_MS );
	}, 120000 );

	it( 'computeNodePositions with overrides that do not cover the graph stays under budget', () => {
		const parsed = fixture();
		// Non-empty overrides that cover none of the 3145 nodes → the flood path
		// (this is the leave/reconnect scenario that used to freeze for ~40s).
		const overrides = { __pinned__: { x: 0, y: 0 } };
		const start = Date.now();
		const positions = computeNodePositions( parsed, overrides );
		const elapsed = Date.now() - start;
		// eslint-disable-next-line no-console
		console.log(
			`[computeNodePositions flood] ${ parsed.nodes.length } nodes ${ elapsed }ms`
		);
		expect( elapsed ).toBeLessThan( BUDGET_MS );
		// Every node gets a position; the pin is preserved.
		expect( parsed.nodes.every( ( n ) => positions[ n.id ] ) ).toBe( true );
		expect( positions.__pinned__ ).toEqual( { x: 0, y: 0 } );
		// Took the autoLayout (flood) branch, not per-node placeNewNode: an
		// unpinned node sits at autoLayout's computed coordinate.
		const al = autoLayout( parsed );
		const sample = al.nodes.find( ( n ) => positions[ n.id ] );
		expect( positions[ sample.id ] ).toEqual( sample.position );
	}, 120000 );

	it( 'computeNodePositions still places a few newcomers next to their pinned connection', () => {
		// Small unplaced count → cheap incremental placeNewNode path (unchanged).
		const parsed = {
			nodes: [ { id: 'hub' }, { id: 'newbie' } ],
			edges: [ { from: 'newbie', to: 'hub' } ],
		};
		const overrides = { hub: { x: 240, y: 120 } };
		const positions = computeNodePositions( parsed, overrides );
		expect( positions.hub ).toEqual( { x: 240, y: 120 } );
		// newbie is a producer of hub → one column LEFT of it.
		expect( positions.newbie.x ).toBeLessThan( positions.hub.x );
	} );
} );
