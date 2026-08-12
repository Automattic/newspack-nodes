/**
 * vault:list tests — the credential-LIST view node (de-god split). It owns ONLY
 * the server table slice (`servers` / `loading` / `error`). The TEST-result
 * concern lives in a SEPARATE view node (`vault:test`) — this node knows
 * nothing about test probes.
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back from POST
 * /command: the router peels the reply's TO (= `vault:list`) and delivers them
 * here. VALUE is the `{ name, payload }` envelope.
 *
 * On a `list` reply the node turns the raw `{ vault_id:{} }` map into the
 * render model — `servers` (Object.values → array), clears `loading` + `error`.
 * A TM_ERROR surfaces the error string (table banner) and keeps the prior
 * servers. A mutation the caller awaits is minted from its own `Request` node,
 * so its failure is owned by that caller's catch and never lands here.
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

	test( 'a payload that is not a map keeps the servers already on screen', () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );

		// Object.values( 'abc' ) would paint three fabricated rows.
		v.fill( replyMsg( { name: 'list', payload: 'abc' } ) );

		expect( v.setStateCache.view.servers.map( ( s ) => s.id ) ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
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

	// A mutation's failure lands on ITS node, never here — which is what keeps
	// an error the caller is already catching off the table banner.
	test( "a mutation's failure never reaches this node", () => {
		const v = makeView();
		v.fill( replyMsg( { name: 'list', payload: SAMPLE } ) );

		expect( v.setStateCache.view.error ).toBeNull();
		expect( v.setStateCache.view.servers ).toHaveLength( 2 );
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
