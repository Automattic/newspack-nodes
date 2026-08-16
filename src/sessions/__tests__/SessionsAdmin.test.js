/**
 * SessionsAdmin — the issued-session table and its two verbs.
 *
 * ONE node serves revoke across every row, because the SUBJECT rides in the
 * reply's ADDRESS: the graph hands each answer over already naming the handle
 * it was about. These cover what that buys — a row keeps its own line when a
 * sibling is revoked in the same second.
 */

jest.mock( '../hooks/useSessionsGraph', () => {
	const actual = jest.requireActual( '../hooks/useSessionsGraph' );
	return {
		__esModule: true,
		...actual,
		useSessionsGraph: jest.fn(),
	};
} );

import { render, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import SessionsAdmin from '../SessionsAdmin';

const { useSessionsGraph } = require( '../hooks/useSessionsGraph' );

// Distinct from every default so a wrong-field read fails rather than coincides.
const SESSIONS = [
	{
		handle: 'h-4471',
		label: 'hub-aggregator',
		scope: 'read',
		expires: 4102444800,
		created: 1771000000,
		live: true,
	},
	{
		handle: 'h-8823',
		label: 'spoke-probe',
		scope: 'tune',
		expires: 4102444800,
		created: 1771000000,
		live: true,
	},
];

let createSession;
let revokeSession;
let graphOpts = {};
// What the graph reports as outstanding; the screen asks rather than keeping a
// flag of its own.
let pendingSubjects = [];

beforeEach( () => {
	Core.reset();
	createSession = jest.fn();
	revokeSession = jest.fn();
	graphOpts = {};
	pendingSubjects = [];
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: SESSIONS,
			scopes: [ 'read', 'tune', 'manage' ],
			ttlMax: 86400,
			loading: false,
			error: null,
			createSession,
			revokeSession,
			pendingVerb: ( subject ) =>
				pendingSubjects.includes( subject ) ? 'revoke' : null,
		};
	} );
} );

// A reply, already addressed: the graph hands the screen the answer and the
// SUBJECT it named, exactly as the reply path delivered it.
const answer = ( verb, { subject, error = null, result = null } ) =>
	act( () => graphOpts.onAnswer?.( { verb, subject, error, result } ) );

const rowsOf = ( container ) => container.querySelectorAll( 'tbody tr' );

const clickRevoke = ( row ) =>
	act( () =>
		Array.from( row.querySelectorAll( 'button' ) )
			.find( ( b ) => /revoke/i.test( b.textContent ) )
			.dispatchEvent( new Event( 'click', { bubbles: true } ) )
	);

const confirmDialog = () =>
	act( () =>
		Array.from(
			(
				document.querySelector( '[role="dialog"]' ) || document
			).querySelectorAll( 'button' )
		)
			.find( ( b ) => /revoke/i.test( b.textContent ) )
			.dispatchEvent( new Event( 'click', { bubbles: true } ) )
	);

it( 'revokes the handle the row is about', () => {
	const { container } = render( <SessionsAdmin /> );
	clickRevoke( rowsOf( container )[ 0 ] );
	confirmDialog();

	expect( revokeSession ).toHaveBeenCalledWith( 'h-4471' );
	expect( revokeSession ).toHaveBeenCalledTimes( 1 );
} );

// @longform Two rows revoked in the same second are two subjects, and each row
// shows its OWN answer. A screen reading one shared `error` cannot: the second
// reply overwrites the first, and the first row's failure disappears while it
// is still the current truth.
it( 'keeps each row’s refusal when a second row is revoked', () => {
	const { container } = render( <SessionsAdmin /> );

	clickRevoke( rowsOf( container )[ 0 ] );
	confirmDialog();
	answer( 'revoke', { subject: 'h-4471', error: 'no such session' } );
	expect( rowsOf( container )[ 0 ].textContent ).toContain(
		'no such session'
	);

	clickRevoke( rowsOf( container )[ 1 ] );
	confirmDialog();
	answer( 'revoke', { subject: 'h-8823', error: 'refused' } );

	expect( rowsOf( container )[ 0 ].textContent ).toContain(
		'no such session'
	);
	expect( rowsOf( container )[ 1 ].textContent ).toContain( 'refused' );
} );

// The row asks the graph what it is waiting on rather than flipping a flag at
// the click: the outbox is the only thing that knows, and a flag beside every
// call site is what goes stale when one path forgets to clear it.
it( 'marks only the outstanding row busy', () => {
	pendingSubjects = [ 'h-4471' ];
	const { container } = render( <SessionsAdmin /> );

	const revokeButton = ( row ) =>
		Array.from( row.querySelectorAll( 'button' ) ).find( ( b ) =>
			/revoke/i.test( b.textContent )
		);
	expect( revokeButton( rowsOf( container )[ 0 ] ).disabled ).toBe( true );
	expect( revokeButton( rowsOf( container )[ 1 ] ).disabled ).toBe( false );
} );

// Everything below covers the surfaces a reader of this screen actually uses:
// the create form (validation, the args it sends), the one-time key panel, and
// the states the table can be in. They were reachable only by hand before.

const openCreate = ( container ) =>
	act( () =>
		Array.from( container.querySelectorAll( 'button' ) )
			.find( ( b ) => /issue session/i.test( b.textContent ) )
			.dispatchEvent( new Event( 'click', { bubbles: true } ) )
	);

const dialogButton = ( label ) =>
	Array.from(
		(
			document.querySelector( '[role="dialog"]' ) || document
		).querySelectorAll( 'button' )
	).find( ( b ) => label.test( b.textContent ) );

// Set a controlled input the React way.
const setInput = ( el, value ) => {
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		'value'
	).set;
	act( () => {
		setter.call( el, value );
		el.dispatchEvent( new Event( 'input', { bubbles: true } ) );
	} );
};

it( 'refuses to issue a session with no label, and says why', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );

	act( () =>
		dialogButton( /issue session/i ).dispatchEvent(
			new Event( 'click', { bubbles: true } )
		)
	);

	expect( createSession ).not.toHaveBeenCalled();
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toMatch(
		/label is required/i
	);
} );

it( 'issues with the label, scope and lifetime the form holds', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	setInput( document.querySelector( '#new-session-label' ), 'laptop mcp' );
	setInput( document.querySelector( '#new-session-ttl' ), '4471' );

	act( () =>
		dialogButton( /issue session/i ).dispatchEvent(
			new Event( 'click', { bubbles: true } )
		)
	);

	expect( createSession ).toHaveBeenCalledWith( {
		label: 'laptop mcp',
		scope: 'read',
		ttl: 4471,
	} );
} );

// The key is recoverable from nothing: the create answer is the only place it
// is ever shown, so the panel replaces the form rather than closing it.
it( 'discloses the issued key once, in place of the form', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	setInput( document.querySelector( '#new-session-label' ), 'laptop mcp' );
	act( () =>
		dialogButton( /issue session/i ).dispatchEvent(
			new Event( 'click', { bubbles: true } )
		)
	);

	answer( 'create', {
		subject: 'laptop mcp',
		result: {
			handle: 'h-9001',
			key: 'k-secret',
			scope: 'read',
			expires_in: 3600,
		},
	} );

	const dialog = document.querySelector( '[role="dialog"]' );
	expect( dialog.textContent ).toContain( 'h-9001.k-secret' );
	expect( dialog.textContent ).toMatch( /shown once/i );
	// The form is gone: there is no way back to a key.
	expect( document.querySelector( '#new-session-label' ) ).toBeNull();
} );

it( 'keeps the form open on a refusal, with the reason on it', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	setInput( document.querySelector( '#new-session-label' ), 'laptop mcp' );
	act( () =>
		dialogButton( /issue session/i ).dispatchEvent(
			new Event( 'click', { bubbles: true } )
		)
	);

	answer( 'create', { subject: 'laptop mcp', error: 'scope refused' } );

	expect( document.querySelector( '#new-session-label' ) ).not.toBeNull();
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toContain(
		'scope refused'
	);
} );

it( 'renders each session with its scope, state and times', () => {
	const { container } = render( <SessionsAdmin /> );
	const row = rowsOf( container )[ 0 ];
	expect( row.textContent ).toContain( 'hub-aggregator' );
	expect( row.querySelector( '.nodes-sessions__scope' ).textContent ).toBe(
		'read'
	);
	expect( row.textContent ).toContain( 'live' );
} );

it( 'says an expired session is expired', () => {
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: [ { ...SESSIONS[ 0 ], live: false } ],
			scopes: [ 'read' ],
			ttlMax: 86400,
			loading: false,
			error: null,
			createSession,
			revokeSession,
			pendingVerb: () => null,
		};
	} );
	const { container } = render( <SessionsAdmin /> );
	expect( rowsOf( container )[ 0 ].textContent ).toContain( 'expired' );
} );

it( 'says so when no session has been issued', () => {
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: [],
			scopes: [],
			ttlMax: 0,
			loading: false,
			error: null,
			createSession,
			revokeSession,
			pendingVerb: () => null,
		};
	} );
	const { container } = render( <SessionsAdmin /> );
	expect( container.textContent ).toContain( 'No sessions issued.' );
} );

it( 'surfaces a graph error in the banner', () => {
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: SESSIONS,
			scopes: [ 'read' ],
			ttlMax: 86400,
			loading: false,
			error: 'sessions unavailable',
			createSession,
			revokeSession,
			pendingVerb: () => null,
		};
	} );
	const { container } = render( <SessionsAdmin /> );
	expect(
		container.querySelector( '.newspack-nodes-error-banner' ).textContent
	).toContain( 'sessions unavailable' );
} );

it( 'cancels a revoke without sending it', () => {
	const { container } = render( <SessionsAdmin /> );
	clickRevoke( rowsOf( container )[ 0 ] );
	act( () =>
		dialogButton( /cancel/i ).dispatchEvent(
			new Event( 'click', { bubbles: true } )
		)
	);
	expect( revokeSession ).not.toHaveBeenCalled();
	expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
} );
