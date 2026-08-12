/**
 * topologymanager:view tests — the Topology Manager list model React reads via
 * useNodeState('topologymanager:view','view'). Stores the `topologies list`
 * reply. An awaited activate/deactivate is minted from its own node, so its
 * reply never lands here.
 */

import {
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { TopologyManagerViewNode } from '../topology-manager-view-node';

beforeEach( () => Core.reset() );

function makeView( name ) {
	const node = new TopologyManagerViewNode();
	node.name = name;
	return node;
}

// A `topologies list` reply as HttpOut delivers it: VALUE = { name, payload }.
function listReply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'list', payload };
	return m;
}

test( 'publishes the pre-reply model, so a first render reads loading', () => {
	const v = makeView( 'topologymanager:view' );
	expect( v.setStateCache.view ).toEqual( {
		topologies: [],
		userDir: null,
		error: null,
		loading: true,
	} );
} );

test( 'stores the list reply payload as the published model', () => {
	const v = makeView( 'topologymanager:view' );
	v.fill( listReply( { topologies: [ { name: 'a' } ], user_dir: '/u' } ) );
	expect( v.model.topologies ).toEqual( [ { name: 'a' } ] );
	expect( v.model.userDir ).toBe( '/u' );
	expect( v.model.loading ).toBe( false );
} );

test( 'fill increments the node counter so the overlay shows throughput', () => {
	const v = makeView( 'topologymanager:view' );
	expect( v.counter ).toBe( 0 );
	v.fill( listReply( { topologies: [] } ) );
	v.fill( listReply( { topologies: [] } ) );
	expect( v.counter ).toBe( 2 );
} );

test( 'uncorrelated errors publish the global model error', () => {
	const v = makeView( 'topologymanager:view' );
	const m = listReply( { message: 'write conflict' } );
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;

	v.fill( m );

	expect( v.model.error ).toContain( 'write conflict' );
	expect( v.model.loading ).toBe( false );
} );

test( 'declares has_target:false (terminal receiver — no out-port)', () => {
	expect( TopologyManagerViewNode.nodeSchema().has_target ).toBe( false );
} );

// The base keeps the prior slice when `_parse()` rejects a payload — the guard
// the collapse onto SliceViewNode introduced and nothing exercised.
test( 'an unparseable reply keeps the slice it already published', () => {
	const v = makeView( 'topologymanager:view' );
	v.fill( listReply( { topologies: [ { name: 'a' } ], user_dir: '/u' } ) );

	v.fill( listReply( 'not-an-object' ) );

	expect( v.model.topologies ).toEqual( [ { name: 'a' } ] );
	expect( v.model.userDir ).toBe( '/u' );
} );
