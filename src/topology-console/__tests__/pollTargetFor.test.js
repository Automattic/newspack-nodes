/**
 * pollTargetFor — the live-canvas poll gate. Returns the `_sse/{topology}.p{N}`
 * path the silent poll nodes (_metadata / _uptime / _heartbeat) should poke, or
 * null to suppress polling. Polling only happens while pivoted into a live
 * worker (a cwd whose longest worker-prefix is non-null), connected (ssePid),
 * and not in edit mode.
 */

import { pollTargetFor, workerPollPath } from '../TopologyConsole';

const OPTIONS = [ '', '_sse', '_sse/demo.p0', '_sse/demo.p1' ];

describe( 'workerPollPath (shared by the poll gate AND the SSE stream gate)', () => {
	it( 'a worker cwd in the active menu resolves to its LCP path', () => {
		expect( workerPollPath( '_sse/demo.p0', OPTIONS ) ).toBe(
			'_sse/demo.p0'
		);
	} );

	it( 'a sub-node under an active worker resolves to the worker LCP', () => {
		expect( workerPollPath( '_sse/demo.p0/firehose-in', OPTIONS ) ).toBe(
			'_sse/demo.p0'
		);
	} );

	it( 'the local root and request scope are not workers', () => {
		expect( workerPollPath( '', OPTIONS ) ).toBeNull();
		expect( workerPollPath( '_sse', OPTIONS ) ).toBeNull();
	} );

	it( 'a worker-SHAPED path for an INACTIVE topology is not pollable (so the stream must not open for it either)', () => {
		// Regression: the stream gate used to use a pure regex (scopeFromCwd),
		// which treated `_sse/inactive.p0` as a worker and opened the EventSource —
		// but the poll gate (this function) finds no active mount, so the heartbeat
		// never poked and the slot TTL'd out into a reconnect loop. Both gates now
		// share THIS detection, so they agree: not in the menu → null → no stream.
		expect( workerPollPath( '_sse/inactive.p0', OPTIONS ) ).toBeNull();
	} );
} );

describe( 'pollTargetFor', () => {
	it( 'a worker cwd polls that worker LCP', () => {
		expect(
			pollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse/demo.p0' );
	} );

	it( 'a sub-node under a worker resolves to the worker LCP', () => {
		expect(
			pollTargetFor( {
				cwd: '_sse/demo.p0/firehose-in',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse/demo.p0' );
	} );

	it( 'the local graph root (empty cwd) suppresses polling', () => {
		expect(
			pollTargetFor( {
				cwd: '',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );

	it( 'the request scope (_sse) suppresses polling', () => {
		expect(
			pollTargetFor( {
				cwd: '_sse',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );

	it( 'edit mode suppresses polling even on a worker cwd', () => {
		expect(
			pollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'edit',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );

	it( 'no SSE session suppresses polling', () => {
		expect(
			pollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'view',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );
} );
