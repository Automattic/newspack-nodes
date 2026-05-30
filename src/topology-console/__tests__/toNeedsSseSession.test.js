/**
 * toNeedsSseSession — the send gate's "needs a live SSE session (pid)" test.
 * Only a command pivoted to a worker partition via `_sse/{topology}.pN` gets its
 * reply demuxed back ASYNC over the SSE stream (SseInNode wraps FROM with the pid for
 * the server's HTTP_Filter), so only that form must wait on a connected session.
 * A local-root command (`''`) interprets in-browser; a request-scope command
 * (`_sse`) and the direct `_http/{worker}` boundary form reply synchronously in
 * the POST body — none of those need the stream. Regression guard for #12: the
 * three `!ssePid` gates used to block EVERY send when the stream was closed,
 * stranding `cd /` + `ls` with "[no sse_pid yet] retry once CONNECTED".
 */

import { toNeedsSseSession } from '../TopologyConsole';

describe( 'toNeedsSseSession', () => {
	it( 'local graph root (empty TO) does not need a session', () => {
		expect( toNeedsSseSession( '' ) ).toBe( false );
	} );

	it( 'request scope (_sse with nothing after) does not need a session', () => {
		expect( toNeedsSseSession( '_sse' ) ).toBe( false );
	} );

	it( 'a worker pivot (_sse/{topology}.pN) needs a session', () => {
		expect( toNeedsSseSession( '_sse/firehose-workers-and-jobs.p0' ) ).toBe(
			true
		);
	} );

	it( 'a sub-node under a worker pivot needs a session', () => {
		expect( toNeedsSseSession( '_sse/demo.p1/firehose-in' ) ).toBe( true );
	} );

	it( 'a multi-digit partition still matches', () => {
		expect( toNeedsSseSession( '_sse/demo.p10' ) ).toBe( true );
	} );

	it( 'the direct _http boundary does not need a session', () => {
		expect( toNeedsSseSession( '_http' ) ).toBe( false );
	} );

	it( 'the direct _http/{worker} boundary form does not need a session', () => {
		// Routed straight to the HTTP boundary (not through SseInNode's pid-wrap), so
		// there is no async stream demux to wait on.
		expect( toNeedsSseSession( '_http/demo.p0' ) ).toBe( false );
	} );

	it( 'a local interpreter target (no _sse head) does not need a session', () => {
		expect( toNeedsSseSession( 'some-node:config' ) ).toBe( false );
	} );

	it( 'tolerates null/undefined TO', () => {
		expect( toNeedsSseSession( null ) ).toBe( false );
		expect( toNeedsSseSession( undefined ) ).toBe( false );
	} );

	it( 'a bare _sse-prefixed name that is not a worker partition does not match', () => {
		// `_sse` followed by a non-worker segment (no `.pN`) is not a pivot.
		expect( toNeedsSseSession( '_sse/_output' ) ).toBe( false );
	} );
} );
