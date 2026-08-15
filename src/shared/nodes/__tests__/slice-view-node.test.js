/**
 * SliceViewNode tests — the shared thin-view-node base every dashboard
 * rebuild's slice views extend. These exercise the base contract through a
 * concrete subclass: parse a 200 reply into the slice, surface a TM_ERROR
 * (string OR { message } payload), keep the prior slice on transient garbage,
 * and start with the subclass's empty slice.
 */

import {
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { SliceViewNode, sliceView } from '../slice-view-node';

beforeEach( () => Core.reset() );

// A concrete subclass owning a `sources` slice, mirroring the example's views.
class CountsView extends SliceViewNode {
	emptySlice() {
		return { sources: {} };
	}
}

// A subclass whose empty slice carries the usual `loading` spinner flag.
class LoadingCountsView extends SliceViewNode {
	emptySlice() {
		return { sources: {}, loading: true, error: null };
	}
	_parse( payload ) {
		const slice = super._parse( payload );
		return slice && { ...slice, loading: false, error: null };
	}
}

function makeView() {
	const node = new CountsView();
	node.name = 'counts:view';
	return node;
}

function reply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'counts', payload };
	return m;
}

describe( 'SliceViewNode', () => {
	test( 'starts with the subclass empty slice', () => {
		expect( makeView().setStateCache.view ).toEqual( { sources: {} } );
	} );

	test( 'parses a 200 reply into the slice and publishes it', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { releases: 2 } } ) ) );
		expect( v.setStateCache.view ).toEqual( { sources: { releases: 2 } } );
	} );

	test( 'surfaces a TM_ERROR with a STRING payload as a slice error', () => {
		const v = makeView();
		const m = reply( 'counts read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /counts read failed/ );
	} );

	test( 'a TM_ERROR keeps the slice already on screen and stops loading', () => {
		const v = new LoadingCountsView();
		v.name = 'counts:view';
		v.fill( reply( JSON.stringify( { sources: { releases: 7 } } ) ) );
		const m = reply( 'counts read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;

		v.fill( m );

		expect( v.setStateCache.view.sources ).toEqual( { releases: 7 } );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );

	test( 'counts every message it absorbs, errors included', () => {
		const v = makeView();
		const m = reply( 'counts read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		v.fill( reply( JSON.stringify( { sources: { releases: 3 } } ) ) );
		expect( v.counter ).toBe( 2 );
	} );

	test( 'surfaces a TM_ERROR with an OBJECT { message } VALUE as a slice error', () => {
		const v = makeView();
		// A transport error arrives as a bare object VALUE; .payload has msg.
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ VALUE ] = { payload: { message: 'NOT_AVAILABLE' } };
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /NOT_AVAILABLE/ );
	} );

	test( 'declares `view` in the schema, so help and the palette list it', () => {
		expect( CountsView.nodeSchema().registrations ).toEqual( [ 'view' ] );
		expect( makeView().registrations.view ).toEqual( {} );
	} );

	test( 'the base emptySlice is an empty object', () => {
		// Exercised through base directly (no subclass emptySlice override).
		expect( new SliceViewNode().setStateCache.view ).toEqual( {} );
	} );

	test( 'an object reply whose payload is not a string keeps the prior slice', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { a: 1 } } ) ) );
		v.fill( reply( 12345 ) );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );

	test( 'an object reply whose payload is invalid JSON keeps the prior slice', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { a: 1 } } ) ) );
		v.fill( reply( '{not valid json' ) );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );

	test( 'a non-error unparseable string reply keeps the prior slice', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { a: 1 } } ) ) );
		const garbage = newMessage();
		garbage[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		garbage[ VALUE ] = 'not a json object';
		v.fill( garbage );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );
} );

// Nine views were a class file each, all the same two methods: an empty-model
// literal and a guard-then-map parse. That is a declaration, not a class.
describe( 'sliceView', () => {
	const VaultCatalogView = sliceView( {
		empty: { vaults: null, loading: true, error: null },
		parse: ( payload ) =>
			payload && 'object' === typeof payload
				? {
						vaults: Object.values( payload ).map( ( v ) => ( {
							id: v.id,
						} ) ),
						loading: false,
						error: null,
				  }
				: null,
	} );

	test( 'publishes the declared empty model before any reply', () => {
		expect( new VaultCatalogView().setStateCache.view ).toEqual( {
			vaults: null,
			loading: true,
			error: null,
		} );
	} );

	test( 'hands each view its OWN empty model, not one shared object', () => {
		const first = new VaultCatalogView();
		first.model.vaults = [ { id: 'mutated-4471' } ];
		expect( new VaultCatalogView().setStateCache.view.vaults ).toBeNull();
	} );

	test( 'maps a reply through the declared parse', () => {
		const v = new VaultCatalogView();
		v.name = 'vaults:view';
		v.fill( reply( { a: { id: 'wombat-4471' } } ) );
		expect( v.setStateCache.view ).toEqual( {
			vaults: [ { id: 'wombat-4471' } ],
			loading: false,
			error: null,
		} );
	} );

	test( 'keeps the prior model when the declared parse returns null', () => {
		const v = new VaultCatalogView();
		v.name = 'vaults:view';
		v.fill( reply( { a: { id: 'wombat-4471' } } ) );
		v.fill( reply( 'not an object' ) );
		expect( v.setStateCache.view.vaults ).toEqual( [
			{ id: 'wombat-4471' },
		] );
	} );

	// Some verbs answer a JSON string, some a live object; `json` is which.
	test( 'decodes a JSON-string payload first when json is declared', () => {
		const SummaryView = sliceView( {
			json: true,
			empty: { connected: 0, error: null },
			parse: ( body ) => ( { connected: body.connected, error: null } ),
		} );
		const v = new SummaryView();
		v.name = 'summary:view';
		v.fill( reply( JSON.stringify( { connected: 7 } ) ) );
		expect( v.setStateCache.view.connected ).toBe( 7 );
	} );

	test( 'a json view keeps the prior model on an undecodable payload', () => {
		const SummaryView = sliceView( {
			json: true,
			empty: { connected: 0, error: null },
			parse: ( body ) => ( { connected: body.connected, error: null } ),
		} );
		const v = new SummaryView();
		v.name = 'summary:view';
		v.fill( reply( JSON.stringify( { connected: 7 } ) ) );
		v.fill( reply( '{not valid json' ) );
		expect( v.setStateCache.view.connected ).toBe( 7 );
	} );

	test( 'carries a declared description into the node schema', () => {
		const Described = sliceView( {
			empty: {},
			parse: () => null,
			description: 'Worker Status render-model sink.',
		} );
		expect( Described.nodeSchema().description ).toBe(
			'Worker Status render-model sink.'
		);
		expect( Described.nodeSchema().registrations ).toEqual( [ 'view' ] );
	} );
} );
