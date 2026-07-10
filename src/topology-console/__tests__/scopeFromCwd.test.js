/**
 * scopeFromCwd — derives the display/storage scope from a cwd so the canvas
 * header + the viewport/positions localStorage keys follow `cd` instead of
 * inheriting the last worker's stale topology/partition React state.
 *
 * Worker cwds are now the bare `{topology}.p{N}` (no `_sse/` prefix — the worker's
 * name IS the address).
 */

import { scopeFromCwd } from '../TopologyConsole';

describe( 'scopeFromCwd', () => {
	it( 'local graph (empty cwd) → local scope, not a worker', () => {
		expect( scopeFromCwd( '' ) ).toEqual( {
			key: 'local',
			label: 'local',
			partition: null,
			isWorker: false,
		} );
	} );

	it( 'a worker cwd resolves to its topology + partition', () => {
		expect( scopeFromCwd( 'digest.p0' ) ).toEqual( {
			key: 'digest.p0',
			label: 'digest',
			partition: 0,
			isWorker: true,
		} );
	} );

	it( 'a sub-node beneath a worker resolves to that worker', () => {
		expect( scopeFromCwd( 'digest.p0/summarizer' ) ).toEqual( {
			key: 'digest.p0',
			label: 'digest',
			partition: 0,
			isWorker: true,
		} );
	} );

	it( 'a worker key equals `${topology}.p${partition}` (back-compat with persisted worker layouts)', () => {
		const scope = scopeFromCwd( 'demo-workers.p3' );
		expect( scope.key ).toBe( 'demo-workers.p3' );
		expect( scope.partition ).toBe( 3 );
		expect( scope.isWorker ).toBe( true );
	} );

	it( 'a non-worker top-level cwd (_http) gets its own key, stripped for display', () => {
		expect( scopeFromCwd( '_http' ) ).toEqual( {
			key: '_http',
			label: 'http',
			partition: null,
			isWorker: false,
		} );
	} );

	it( 'a worker-shaped segment under a non-worker boundary (_http/foo.p3) is NOT a worker', () => {
		// Topology capture anchored to [^/]+, so _http/foo.p3 isn't a worker.
		const scope = scopeFromCwd( '_http/foo.p3' );
		expect( scope.isWorker ).toBe( false );
		expect( scope.key ).toBe( '_http/foo.p3' );
	} );
} );
