/**
 * vault:test tests — the TEST-result view node (de-god split). It owns ONLY the
 * per-server connection-probe results (`results` keyed by server id), separate
 * from the credential LIST concern (`vault:list`). The hook awaits each probe
 * via this node's `replies` registry; on settle the node ALSO records the result
 * (or error) into its published model, so the test concern has its own
 * inspectable, per-concern reply state instead of vanishing into the god view.
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back (router peels
 * the reply's TO = `vault:test`). VALUE is the `{ name, payload }` envelope; the
 * outbound `message[ID]` carries the server id so the result can be filed per row.
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
import { VaultTestViewNode } from '../vault-test-view-node';

beforeEach( () => Core.reset() );

function makeView( name = 'vault:test' ) {
	const node = new VaultTestViewNode();
	node.name = name;
	return node;
}

function replyMsg( {
	name = 'test',
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

describe( 'vault:test — initial model', () => {
	test( 'publishes an initial empty results model on construction', () => {
		expect( makeView().setStateCache.view ).toEqual( { results: {} } );
	} );

	test( 'has a `replies` registry for hook-side promise resolution', () => {
		const v = makeView();
		expect( v.replies ).toBeInstanceOf( PendingReplies );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:test — a probe reply settles the caller AND records the result', () => {
	test( 'a successful probe resolves the pending promise with the payload', () => {
		const v = makeView();
		const resolve = jest.fn();
		v.replies.add( 'spoke-01', resolve, jest.fn() );
		const probe = { id: 'spoke-01', status: 'connected' };
		v.fill( replyMsg( { id: 'spoke-01', payload: probe } ) );
		expect( resolve ).toHaveBeenCalledWith( probe );
		expect( v.replies.has( 'spoke-01' ) ).toBe( false );
	} );

	test( 'a successful probe records an ok result keyed by the message ID', () => {
		const v = makeView();
		v.replies.add( 'spoke-01', jest.fn(), jest.fn() );
		const probe = { id: 'spoke-01', status: 'connected' };
		v.fill( replyMsg( { id: 'spoke-01', payload: probe } ) );
		expect( v.setStateCache.view.results[ 'spoke-01' ] ).toEqual( {
			ok: true,
			payload: probe,
		} );
	} );

	test( 'a failed probe rejects the pending promise AND records an error result', () => {
		const v = makeView();
		const reject = jest.fn();
		v.replies.add( 'spoke-02', jest.fn(), reject );
		v.fill(
			replyMsg( {
				id: 'spoke-02',
				payload: 'connection refused',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( reject.mock.calls[ 0 ][ 0 ].message ).toContain(
			'connection refused'
		);
		expect( v.setStateCache.view.results[ 'spoke-02' ] ).toEqual( {
			ok: false,
			error: 'connection refused',
		} );
	} );

	test( 'a second probe for a different server is recorded alongside the first (no clobber)', () => {
		const v = makeView();
		v.replies.add( 'spoke-01', jest.fn(), jest.fn() );
		v.fill(
			replyMsg( { id: 'spoke-01', payload: { status: 'connected' } } )
		);
		v.replies.add( 'spoke-02', jest.fn(), jest.fn() );
		v.fill(
			replyMsg( {
				id: 'spoke-02',
				payload: 'refused',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( Object.keys( v.setStateCache.view.results ).sort() ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
		expect( v.setStateCache.view.results[ 'spoke-01' ].ok ).toBe( true );
		expect( v.setStateCache.view.results[ 'spoke-02' ].ok ).toBe( false );
	} );

	test( 'a reply with no matching pending entry does not throw or record (the test concern only files probes it awaited)', () => {
		const v = makeView();
		expect( () =>
			v.fill( replyMsg( { id: 'unknown', payload: { status: 'ok' } } ) )
		).not.toThrow();
		expect( v.setStateCache.view.results ).toEqual( {} );
	} );
} );

describe( 'vault:test — removeNode rejects in-flight pending', () => {
	test( 'removeNode rejects every pending probe so a reset/teardown does not strand a caller', async () => {
		const v = makeView();
		const p = new Promise( ( resolve, reject ) =>
			v.replies.add( 'spoke-01', resolve, reject )
		);
		const e = p.catch( ( err ) => err );
		v.removeNode();
		expect( await e ).toBeInstanceOf( Error );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'vault:test — nodeSchema', () => {
	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = VaultTestViewNode.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
