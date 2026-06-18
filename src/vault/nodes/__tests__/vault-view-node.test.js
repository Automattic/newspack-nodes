/**
 * vault:view tests — owns the Vault server-credential admin view model after
 * the substrate-canonical migration.
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back from POST
 * /command: the router peels the reply's TO (= `vault:view`, stamped from the
 * outbound FROM by the server's reply pivot) and delivers them here. VALUE is
 * the `{ name, payload }` envelope; the node unwraps `value.payload`.
 *
 * On a `list` reply it updates the render model. On `add/update/delete/test`
 * replies (or TM_ERROR), it resolves/rejects the pending promise keyed by
 * `message[ID]` (the hook stamps the ID and stores the resolver before fill).
 * TM_ERROR also surfaces the error into the view model.
 */

import {
	VALUE,
	ID,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { PendingReplies } from '../../../shared/pendingReplies';
import { VaultViewNode } from '../vault-view-node';

// Naming registers in the per-process Core registry; clear it between tests.
beforeEach( () => Core.reset() );

// Construct + name the node directly — make_node builds it in production;
// bare-new + name= is the test seam.
function makeView( name ) {
	const node = new VaultViewNode();
	node.name = name;
	return node;
}

const SAMPLE = {
	'spoke-01': {
		id: 'spoke-01',
		url: 'https://a.example.test',
		enabled: true,
		has_credentials: true,
		is_config: false,
	},
	'spoke-02': {
		id: 'spoke-02',
		url: 'https://b.example.test',
		enabled: false,
		has_credentials: false,
		is_config: true,
	},
};

// Build the verb-reply Message HttpOutNode feeds back (TO already peeled by router).
function replyMsg( {
	name,
	payload,
	type = TM_COMMAND | TM_RESPONSE,
	id = '',
} ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ ID ] = id;
	m[ VALUE ] = { name, payload };
	return m;
}

describe( 'vault:view — initial model', () => {
	test( 'publishes an initial loading model on construction', () => {
		const v = makeView( 'vault:view' );
		expect( v.setStateCache.view ).toMatchObject( {
			servers: null,
			loading: true,
			error: null,
		} );
	} );

	test( 'names the node', () => {
		const v = makeView( 'vault:view' );
		expect( v.name ).toBe( 'vault:view' );
	} );

	test( 'has a `replies` registry for hook-side promise resolution', () => {
		const v = makeView( 'vault:view' );
		expect( v.replies ).toBeInstanceOf( PendingReplies );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:view — list reply updates the render model', () => {
	test( 'a list reply converts the server map to an array of servers', () => {
		const v = makeView( 'vault:view' );
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		const model = v.setStateCache.view;
		expect( Array.isArray( model.servers ) ).toBe( true );
		expect( model.servers ).toHaveLength( 2 );
		expect( model.servers.map( ( s ) => s.id ) ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
	} );

	test( 'a list reply clears loading and any prior error', () => {
		const v = makeView( 'vault:view' );
		// Simulate an error first.
		const errMsg = replyMsg( {
			name: 'list',
			payload: 'boom',
			type: TM_COMMAND | TM_ERROR,
		} );
		v.fill( errMsg );
		expect( v.setStateCache.view.error ).toBe( 'boom' );
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		expect( v.setStateCache.view.loading ).toBe( false );
		expect( v.setStateCache.view.error ).toBeNull();
	} );

	test( 'an empty list payload yields an empty servers array', () => {
		const v = makeView( 'vault:view' );
		v.fill( replyMsg( { name: 'list', payload: {} } ) );
		expect( v.setStateCache.view.servers ).toEqual( [] );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );

	test( 'a null list payload yields an empty servers array', () => {
		const v = makeView( 'vault:view' );
		v.fill( replyMsg( { name: 'list', payload: null } ) );
		expect( v.setStateCache.view.servers ).toEqual( [] );
	} );
} );

describe( 'vault:view — TM_ERROR replies surface the error', () => {
	test( 'a TM_ERROR with no matching pending entry sets the error and clears loading (prior servers preserved)', () => {
		const v = makeView( 'vault:view' );
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		v.fill(
			replyMsg( {
				name: 'list',
				payload: 'registry down',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		const model = v.setStateCache.view;
		expect( model.error ).toBe( 'registry down' );
		expect( model.loading ).toBe( false );
		expect( model.servers ).toHaveLength( 2 );
	} );

	test( 'TM_ERROR without a message defaults the error string', () => {
		const v = makeView( 'vault:view' );
		v.fill(
			replyMsg( {
				name: 'add',
				payload: null,
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( typeof v.setStateCache.view.error ).toBe( 'string' );
		expect( v.setStateCache.view.error.length ).toBeGreaterThan( 0 );
	} );

	test( 'TM_ERROR matching a pending entry does NOT pollute global view.error (caller handles it)', () => {
		// Per-row test() probes catch their own errors and dispatch a local
		// snackbar — surfacing them globally would also paint a table-wide red
		// banner for a single-row failure. The caller's rejection IS the error
		// surface; the global view.error is reserved for un-correlated failures.
		const v = makeView( 'vault:view' );
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		expect( v.setStateCache.view.error ).toBeNull();
		const resolve = jest.fn();
		const reject = jest.fn();
		v.replies.add( 'probe-7', resolve, reject );
		v.fill(
			replyMsg( {
				id: 'probe-7',
				name: 'test',
				payload: 'connection refused',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( v.setStateCache.view.error ).toBeNull();
	} );

	test( 'TM_ERROR with a structured {message} payload extracts the message field', () => {
		// The server-side service-CI / interpret() catch may pack a structured
		// error (e.g. { message, code, field }) into VALUE.payload; the view
		// should surface the human-readable message.
		const v = makeView( 'vault:view' );
		const reject = jest.fn();
		v.replies.add( 'op-9', jest.fn(), reject );
		v.fill(
			replyMsg( {
				id: 'op-9',
				name: 'add',
				payload: { message: 'duplicate id', code: 'E_DUP' },
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( reject.mock.calls[ 0 ][ 0 ].message ).toBe( 'duplicate id' );
	} );
} );

describe( 'vault:view — pending-promise resolution', () => {
	test( 'a successful reply resolves the pending promise with the payload', async () => {
		const v = makeView( 'vault:view' );
		const resolve = jest.fn();
		const reject = jest.fn();
		v.replies.add( 'op-1', resolve, reject );
		v.fill(
			replyMsg( { id: 'op-1', name: 'add', payload: { id: 'spoke-01' } } )
		);
		expect( resolve ).toHaveBeenCalledWith( { id: 'spoke-01' } );
		expect( reject ).not.toHaveBeenCalled();
		// Pending entry cleared.
		expect( v.replies.has( 'op-1' ) ).toBe( false );
	} );

	test( 'a TM_ERROR reply rejects the pending promise and clears the entry', () => {
		const v = makeView( 'vault:view' );
		const resolve = jest.fn();
		const reject = jest.fn();
		v.replies.add( 'op-2', resolve, reject );
		v.fill(
			replyMsg( {
				id: 'op-2',
				name: 'add',
				payload: 'duplicate id',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( reject.mock.calls[ 0 ][ 0 ] ).toBeInstanceOf( Error );
		expect( reject.mock.calls[ 0 ][ 0 ].message ).toContain(
			'duplicate id'
		);
		expect( resolve ).not.toHaveBeenCalled();
		expect( v.replies.has( 'op-2' ) ).toBe( false );
	} );

	test( 'a list reply still updates the render model when also resolving a pending promise', () => {
		const v = makeView( 'vault:view' );
		const resolve = jest.fn();
		v.replies.add( 'op-3', resolve, jest.fn() );
		v.fill( replyMsg( { id: 'op-3', name: 'list', payload: SAMPLE } ) );
		expect( v.setStateCache.view.servers ).toHaveLength( 2 );
		expect( resolve ).toHaveBeenCalledWith( SAMPLE );
	} );

	test( 'a reply without a matching pending entry is handled normally (no throw)', () => {
		const v = makeView( 'vault:view' );
		expect( () =>
			v.fill(
				replyMsg( {
					id: 'no-such-op',
					name: 'add',
					payload: { id: 'x' },
				} )
			)
		).not.toThrow();
	} );

	test( 'a reply with no ID is handled normally (no pending lookup)', () => {
		const v = makeView( 'vault:view' );
		expect( () =>
			v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) )
		).not.toThrow();
		expect( v.setStateCache.view.servers ).toHaveLength( 2 );
	} );
} );

describe( 'vault:view — malformed input', () => {
	test( 'ignores a message with no VALUE', () => {
		const v = makeView( 'vault:view' );
		const initial = v.setStateCache.view;
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		v.fill( m );
		expect( v.setStateCache.view ).toBe( initial );
	} );

	test( 'ignores a message with a non-object VALUE', () => {
		const v = makeView( 'vault:view' );
		const initial = v.setStateCache.view;
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ VALUE ] = 'not-an-object';
		v.fill( m );
		expect( v.setStateCache.view ).toBe( initial );
	} );
} );

describe( 'vault:view — removeNode rejects in-flight pending', () => {
	test( 'removeNode rejects every pending promise so a reset/teardown does not strand a caller', async () => {
		const v = makeView( 'vault:view' );
		const p1 = new Promise( ( resolve, reject ) =>
			v.replies.add( 'op-a', resolve, reject )
		);
		const p2 = new Promise( ( resolve, reject ) =>
			v.replies.add( 'op-b', resolve, reject )
		);
		// Attach catch handlers BEFORE removeNode rejects so the synchronous
		// reject is already handled (no unhandled-rejection) and we can assert it.
		const e1 = p1.catch( ( e ) => e );
		const e2 = p2.catch( ( e ) => e );

		v.removeNode();

		expect( await e1 ).toBeInstanceOf( Error );
		expect( await e2 ).toBeInstanceOf( Error );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:view — nodeSchema', () => {
	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = makeView( 'vault:view' ).constructor.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
		expect( typeof schema.description ).toBe( 'string' );
		expect( schema.description.length ).toBeGreaterThan( 0 );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
