/**
 * `sessions:list` — the issued-session table slice. A `list` reply carries a
 * live `{ sessions:[], ttl_max, scopes:[] }` struct, already decoded; the view
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
import { SessionListViewNode } from '../session-list-view-node';

beforeEach( () => Core.reset() );

function makeView( name = 'sessions:list' ) {
	const node = new SessionListViewNode();
	node.name = name;
	return node;
}

const SAMPLE = {
	sessions: [
		{ handle: 'aaaa', label: 'laptop mcp', scope: 'tune', live: true },
		{ handle: 'bbbb', label: 'stale', scope: 'read', live: false },
	],
	ttl_max: 86400,
	scopes: [ 'read', 'tune', 'manage' ],
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
	expect( view.model ).toEqual( {
		sessions: null,
		scopes: [],
		ttlMax: 0,
		loading: true,
		error: null,
	} );
} );

test( 'a list reply publishes the rows, the scopes and the ttl ceiling', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );

	expect( view.model.sessions ).toHaveLength( 2 );
	expect( view.model.sessions[ 0 ].label ).toBe( 'laptop mcp' );
	expect( view.model.scopes ).toEqual( [ 'read', 'tune', 'manage' ] );
	expect( view.model.ttlMax ).toBe( 86400 );
	expect( view.model.loading ).toBe( false );
	expect( view.model.error ).toBeNull();
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

	expect( view.model.sessions ).toHaveLength( 2 );
	expect( view.model.error ).toMatch( /permission denied/ );
} );

test( 'a garbage payload keeps the prior slice', () => {
	const view = makeView();
	view.fill( reply( SAMPLE ) );
	view.fill( reply( 'not a struct' ) );

	expect( view.model.sessions ).toHaveLength( 2 );
} );
