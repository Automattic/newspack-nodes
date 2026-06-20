/**
 * workerPollPath — the single worker-detection both the SSE stream gate and
 * `_cwd` routing share. Returns the bare `{topology}.p{N}` path the cwd resolves
 * to — the longest ACTIVE worker menu item that prefixes it — or null when the
 * cwd isn't (under) a live worker.
 */

import { workerPollPath } from '../TopologyConsole';

const OPTIONS = [ '', '_http', 'demo.p0', 'demo.p1' ];

describe( 'workerPollPath (shared by the SSE stream gate)', () => {
	it( 'a worker cwd in the active menu resolves to its LCP path', () => {
		expect( workerPollPath( 'demo.p0', OPTIONS ) ).toBe( 'demo.p0' );
	} );

	it( 'a sub-node under an active worker resolves to the worker LCP', () => {
		expect( workerPollPath( 'demo.p0/firehose-in', OPTIONS ) ).toBe(
			'demo.p0'
		);
	} );

	it( 'the local root and the _http boundary are not workers', () => {
		expect( workerPollPath( '', OPTIONS ) ).toBeNull();
		expect( workerPollPath( '_http', OPTIONS ) ).toBeNull();
	} );

	it( 'a slash-containing path under a non-worker boundary (_http/foo.p3) is NOT treated as a worker', () => {
		// parseWorker anchors the topology capture to `[^/]+`, so `_http/foo.p3`
		// can't be mistaken for the worker `_http/foo`.p3 (a topology reader has no
		// slash). With it in the menu, longestWorkerPrefix must still skip it.
		expect(
			workerPollPath( '_http/foo.p3', [ ...OPTIONS, '_http/foo.p3' ] )
		).toBeNull();
	} );

	it( 'a worker-SHAPED path for an INACTIVE topology is not a live worker (so the stream must not open for it)', () => {
		// Regression: the stream gate used to use a pure regex (scopeFromCwd),
		// which treated `inactive.p0` as a worker and opened the EventSource —
		// but with no active mount the slot TTL'd out into a reconnect loop. The
		// stream gate now uses THIS detection: not in the menu → null → no stream.
		expect( workerPollPath( 'inactive.p0', OPTIONS ) ).toBeNull();
	} );
} );
