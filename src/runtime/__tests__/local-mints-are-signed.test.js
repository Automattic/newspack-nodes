/**
 * Every local mint must be signed, not just the Shell's.
 *
 * Ingress stopped signing, so a command that leaves the browser unsigned is
 * refused — and the first deploy proved the Shell is not the only minter:
 *
 *   workers: unauthorized: heartbeat - TM_COMMAND from: _output/_heartbeat
 *   topologies: unauthorized: connect_worker_input - TM_COMMAND from: _output/combined.p0
 *
 * `LOCAL` and the signature are the same assertion — "this process minted it" —
 * so they are set together by markLocal() and cannot drift apart.
 */
import { HeartbeatNode } from '../heartbeat-node';
import { ensureSession, forgetSession, __setAuthFetch } from '../command-auth';
import { VALUE, LOCAL } from '../message';

describe( 'local mints carry a signature', () => {
	beforeEach( async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: 'aaaa1111bbbb2222cccc3333dddd4444',
			key: 'mint-session-key-4242',
			expires_in: 3600,
			now: 1771000000,
		} ) );
		await ensureSession();
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'signs the heartbeat poll the Shell never sees', () => {
		const node = new HeartbeatNode();
		node.name = '_heartbeat';
		node.connectNode( 'workers' );

		const m = node._pollMessage( 0 );

		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );
} );
