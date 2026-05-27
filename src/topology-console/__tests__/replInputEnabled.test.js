/**
 * replInputEnabled — the REPL prompt's enable gate. The input must stay usable
 * in non-worker contexts (local graph '', request scope `_sse`), where commands
 * are local builtins or synchronous `_http` POSTs that never use the SSE stream.
 * Only while pivoted into a live worker does the prompt wait on the stream
 * (status 'open' + a session pid), since a worker's replies arrive async over
 * SSE. Regression guard: #12's stream gating closes the stream + nulls the pid
 * on a `cd /`, which used to disable the prompt ("Connecting…") and strand the
 * user with no way to `cd` back onto a worker.
 */

import { replInputEnabled } from '../TopologyConsole';

const OPTIONS = [ '', '_sse', '_sse/demo.p0', '_sse/demo.p1' ];

describe( 'replInputEnabled', () => {
	it( 'enables the prompt at the local graph root even with no SSE session', () => {
		expect(
			replInputEnabled( {
				status: 'closed',
				ssePid: null,
				cwd: '',
				pathOptions: OPTIONS,
			} )
		).toBe( true );
	} );

	it( 'enables the prompt in request scope (_sse) even with no SSE session', () => {
		expect(
			replInputEnabled( {
				status: 'closed',
				ssePid: null,
				cwd: '_sse',
				pathOptions: OPTIONS,
			} )
		).toBe( true );
	} );

	it( 'enables the prompt on a worker once the stream is open and a pid exists', () => {
		expect(
			replInputEnabled( {
				status: 'open',
				ssePid: 777,
				cwd: '_sse/demo.p0',
				pathOptions: OPTIONS,
			} )
		).toBe( true );
	} );

	it( 'disables the prompt on a worker while the stream is still connecting', () => {
		expect(
			replInputEnabled( {
				status: 'connecting',
				ssePid: null,
				cwd: '_sse/demo.p0',
				pathOptions: OPTIONS,
			} )
		).toBe( false );
	} );

	it( 'disables the prompt on a worker when the stream is open but no pid yet', () => {
		expect(
			replInputEnabled( {
				status: 'open',
				ssePid: null,
				cwd: '_sse/demo.p0',
				pathOptions: OPTIONS,
			} )
		).toBe( false );
	} );

	it( 'a sub-node under a worker still gates on the stream', () => {
		expect(
			replInputEnabled( {
				status: 'closed',
				ssePid: null,
				cwd: '_sse/demo.p0/firehose-in',
				pathOptions: OPTIONS,
			} )
		).toBe( false );
	} );

	it( 'a worker-SHAPED path for an INACTIVE topology is treated as non-worker (prompt usable)', () => {
		// No menu entry → workerPollPath null → no stream opens for it, so the
		// prompt must not wait on a stream that will never connect.
		expect(
			replInputEnabled( {
				status: 'closed',
				ssePid: null,
				cwd: '_sse/inactive.p0',
				pathOptions: OPTIONS,
			} )
		).toBe( true );
	} );
} );
