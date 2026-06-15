/**
 * topologymanager:view tests — the Topology Manager list model React reads via
 * useNodeState('topologymanager:view','view'). Stores the `topologies list`
 * reply, settles awaited activate/deactivate verbs via its PendingReplies.
 */

import {
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { PendingReplies } from '../../../shared/pendingReplies';
import { TopologyManagerViewNode } from '../topologyManagerView';

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

test( 'stores the list reply payload as the published model', () => {
	const v = makeView( 'topologymanager:view' );
	v.fill( listReply( { topologies: [ { name: 'a' } ], user_dir: '/u' } ) );
	expect( v.model.topologies ).toEqual( [ { name: 'a' } ] );
	expect( v.model.userDir ).toBe( '/u' );
	expect( v.model.loading ).toBe( false );
} );

test( 'exposes a PendingReplies registry for the hook to stash resolvers', () => {
	const v = makeView( 'topologymanager:view' );
	expect( v.replies ).toBeInstanceOf( PendingReplies );
} );

test( 'fill increments the node counter so the overlay shows throughput', () => {
	const v = makeView( 'topologymanager:view' );
	expect( v.counter ).toBe( 0 );
	v.fill( listReply( { topologies: [] } ) );
	v.fill( listReply( { topologies: [] } ) );
	expect( v.counter ).toBe( 2 );
} );

test( 'declares has_target:false (terminal receiver — no out-port)', () => {
	expect( TopologyManagerViewNode.nodeSchema().has_target ).toBe( false );
} );
