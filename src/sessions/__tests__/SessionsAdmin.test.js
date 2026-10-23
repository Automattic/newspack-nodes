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
	},
	{
		handle: 'h-8823',
		label: 'spoke-probe',
		scope: 'tune',
		expires: 4102444800,
		created: 1771000000,
	},
];

const CONNECTIONS = [
	{
		grant: 'g-7746',
		name: 'Tui laptop',
		client: 'Kea Desk 4410',
		scope: 'read',
		created: 1790027746,
		expires: 1792619746,
	},
];

let createSession;
let revoke;
let graphOpts = {};
// What the graph reports as outstanding; the screen asks rather than keeping a
// flag of its own.
let pendingSubjects = [];

beforeEach( () => {
	Core.reset();
	createSession = jest.fn();
	revoke = jest.fn();
	graphOpts = {};
	pendingSubjects = [];
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: SESSIONS,
			connections: CONNECTIONS,
			scopes: { read: 'Kea read 7746', tune: 'Kea tune 7746' },
			ttlMax: 86400,
			loading: false,
			error: null,
			createSession,
			revoke,
			pendingVerb: ( subject ) =>
				pendingSubjects.includes( subject ) ? 'revoke' : null,
		};
	} );
} );

// A reply, already addressed: the graph hands the screen the answer and the
// SUBJECT it named, exactly as the reply path delivered it.
const answer = ( verb, { subject, error = null, result = null } ) =>
	act( () => graphOpts.onAnswer?.( { verb, subject, error, result } ) );

const rowsOf = ( container ) =>
	container.querySelectorAll( '.nodes-sessions__sessions tbody tr' );

const connectionRowsOf = ( container ) =>
	container.querySelectorAll( '.nodes-sessions__connections tbody tr' );

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

	expect( revoke ).toHaveBeenCalledWith( 'h-4471' );
	expect( revoke ).toHaveBeenCalledTimes( 1 );
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
// the states the table can be in.

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

	act( () => dialogButton( /issue session/i ).click() );

	expect( createSession ).not.toHaveBeenCalled();
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toMatch(
		/label is required/i
	);
} );

const scopeOptions = () =>
	Array.from( document.querySelectorAll( '#new-session-scope option' ) ).map(
		( o ) => o.value
	);

it( 'offers exactly the scopes the list verb answered, tune selected', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );

	expect( scopeOptions() ).toEqual( [ 'read', 'tune' ] );
	expect( document.querySelector( '#new-session-scope' ).value ).toBe(
		'tune'
	);
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toContain(
		'Kea tune 7746'
	);
} );

it( 'takes the default scope once the list answers after the form opened', () => {
	const graph = ( scopes ) => ( {
		sessions: SESSIONS,
		scopes,
		ttlMax: 86400,
		loading: false,
		error: null,
		createSession,
		revoke,
		pendingVerb: () => null,
	} );
	useSessionsGraph.mockImplementation( () => graph( {} ) );
	const { container, rerender } = render( <SessionsAdmin /> );
	openCreate( container );
	useSessionsGraph.mockImplementation( () =>
		graph( { read: 'Kea read 7746', tune: 'Kea tune 7746' } )
	);
	rerender( <SessionsAdmin /> );
	setInput( document.querySelector( '#new-session-label' ), 'late list' );

	act( () => dialogButton( /issue session/i ).click() );

	expect( createSession ).toHaveBeenCalledWith(
		expect.objectContaining( { label: 'late list', scope: 'tune' } )
	);
} );

it( 'offers manage with the label the server serves once it lists it', () => {
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: SESSIONS,
			scopes: {
				read: 'Kea read 7746',
				tune: 'Kea tune 7746',
				manage: 'Kea manage 7746',
			},
			ttlMax: 86400,
			loading: false,
			error: null,
			createSession,
			revoke,
			pendingVerb: () => null,
		};
	} );
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	const select = document.querySelector( '#new-session-scope' );
	act( () => {
		select.value = 'manage';
		select.dispatchEvent( new Event( 'change', { bubbles: true } ) );
	} );

	expect( scopeOptions() ).toEqual( [ 'read', 'tune', 'manage' ] );
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toContain(
		'Kea manage 7746'
	);
} );

it( 'issues with the label, scope and lifetime the form holds', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	setInput( document.querySelector( '#new-session-label' ), 'laptop mcp' );
	setInput( document.querySelector( '#new-session-ttl' ), '4471' );

	act( () => dialogButton( /issue session/i ).click() );

	expect( createSession ).toHaveBeenCalledWith( {
		label: 'laptop mcp',
		scope: 'tune',
		ttl: 4471,
	} );
} );

// jsdom performs no implicit submission, so Enter is the form's submit; the
// key panel that replaces the form has no default action to submit.
it( 'issues when the dialog form submits, Issue Session being its submit', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	const dialog = document.querySelector( '[role="dialog"]' );
	expect( dialog.tagName ).toBe( 'FORM' );
	expect( dialog.noValidate ).toBe( true );
	expect( dialogButton( /issue session/i ).type ).toBe( 'submit' );
	expect( dialogButton( /cancel/i ).type ).toBe( 'button' );
	setInput( document.querySelector( '#new-session-label' ), 'egret relay' );
	setInput( document.querySelector( '#new-session-ttl' ), '30' );

	act( () => {
		dialog.dispatchEvent(
			new Event( 'submit', { bubbles: true, cancelable: true } )
		);
	} );

	expect( createSession ).toHaveBeenCalledWith( {
		label: 'egret relay',
		scope: 'tune',
		ttl: 30,
	} );
	answer( 'create', {
		subject: 'egret relay',
		result: { handle: 'h-5', secret: 's', scope: 'read', expires_in: 30 },
	} );
	expect( document.querySelector( '[role="dialog"]' ).tagName ).toBe( 'DIV' );
} );

// The key is recoverable from nothing: the create answer is the only place it
// is ever shown, so the panel replaces the form rather than closing it.
it( 'discloses the issued key once, in place of the form', () => {
	const { container } = render( <SessionsAdmin /> );
	openCreate( container );
	setInput( document.querySelector( '#new-session-label' ), 'laptop mcp' );
	act( () => dialogButton( /issue session/i ).click() );

	answer( 'create', {
		subject: 'laptop mcp',
		result: {
			handle: 'h-9001',
			secret: 'k-secret',
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
	act( () => dialogButton( /issue session/i ).click() );

	answer( 'create', { subject: 'laptop mcp', error: 'scope refused' } );

	expect( document.querySelector( '#new-session-label' ) ).not.toBeNull();
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toContain(
		'scope refused'
	);
} );

it( 'renders each session with its scope and times', () => {
	const { container } = render( <SessionsAdmin /> );
	const row = rowsOf( container )[ 0 ];
	expect( row.textContent ).toContain( 'hub-aggregator' );
	expect( row.querySelector( '.nodes-sessions__scope' ).textContent ).toBe(
		'read'
	);
	expect( row.textContent ).toContain(
		new Date( 4102444800 * 1000 ).toLocaleString()
	);
} );

it( 'lists no state column: every listed session is live', () => {
	const { container } = render( <SessionsAdmin /> );
	const headers = [
		...container.querySelectorAll( '.nodes-sessions__sessions thead th' ),
	].map( ( th ) => th.textContent );
	expect( headers ).toEqual( [
		'Label',
		'Scope',
		'Issued',
		'Expires',
		'Actions',
	] );
} );

it( 'says so when no session has been issued', () => {
	useSessionsGraph.mockImplementation( ( opts = {} ) => {
		graphOpts = opts;
		return {
			sessions: [],
			scopes: {},
			ttlMax: 0,
			loading: false,
			error: null,
			createSession,
			revoke,
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
			scopes: { read: 'Kea read 7746' },
			ttlMax: 86400,
			loading: false,
			error: 'sessions unavailable',
			createSession,
			revoke,
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
	expect( revoke ).not.toHaveBeenCalled();
	expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
} );

// A connection is listed by the name its approver gave it, idle or not, and
// revoked by its grant: the verb ends the grant and every session it minted.
it( 'lists each connection with its name, client, scope and times', () => {
	const { container } = render( <SessionsAdmin /> );
	const headers = [
		...container.querySelectorAll(
			'.nodes-sessions__connections thead th'
		),
	].map( ( th ) => th.textContent );
	const row = connectionRowsOf( container )[ 0 ];

	expect( headers ).toEqual( [
		'Connection',
		'Client',
		'Scope',
		'Approved',
		'Expires',
		'Actions',
	] );
	expect( row.textContent ).toContain( 'Tui laptop' );
	expect( row.textContent ).toContain( 'Kea Desk 4410' );
	expect( row.querySelector( '.nodes-sessions__scope' ).textContent ).toBe(
		'read'
	);
	expect( row.textContent ).toContain(
		new Date( 1790027746 * 1000 ).toLocaleString()
	);
	expect( row.textContent ).toContain(
		new Date( 1792619746 * 1000 ).toLocaleString()
	);
} );

it( 'revokes a connection by its grant', () => {
	const { container } = render( <SessionsAdmin /> );
	clickRevoke( connectionRowsOf( container )[ 0 ] );
	expect( document.querySelector( '[role="dialog"]' ).textContent ).toMatch(
		/every session it minted/i
	);
	confirmDialog();

	expect( revoke ).toHaveBeenCalledWith( 'g-7746' );
	expect( revoke ).toHaveBeenCalledTimes( 1 );
} );

it( 'shows a connection’s refusal on its own row', () => {
	const { container } = render( <SessionsAdmin /> );
	answer( 'revoke', { subject: 'g-7746', error: 'store refused 7746' } );

	expect( connectionRowsOf( container )[ 0 ].textContent ).toContain(
		'store refused 7746'
	);
} );

it( 'names a connection whose client registration lapsed with a dash', () => {
	useSessionsGraph.mockImplementation( () => ( {
		sessions: [],
		connections: [ { ...CONNECTIONS[ 0 ], client: '' } ],
		scopes: {},
		ttlMax: 0,
		loading: false,
		error: null,
		createSession,
		revoke,
		pendingVerb: () => null,
	} ) );
	const { container } = render( <SessionsAdmin /> );

	expect(
		connectionRowsOf( container )[ 0 ].querySelectorAll( 'td' )[ 1 ]
			.textContent
	).toBe( '—' );
} );

it( 'says so when no connection has been approved', () => {
	useSessionsGraph.mockImplementation( () => ( {
		sessions: SESSIONS,
		connections: [],
		scopes: {},
		ttlMax: 0,
		loading: false,
		error: null,
		createSession,
		revoke,
		pendingVerb: () => null,
	} ) );
	const { container } = render( <SessionsAdmin /> );

	expect( connectionRowsOf( container )[ 0 ].textContent ).toBe(
		'No connections approved.'
	);
} );
