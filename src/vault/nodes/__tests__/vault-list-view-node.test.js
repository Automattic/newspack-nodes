/**
 * vault:list tests — the credential-LIST view node (de-god split). It owns ONLY
 * the server table slice (`servers` / `loading` / `error`) and a `replies`
 * registry so the hook can await `list` / `add` / `update` / `delete`
 * dispatches that re-list into it. The TEST-result concern lives in a SEPARATE
 * view node (`vault:test`) — this node knows nothing about test probes.
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back from POST
 * /command: the router peels the reply's TO (= `vault:list`) and delivers them
 * here. VALUE is the `{ name, payload }` envelope.
 *
 * On a `list` reply the node turns the raw `{ server_id:{} }` map into the
 * render model — `servers` (Object.values → array), clears `loading` + `error`.
 * On an un-correlated TM_ERROR it surfaces the error string (table banner) and
 * keeps the prior servers. A pending-matched reply (a mutation the caller is
 * awaiting) settles the Promise; a TM_ERROR there is owned by the caller's
 * catch and must NOT paint the table banner.
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
import { VaultListViewNode } from '../vault-list-view-node';

beforeEach( () => Core.reset() );

function makeView( name = 'vault:list' ) {
	const node = new VaultListViewNode();
	node.name = name;
	return node;
}

const SAMPLE = {
	'spoke-01': { id: 'spoke-01', url: 'https://a.example.test' },
	'spoke-02': { id: 'spoke-02', url: 'https://b.example.test' },
};

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

describe( 'vault:list — initial model', () => {
	test( 'publishes an initial loading model on construction', () => {
		expect( makeView().setStateCache.view ).toEqual( {
			servers: null,
			loading: true,
			error: null,
		} );
	} );

	test( 'has a `replies` registry for hook-side promise resolution', () => {
		const v = makeView();
		expect( v.replies ).toBeInstanceOf( PendingReplies );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:list — list reply updates the render model', () => {
	test( 'converts the server map to an array of servers', () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		const model = v.setStateCache.view;
		expect( Array.isArray( model.servers ) ).toBe( true );
		expect( model.servers.map( ( s ) => s.id ) ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
		expect( model.loading ).toBe( false );
		expect( model.error ).toBeNull();
	} );

	test( 'an empty list payload yields an empty servers array', () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: {} } ) );
		expect( v.setStateCache.view.servers ).toEqual( [] );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );

	test( 'a null list payload yields an empty servers array', () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: null } ) );
		expect( v.setStateCache.view.servers ).toEqual( [] );
	} );

	test( 'a list reply that also resolves a pending promise still updates the model', () => {
		const v = makeView();
		const resolve = jest.fn();
		v.replies.add( 'op-3', resolve, jest.fn() );
		v.fill( replyMsg( { id: 'op-3', name: 'list', payload: SAMPLE } ) );
		// The settle path consumes the reply (resolves the awaited mutation) AND
		// the list model refreshes — the table must show the fresh rows.
		expect( resolve ).toHaveBeenCalledWith( SAMPLE );
		expect( v.setStateCache.view.servers ).toHaveLength( 2 );
		expect( v.replies.has( 'op-3' ) ).toBe( false );
	} );
} );

describe( 'vault:list — error surfacing', () => {
	test( 'an un-correlated TM_ERROR sets the table banner and keeps prior servers', () => {
		const v = makeView();
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

	test( 'a pending-matched TM_ERROR rejects the caller WITHOUT painting the table banner', () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );
		expect( v.setStateCache.view.error ).toBeNull();
		const reject = jest.fn();
		v.replies.add( 'mut-1', jest.fn(), reject );
		v.fill(
			replyMsg( {
				id: 'mut-1',
				name: 'add',
				payload: 'duplicate id',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( reject.mock.calls[ 0 ][ 0 ].message ).toContain(
			'duplicate id'
		);
		expect( v.setStateCache.view.error ).toBeNull();
		expect( v.setStateCache.view.servers ).toHaveLength( 2 );
	} );
} );

describe( 'vault:list — pending-promise resolution', () => {
	test( 'a successful reply resolves the pending promise with the payload', () => {
		const v = makeView();
		const resolve = jest.fn();
		v.replies.add( 'op-1', resolve, jest.fn() );
		v.fill(
			replyMsg( { id: 'op-1', name: 'add', payload: { id: 'spoke-01' } } )
		);
		expect( resolve ).toHaveBeenCalledWith( { id: 'spoke-01' } );
		expect( v.replies.has( 'op-1' ) ).toBe( false );
	} );
} );

describe( 'vault:list — removeNode rejects in-flight pending', () => {
	test( 'removeNode rejects every pending promise so a reset/teardown does not strand a caller', async () => {
		const v = makeView();
		const p = new Promise( ( resolve, reject ) =>
			v.replies.add( 'op-a', resolve, reject )
		);
		const e = p.catch( ( err ) => err );
		v.removeNode();
		expect( await e ).toBeInstanceOf( Error );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:list — nodeSchema', () => {
	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = VaultListViewNode.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
