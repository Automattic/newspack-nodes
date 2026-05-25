/**
 * scopeFromCwd — derives the display/storage scope from a cwd so the canvas
 * header + the viewport/positions localStorage keys follow `cd` instead of
 * inheriting the last worker's stale topology/partition React state.
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

	it( 'request scope (_sse) → request-scope label, not a worker', () => {
		expect( scopeFromCwd( '_sse' ) ).toEqual( {
			key: '_sse',
			label: 'request scope',
			partition: null,
			isWorker: false,
		} );
	} );

	it( 'a worker cwd resolves to its topology + partition', () => {
		expect( scopeFromCwd( '_sse/digest.p0' ) ).toEqual( {
			key: 'digest.p0',
			label: 'digest',
			partition: 0,
			isWorker: true,
		} );
	} );

	it( 'a sub-node beneath a worker resolves to that worker', () => {
		expect( scopeFromCwd( '_sse/digest.p0/summarizer' ) ).toEqual( {
			key: 'digest.p0',
			label: 'digest',
			partition: 0,
			isWorker: true,
		} );
	} );

	it( 'a worker key equals `${topology}.p${partition}` (back-compat with persisted worker layouts)', () => {
		// The OLD storage key was `${topology}.p${partition}`. For a worker cwd
		// the new scope.key must match it so existing viewports/layouts load.
		const scope = scopeFromCwd( '_sse/firehose-workers-and-jobs.p3' );
		expect( scope.key ).toBe( 'firehose-workers-and-jobs.p3' );
		expect( scope.partition ).toBe( 3 );
		expect( scope.isWorker ).toBe( true );
	} );
} );
