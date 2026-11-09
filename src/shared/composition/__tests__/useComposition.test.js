/* eslint-env jest */
/**
 * useComposition — a context's layout over the `compositions` service: one
 * fresh `get` on mount, and the two writes, each answering the layout the
 * context now reads.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useComposition } from '../useComposition';

const CONTEXT = 'acme-desk/board';
const GROUP = 'quayside';

// Distinct from every default, so a wrong-field read fails.
const SAVED = {
	context: CONTEXT,
	source: 'saved',
	blocks: [ { name: 'acme-desk/tally', attributes: { max: 7 }, inner: [] } ],
	saved_ts: 1912345678.25,
	actor: 'lakeside-editor',
};
const DEFAULTED = { ...SAVED, source: 'default', blocks: [], actor: null };

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( ( m ) =>
		'restore' === m[ VALUE ].name ? DEFAULTED : SAVED
	);
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

const sent = ( name ) =>
	replyFor.mock.calls
		.map( ( [ m ] ) => m[ VALUE ] )
		.filter( ( value ) => name === value.name );

const WAIT = { timeout: 4000 };

describe( 'useComposition', () => {
	it( 'reads the context fresh on mount', async () => {
		const { result } = renderHook( () => useComposition( GROUP, CONTEXT ) );
		expect( result.current.loading ).toBe( true );
		await waitFor(
			() => expect( result.current.answer ).toEqual( SAVED ),
			WAIT
		);
		expect( result.current.loading ).toBe( false );
		expect( result.current.error ).toBeNull();
		expect( sent( 'get' ) ).toEqual( [
			expect.objectContaining( { arguments: [ CONTEXT ] } ),
		] );
		// Its own group's Tap, and no node name carrying the context's slash.
		const fetcher = Core.node( 'compositions:acme-desk:board:get:fetch' );
		expect( fetcher.target ).toBe( `${ GROUP }:shell/_http/compositions` );
	} );

	it( 'answers a refused read as the error, and stops loading', async () => {
		replyFor.mockImplementation(
			() =>
				new Error(
					'composition acme-desk/board: the stored layout is malformed'
				)
		);
		const { result } = renderHook( () => useComposition( GROUP, CONTEXT ) );
		await waitFor(
			() =>
				expect( result.current.error ).toBe(
					'composition acme-desk/board: the stored layout is malformed'
				),
			WAIT
		);
		expect( result.current.loading ).toBe( false );
		expect( result.current.answer ).toBeNull();
	} );

	it( 'saves the markup once and hands onWritten the reply', async () => {
		const onWritten = jest.fn();
		const { result } = renderHook( () =>
			useComposition( GROUP, CONTEXT, onWritten )
		);
		await waitFor(
			() => expect( result.current.answer ).not.toBeNull(),
			WAIT
		);

		act( () => {
			result.current.save( '<!-- wp:acme-desk/tally {"max":7} /-->' );
		} );
		expect( result.current.writing ).toBe( true );
		await waitFor(
			() => expect( onWritten ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onWritten ).toHaveBeenCalledWith( SAVED, 'save' );
		expect( sent( 'save' ) ).toEqual( [
			expect.objectContaining( {
				arguments: [
					CONTEXT,
					'<!-- wp:acme-desk/tally {"max":7} /-->',
				],
			} ),
		] );
		expect( result.current.writing ).toBe( false );
		// A write still goes when the page is left.
		expect(
			Core.node( 'compositions:acme-desk:board:save:fetch' )
				.sends_on_removal
		).toBe( true );
	} );

	it( 'restores the default and hands onWritten the default', async () => {
		const onWritten = jest.fn();
		const { result } = renderHook( () =>
			useComposition( GROUP, CONTEXT, onWritten )
		);
		await waitFor(
			() => expect( result.current.answer ).not.toBeNull(),
			WAIT
		);

		act( () => {
			result.current.restore();
		} );
		await waitFor(
			() => expect( onWritten ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onWritten ).toHaveBeenCalledWith( DEFAULTED, 'restore' );
		expect( result.current.answer ).toEqual( DEFAULTED );
		expect( sent( 'restore' ) ).toEqual( [
			expect.objectContaining( { arguments: [ CONTEXT ] } ),
		] );
	} );

	it( 'answers a refused save as the refusal, leaving the layout read', async () => {
		const onWritten = jest.fn();
		const { result } = renderHook( () =>
			useComposition( GROUP, CONTEXT, onWritten )
		);
		await waitFor(
			() => expect( result.current.answer ).not.toBeNull(),
			WAIT
		);
		replyFor.mockImplementation(
			() =>
				new Error(
					'composition acme-desk/board: acme-desk/tally attribute max: max must be at most 20'
				)
		);

		act( () => {
			result.current.save( '<!-- wp:acme-desk/tally {"max":21} /-->' );
		} );
		await waitFor(
			() =>
				expect( result.current.refusal ).toBe(
					'composition acme-desk/board: acme-desk/tally attribute max: max must be at most 20'
				),
			WAIT
		);
		expect( onWritten ).not.toHaveBeenCalled();
		expect( result.current.answer ).toEqual( SAVED );
		expect( result.current.error ).toBeNull();
	} );
} );
