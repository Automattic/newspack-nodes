/**
 * overviewPrefs — localStorage read/write for the Overview tab's user-chosen
 * topology order + folded/unfolded state. Matches the usePanelChrome try/catch
 * idiom: corrupt payloads and a throwing localStorage degrade to the default
 * (readers → [], writers → no-op), never throw.
 */

import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
	ORDER_KEY,
	EXPANDED_KEY,
} from '../overviewPrefs';

describe( 'overviewPrefs order', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'round-trips an order array', () => {
		writeOrder( [ 'beta', 'alpha' ] );
		expect( window.localStorage.getItem( ORDER_KEY ) ).toBe(
			JSON.stringify( [ 'beta', 'alpha' ] )
		);
		expect( readOrder() ).toEqual( [ 'beta', 'alpha' ] );
	} );

	it( 'returns [] when nothing is stored', () => {
		expect( readOrder() ).toEqual( [] );
	} );

	it( 'returns [] on corrupt JSON', () => {
		window.localStorage.setItem( ORDER_KEY, '{not json' );
		expect( readOrder() ).toEqual( [] );
	} );

	it( 'returns [] on a non-array payload', () => {
		window.localStorage.setItem( ORDER_KEY, JSON.stringify( { a: 1 } ) );
		expect( readOrder() ).toEqual( [] );
	} );
} );

describe( 'overviewPrefs expanded', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'round-trips a Set as a JSON array, reading it back as a Set', () => {
		writeExpanded( new Set( [ 'alpha', 'beta' ] ) );
		expect(
			JSON.parse( window.localStorage.getItem( EXPANDED_KEY ) )
		).toEqual( [ 'alpha', 'beta' ] );
		const set = readExpanded();
		expect( set ).toBeInstanceOf( Set );
		expect( [ ...set ].sort() ).toEqual( [ 'alpha', 'beta' ] );
	} );

	it( 'returns an empty Set when nothing is stored', () => {
		const set = readExpanded();
		expect( set ).toBeInstanceOf( Set );
		expect( set.size ).toBe( 0 );
	} );

	it( 'returns an empty Set on corrupt JSON', () => {
		window.localStorage.setItem( EXPANDED_KEY, '<broken>' );
		expect( readExpanded().size ).toBe( 0 );
	} );
} );

describe( 'overviewPrefs with a throwing localStorage', () => {
	let original;
	beforeEach( () => {
		original = Object.getOwnPropertyDescriptor( window, 'localStorage' );
		Object.defineProperty( window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error( 'disabled' );
			},
		} );
	} );
	afterEach( () => {
		Object.defineProperty( window, 'localStorage', original );
	} );

	it( 'readers degrade to the default without throwing', () => {
		expect( readOrder() ).toEqual( [] );
		expect( readExpanded().size ).toBe( 0 );
	} );

	it( 'writers no-op without throwing', () => {
		expect( () => writeOrder( [ 'a' ] ) ).not.toThrow();
		expect( () => writeExpanded( new Set( [ 'a' ] ) ) ).not.toThrow();
	} );
} );
