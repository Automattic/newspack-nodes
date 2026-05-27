/**
 * canvasPollTargetFor — the dump_metadata/uptime poll target for the canvas.
 * Unlike the slot heartbeat (worker-only, see pollTargetFor), the canvas is
 * pollable in EVERY non-edit context: a worker pivot polls the worker CI (async
 * reply over the stream → needs a session pid), the local graph ('') polls the
 * in-browser CI, and request scope ('_sse') polls via a synchronous POST. So the
 * target is the worker LCP for a worker cwd, else the cwd itself. Regression
 * guard for #12, which gated ALL polling to workers and froze the canvas at
 * `cd /` and `cd /_sse`.
 */

import { canvasPollTargetFor } from '../TopologyConsole';

const OPTIONS = [ '', '_sse', '_sse/demo.p0', '_sse/demo.p1' ];

describe( 'canvasPollTargetFor', () => {
	it( 'polls the local graph root in-browser (empty cwd, no session needed)', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '',
				mode: 'view',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBe( '' );
	} );

	it( 'polls request scope (_sse) via synchronous POST, no session needed', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '_sse',
				mode: 'view',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse' );
	} );

	it( 'polls a worker LCP when pivoted into a worker with a session', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse/demo.p0' );
	} );

	it( 'resolves a deep worker sub-node cwd to the worker LCP', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '_sse/demo.p0/firehose-in',
				mode: 'view',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse/demo.p0' );
	} );

	it( 'suppresses worker polling without a session (async reply needs the stream)', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'view',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );

	it( 'suppresses all polling in edit mode', () => {
		expect(
			canvasPollTargetFor( {
				cwd: '_sse/demo.p0',
				mode: 'edit',
				ssePid: 777,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
		expect(
			canvasPollTargetFor( {
				cwd: '',
				mode: 'edit',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBeNull();
	} );

	it( 'an inactive worker-shaped cwd is treated as a non-worker (polls the cwd, no stream)', () => {
		// Not in the menu → workerPollPath null → no stream opens for it, so polling
		// it as a worker (which would wait on a stream) is wrong; poll it directly.
		expect(
			canvasPollTargetFor( {
				cwd: '_sse/inactive.p0',
				mode: 'view',
				ssePid: null,
				pathOptions: OPTIONS,
			} )
		).toBe( '_sse/inactive.p0' );
	} );
} );
