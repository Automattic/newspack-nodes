/**
 * aggregator:view tests — owns the Aggregator Status view model.
 *
 * Post-migration to `_http`/interpreter routing, the view's `fill()` receives the raw
 * reply Message directly from the substrate's router (TO=FROM pivot from the
 * server): TM_COMMAND|TM_RESPONSE carrying `{ name, payload }` in VALUE and
 * the server's snapshot clock in TIMESTAMP. The view unwraps `value.payload`
 * (the same pattern Metadata uses), derives `servers` (Object.values),
 * `connectedCount`, `totalCount`, and stamps `serverNow` from TIMESTAMP +
 * `lastRefresh` from the browser clock. TM_ERROR replies surface as an
 * `error` on the model and clear `loading` (prior `servers` preserved).
 *
 * The render model is published via `setState('view', model)`; the React view
 * reads it with `useNodeState('aggregator:view','view')`.
 */

import {
	TIMESTAMP,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { AggregatorViewNode } from '../aggregator-view-node';

// Naming registers in the per-process Core registry; clear it between tests.
beforeEach( () => Core.reset() );

// Construct + name the node directly — the createX factory is gone (make_node
// builds it in production); bare-new + name= is the test seam.
function makeView( name ) {
	const node = new AggregatorViewNode();
	node.name = name;
	return node;
}

// A reply Message as the server emits one (the format HttpOutNode feeds back into
// the interpreter: TM_COMMAND|TM_RESPONSE carrying `{ name, payload }` in VALUE).
function replyMsg( payload, now = null ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'status', payload };
	if ( null !== now ) {
		m[ TIMESTAMP ] = now;
	}
	return m;
}

// A TM_ERROR reply Message (the substrate emits this when a verb throws).
function errorMsg( errorString ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ VALUE ] = { name: 'status', payload: errorString };
	return m;
}

const SAMPLE = {
	server1: {
		id: 'server1',
		url: 'https://a.example.test',
		partitions: {
			0: { connected: true },
			1: { connected: false },
		},
	},
	server2: {
		id: 'server2',
		url: 'https://b.example.test',
		partitions: {},
	},
};

test( 'publishes an initial loading model on construction', () => {
	const v = makeView( 'aggregator:view' );
	expect( v.setStateCache.view ).toMatchObject( {
		servers: null,
		loading: true,
		error: null,
	} );
} );

test( 'a reply Message converts the server map (value.payload) to an array of servers', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( replyMsg( SAMPLE, 100 ) );
	const model = v.setStateCache.view;
	expect( Array.isArray( model.servers ) ).toBe( true );
	expect( model.servers ).toHaveLength( 2 );
	expect( model.servers.map( ( s ) => s.id ) ).toEqual( [
		'server1',
		'server2',
	] );
} );

test( 'a reply Message stores serverNow from its TIMESTAMP', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( replyMsg( SAMPLE, 1748960000 ) );
	expect( v.setStateCache.view.serverNow ).toBe( 1748960000 );
} );

test( 'computes connectedCount (servers with >=1 connected partition) and totalCount', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( replyMsg( SAMPLE, 1 ) );
	const model = v.setStateCache.view;
	expect( model.connectedCount ).toBe( 1 );
	expect( model.totalCount ).toBe( 2 );
} );

test( 'a reply Message clears loading and any prior error', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( errorMsg( 'boom' ) );
	expect( v.setStateCache.view.error ).toBe( 'boom' );
	v.fill( replyMsg( SAMPLE, 1 ) );
	expect( v.setStateCache.view.loading ).toBe( false );
	expect( v.setStateCache.view.error ).toBeNull();
} );

test( 'a reply Message sets lastRefresh (a browser-clock ms number)', () => {
	const v = makeView( 'aggregator:view' );
	const before = Date.now();
	v.fill( replyMsg( SAMPLE, 1 ) );
	const { lastRefresh } = v.setStateCache.view;
	expect( typeof lastRefresh ).toBe( 'number' );
	expect( lastRefresh ).toBeGreaterThanOrEqual( before );
} );

test( 'an empty payload yields an empty servers array, connected 0 / total 0', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( replyMsg( {}, 1 ) );
	const model = v.setStateCache.view;
	expect( model.servers ).toEqual( [] );
	expect( model.connectedCount ).toBe( 0 );
	expect( model.totalCount ).toBe( 0 );
} );

test( 'a TM_ERROR reply sets the error string and clears loading (servers untouched)', () => {
	const v = makeView( 'aggregator:view' );
	v.fill( replyMsg( SAMPLE, 1 ) );
	v.fill( errorMsg( 'aggregator down' ) );
	const model = v.setStateCache.view;
	expect( model.error ).toBe( 'aggregator down' );
	expect( model.loading ).toBe( false );
	// Prior servers preserved across a transient error (parity with the old
	// fetchStatus catch, which only set error and never cleared servers).
	expect( model.servers ).toHaveLength( 2 );
} );

test( 'a TM_ERROR reply with no payload uses a default error string', () => {
	const v = makeView( 'aggregator:view' );
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ VALUE ] = { name: 'status', payload: null };
	v.fill( m );
	expect( v.setStateCache.view.error ).toMatch( /Failed|error/i );
	expect( v.setStateCache.view.loading ).toBe( false );
} );

test( 'ignores a message with no VALUE', () => {
	const v = makeView( 'aggregator:view' );
	const initial = v.setStateCache.view;
	const m = newMessage();
	// No VALUE / TYPE — pure noise.
	v.fill( m );
	expect( v.setStateCache.view ).toBe( initial );
} );

test( 'names the node', () => {
	const v = makeView( 'aggregator:view' );
	expect( v.name ).toBe( 'aggregator:view' );
} );

describe( 'aggregator:view — nodeSchema', () => {
	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = makeView( 'aggregator:view' ).constructor.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
		expect( typeof schema.description ).toBe( 'string' );
		expect( schema.description.length ).toBeGreaterThan( 0 );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
