/**
 * toNeedsSseSession — the send gate's "needs a live SSE session (pid)" test.
 * Only a command pivoted to a worker partition (`{topology}.pN`) gets its reply
 * demuxed back ASYNC over the SSE stream (RemoteIpc wraps FROM with the pid for
 * the server's HTTP_Filter), so only that form must wait on a connected session.
 * A local-root command (`''`) interprets in-browser; the direct `_http` boundary
 * form replies synchronously in the POST body — none of those need the stream.
 * Regression guard for #12: the three `!ssePid` gates used to block EVERY send
 * when the stream was closed, stranding `cd /` + `ls` with "[no sse_pid yet]".
 */

import { toNeedsSseSession } from '../TopologyConsole';

describe( 'toNeedsSseSession', () => {
	it( 'local graph root (empty TO) does not need a session', () => {
		expect( toNeedsSseSession( '' ) ).toBe( false );
	} );

	it( 'a worker pivot ({topology}.pN) needs a session', () => {
		expect( toNeedsSseSession( 'firehose-workers-and-jobs.p0' ) ).toBe(
			true
		);
	} );

	it( 'a sub-node under a worker pivot needs a session', () => {
		expect( toNeedsSseSession( 'demo.p1/firehose-in' ) ).toBe( true );
	} );

	it( 'a multi-digit partition still matches', () => {
		expect( toNeedsSseSession( 'demo.p10' ) ).toBe( true );
	} );

	it( 'the direct _http boundary does not need a session', () => {
		expect( toNeedsSseSession( '_http' ) ).toBe( false );
	} );

	it( 'the direct _http/{worker} boundary form does not need a session', () => {
		// Routed straight to the HTTP boundary (not through RemoteIpc's pid-wrap),
		// so there is no async stream demux to wait on. The `_http` head fails the
		// worker-partition shape (it has no `.pN`).
		expect( toNeedsSseSession( '_http/demo.p0' ) ).toBe( false );
	} );

	it( 'a local interpreter target (not a worker partition) does not need a session', () => {
		expect( toNeedsSseSession( 'some-node:config' ) ).toBe( false );
	} );

	it( 'tolerates null/undefined TO', () => {
		expect( toNeedsSseSession( null ) ).toBe( false );
		expect( toNeedsSseSession( undefined ) ).toBe( false );
	} );

	it( 'a bare name that is not a worker partition does not match', () => {
		expect( toNeedsSseSession( '_output' ) ).toBe( false );
	} );
} );
