/**
 * SessionsAdmin — the issued-session table and its two verbs.
 *
 * Revoke belongs to the ROW and Create to the form, each scoped to the session
 * it is about, so a reply lands on a node serving that one surface. One node
 * per verb across every row cannot do that: the second reply lands where the
 * first did and blanks the first row's line, which is what these cover.
 */

jest.mock( '../hooks/useSessionsGraph', () => {
	const actual = jest.requireActual( '../hooks/useSessionsGraph' );
	return {
		__esModule: true,
		...actual,
		useSessionsGraph: jest.fn(),
	};
} );

jest.mock( '@newspack-nodes/shared/hooks/useCommandOnce', () =>
	require( '@newspack-nodes/shared/test-utils/mockCommandOnce' ).factory()
);

import { render, act } from '@testing-library/react';
import {
	answerCommand,
	sentTo,
	resetCommands,
} from '@newspack-nodes/shared/test-utils/mockCommandOnce';
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

let refresh;

beforeEach( () => {
	Core.reset();
	resetCommands();
	refresh = jest.fn();
	useSessionsGraph.mockImplementation( () => ( {
		sessions: SESSIONS,
		scopes: [ 'read', 'tune', 'manage' ],
		ttlMax: 86400,
		loading: false,
		error: null,
		refresh,
	} ) );
} );

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

	expect( sentTo( 'sessions:revoke:h-4471' ) ).toContainEqual( [ 'h-4471' ] );
	expect( sentTo( 'sessions:revoke:h-8823' ) ).toEqual( [] );
} );

// @longform Two rows revoked in the same second are two subjects, and each
// row shows its OWN answer. One node serving both cannot: the second reply
// lands where the first did, and the first row's failure disappears while it
// is still the current truth.
it( 'keeps each row’s refusal when a second row is revoked', () => {
	const { container } = render( <SessionsAdmin /> );

	clickRevoke( rowsOf( container )[ 0 ] );
	confirmDialog();
	answerCommand(
		'sessions:revoke:h-4471',
		{ error: 'no such session' },
		act
	);
	expect( rowsOf( container )[ 0 ].textContent ).toContain(
		'no such session'
	);

	clickRevoke( rowsOf( container )[ 1 ] );
	confirmDialog();
	answerCommand( 'sessions:revoke:h-8823', { error: 'refused' }, act );

	expect( rowsOf( container )[ 0 ].textContent ).toContain(
		'no such session'
	);
	expect( rowsOf( container )[ 1 ].textContent ).toContain( 'refused' );
} );

it( 'refreshes the table when a revoke answers', () => {
	const { container } = render( <SessionsAdmin /> );
	clickRevoke( rowsOf( container )[ 0 ] );
	confirmDialog();
	answerCommand( 'sessions:revoke:h-4471', { result: { ok: 1 } }, act );

	expect( refresh ).toHaveBeenCalled();
} );
