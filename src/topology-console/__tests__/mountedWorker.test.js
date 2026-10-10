/**
 * mountedWorker — the single worker-detection the SSE stream gate, the status
 * lines, EDIT and drift share. Returns the active worker the cwd equals or
 * descends from, or null when the cwd isn't (under) a live worker.
 */

import { mountedWorker } from '../TopologyConsole';

const OPTIONS = [ '', '_http', 'demo.p0', 'demo.p1' ];

describe( 'mountedWorker (shared by the SSE stream gate)', () => {
	it( 'a worker cwd in the active menu resolves to that worker', () => {
		expect( mountedWorker( 'demo.p1', OPTIONS ) ).toEqual( {
			topology: 'demo',
			partition: 1,
		} );
	} );

	it( 'a sub-node under an active worker resolves to the worker', () => {
		expect( mountedWorker( 'demo.p0/firehose-in', OPTIONS ) ).toEqual( {
			topology: 'demo',
			partition: 0,
		} );
	} );

	it( 'the local root and the _http boundary are not workers', () => {
		expect( mountedWorker( '', OPTIONS ) ).toBeNull();
		expect( mountedWorker( '_http', OPTIONS ) ).toBeNull();
	} );

	it( 'a slash-containing path under a non-worker boundary (_http/foo.p3) is NOT treated as a worker', () => {
		// The worker id is the first segment only; _http/foo.p3 isn't one.
		expect(
			mountedWorker( '_http/foo.p3', [ ...OPTIONS, '_http/foo.p3' ] )
		).toBeNull();
	} );

	it( 'a worker-SHAPED path for an INACTIVE topology is not a live worker, so the stream stays shut for it', () => {
		expect( mountedWorker( 'inactive.p0', OPTIONS ) ).toBeNull();
	} );
} );
