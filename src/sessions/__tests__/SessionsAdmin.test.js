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
