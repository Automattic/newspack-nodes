/**
 * `sessions:view` — the issued-session table slice. A `list` reply carries a
 * live `{ sessions:[], ttl_max, scopes:{} }` struct, already decoded; the view
 * flattens it into the render model the table reads. A TM_ERROR paints the
 * banner and keeps whatever rows are on screen.
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
import { views } from '../register';

beforeEach( () => Core.reset() );

function makeView( name = 'sessions:view' ) {
	const node = new views.SessionListView();
	node.name = name;
	return node;
}

const SAMPLE = {
	sessions: [
		{
			handle: 'aaaa',
			label: 'laptop mcp',
			scope: 'tune',
			expires: 4102444800,
		},
		{ handle: 'bbbb', label: 'kiwi', scope: 'read', expires: 4102448400 },
	],
	connections: [
		{
			grant: 'g-7746',
			name: 'Tui laptop',
			client: 'Kea Desk 4410',
			scope: 'read',
			created: 1790027746,
			expires: 1792619746,
		},
	],
	ttl_max: 86400,
	scopes: {
		read: 'Kea read 4410',
		tune: 'Kea tune 4410',
		manage: 'Kea manage 4410',
	},
};

function reply( payload, type = TM_COMMAND | TM_RESPONSE ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ ID ] = 'cmd-1';
	m[ VALUE ] = { name: 'list', payload };
	return m;
}

test( 'the empty slice loads with no rows', () => {
	const view = makeView();
	expect( view.view ).toEqual( {
		sessions: null,
		connections: null,
		scopes: {},
		ttlMax: 0,
		loading: true,
		error: null,
	} );
} );

test( 'a list reply publishes the rows, the scopes and the ttl ceiling', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );

	expect( view.view.sessions ).toHaveLength( 2 );
	expect( view.view.sessions[ 0 ].label ).toBe( 'laptop mcp' );
	expect( view.view.connections ).toEqual( SAMPLE.connections );
	expect( view.view.scopes ).toEqual( SAMPLE.scopes );
	expect( view.view.ttlMax ).toBe( 86400 );
	expect( view.view.loading ).toBe( false );
	expect( view.view.error ).toBeNull();
} );

test( 'scopes served as a bare list offer none rather than unnamed ones', () => {
	const view = makeView();
	view.fill( reply( { ...SAMPLE, scopes: [ 'read', 'tune' ] } ) );

	expect( view.view.scopes ).toEqual( {} );
} );

test( 'a reply missing either table keeps the prior slice', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );
	view.fill( reply( { ...SAMPLE, connections: undefined, sessions: [] } ) );

	expect( view.view.sessions ).toHaveLength( 2 );
	expect( view.view.connections ).toEqual( SAMPLE.connections );
} );

test( 'an error keeps the rows already on screen', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );
	view.fill(
		reply(
			'permission denied: manage capability required',
			TM_COMMAND | TM_ERROR
		)
	);

	expect( view.view.sessions ).toHaveLength( 2 );
	expect( view.view.error ).toMatch( /permission denied/ );
} );

test( 'a garbage payload keeps the prior slice', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );
	view.fill( reply( 'not a struct' ) );

	expect( view.view.sessions ).toHaveLength( 2 );
} );
