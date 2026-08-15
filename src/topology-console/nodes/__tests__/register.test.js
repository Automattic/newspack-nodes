/**
 * `vaults:view` — the console's vault_id dropdown, as a slice.
 *
 * The `vault list` reply is a live `{ id: public_shape }` map; the dropdown
 * wants the `{id,url}` option array. A failure keeps whatever is on screen:
 * this polls, so the next tick is the retry, and blanking the dropdown on one
 * bad tick is the bug the old `fetched` latch had.
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
import { views } from '../register';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new views.VaultCatalogView();
	node.name = 'vaults:view';
	return node;
}

function reply( payload, type = TM_COMMAND | TM_RESPONSE ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = { name: 'list', payload };
	return m;
}

test( 'the empty slice loads with no options', () => {
	expect( makeView().model ).toEqual( {
		vaults: null,
		loading: true,
		error: null,
	} );
} );

test( 'a list reply becomes the option shape', () => {
	const view = makeView();
	view.fill(
		reply( {
			'spoke-a': { id: 'spoke-a', url: 'https://a.example.test' },
			'spoke-b': { id: 'spoke-b' },
		} )
	);

	expect( view.model.vaults ).toEqual( [
		{ id: 'spoke-a', url: 'https://a.example.test' },
		{ id: 'spoke-b', url: '' },
	] );
	expect( view.model.loading ).toBe( false );
} );

test( 'an empty catalog is a settled empty list, not still loading', () => {
	const view = makeView();
	view.fill( reply( {} ) );

	expect( view.model.vaults ).toEqual( [] );
	expect( view.model.loading ).toBe( false );
} );

test( 'a failure keeps the options already on screen', () => {
	const view = makeView();
	view.fill( reply( { 'spoke-a': { id: 'spoke-a', url: 'u' } } ) );
	view.fill( reply( 'permission denied', TM_COMMAND | TM_ERROR ) );

	expect( view.model.vaults ).toEqual( [ { id: 'spoke-a', url: 'u' } ] );
	expect( view.model.error ).toMatch( /permission denied/ );
	expect( view.model.loading ).toBe( false );
} );

test( 'a garbage payload keeps the prior slice', () => {
	const view = makeView();
	view.fill( reply( { 'spoke-a': { id: 'spoke-a', url: 'u' } } ) );
	view.fill( reply( 'not a map' ) );

	expect( view.model.vaults ).toEqual( [ { id: 'spoke-a', url: 'u' } ] );
} );
