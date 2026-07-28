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
import { RemoteIpcNode } from '../remote-ipc-node';
import { ensureSession, forgetSession, __setAuthFetch } from '../command-auth';
import { newMessage, TYPE, TO, VALUE, LOCAL, TM_COMMAND } from '../message';

const LEASE_OWNER = '9007199254740993';

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

		const m = node._pollMessage( {
			slot: 0,
			leaseOwner: LEASE_OWNER,
		} );

		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );
} );

/**
 * Remote_IPC bundles its own `connect_worker_input` alongside the command the
 * Shell handed it. That one is a mint too — it was never stamped LOCAL at all,
 * so it rode the ingress oracle until ingress stopped signing:
 *
 *   topologies: unauthorized: connect_worker_input - from: _output/combined.p0
 *
 * It is also why grepping for the LOCAL marker is a weak way to find mints: the
 * marker only appears where someone already half-remembered.
 */
describe( 'Remote_IPC bundles a signed connect', () => {
	beforeEach( async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: 'aaaa1111bbbb2222cccc3333dddd4444',
			key: 'ipc-session-key-4242',
			expires_in: 3600,
			now: 1771000000,
		} ) );
		await ensureSession();
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'signs the connect_worker_input it mints', () => {
		const sent = [];
		const node = new RemoteIpcNode();
		node.name = 'combined.p0';
		node.reader = 'combined.p0';
		node.pid = () => 7;
		node.connect = () => {};
		node.httpOut = {
			locked: true,
			lock: () => {},
			flush: () => {},
			fill: ( m ) => sent.push( m ),
		};

		const typed = newMessage();
		typed[ TYPE ] = TM_COMMAND;
		typed[ TO ] = '';
		typed[ VALUE ] = { name: 'ls', arguments: [] };
		node.fill( typed );

		const connect = sent.find(
			( m ) => 'connect_worker_input' === m[ VALUE ]?.name
		);
		expect( connect ).toBeDefined();
		expect( connect[ LOCAL ] ).toBe( true );
		expect( connect[ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );
} );

/**
 * A mint is synchronous and cannot wait for /auth, so the EMITTERS wait. A poll
 * that fires before the session lands skips the tick rather than sending
 * something the server will refuse — the next tick carries it.
 */
describe( 'polls hold until authenticated', () => {
	beforeEach( () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: 'aaaa1111bbbb2222cccc3333dddd4444',
			key: 'poll-session-key-4242',
			expires_in: 3600,
			now: 1771000000,
		} ) );
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'emits nothing before the session lands, then emits after', async () => {
		const sent = [];
		const node = new HeartbeatNode();
		node.name = '_heartbeat_gate';
		node.connectNode( 'workers' );
		node.sink = { fill: ( m ) => sent.push( m ) };
		node.setTimer = jest.fn();
		const linkIdentity = {};
		node.setSlot( 0, LEASE_OWNER, linkIdentity );

		node.fire();
		expect( sent ).toHaveLength( 0 );

		await ensureSession();
		node.fire();

		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );
} );
