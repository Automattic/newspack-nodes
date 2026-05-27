/**
 * workerPollPath — the single worker-detection both the SSE stream gate and
 * `_cwd` routing share. Returns the `_sse/{topology}.p{N}` path the cwd resolves
 * to — the longest ACTIVE worker menu item that prefixes it — or null when the
 * cwd isn't (under) a live worker.
 */

import { workerPollPath } from '../TopologyConsole';

const OPTIONS = [ '', '_sse', '_sse/demo.p0', '_sse/demo.p1' ];

describe( 'workerPollPath (shared by the SSE stream gate)', () => {
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

	it( 'a worker-SHAPED path for an INACTIVE topology is not a live worker (so the stream must not open for it)', () => {
		// Regression: the stream gate used to use a pure regex (scopeFromCwd),
		// which treated `_sse/inactive.p0` as a worker and opened the EventSource —
		// but with no active mount the slot TTL'd out into a reconnect loop. The
		// stream gate now uses THIS detection: not in the menu → null → no stream.
		expect( workerPollPath( '_sse/inactive.p0', OPTIONS ) ).toBeNull();
	} );
} );
