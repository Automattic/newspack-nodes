import { isDebugEnabled } from '../isDebugEnabled';

const KEY = 'newspack-nodes:debug';

describe( 'isDebugEnabled', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'is false by default', () => {
		expect( isDebugEnabled( '' ) ).toBe( false );
	} );

	it( '?nodes-debug=1 enables AND persists to localStorage', () => {
		expect( isDebugEnabled( '?nodes-debug=1' ) ).toBe( true );
		expect( window.localStorage.getItem( KEY ) ).toBe( '1' );
	} );

	it( 'a persisted flag keeps it enabled without the param', () => {
		window.localStorage.setItem( KEY, '1' );
		expect( isDebugEnabled( '' ) ).toBe( true );
	} );

	it( '?nodes-debug=0 disables AND clears the persisted flag', () => {
		window.localStorage.setItem( KEY, '1' );
		expect( isDebugEnabled( '?nodes-debug=0' ) ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'honors ?nodes-debug=1 when localStorage is unavailable', () => {
		const spy = jest.spyOn( window.Storage.prototype, 'setItem' );
		spy.mockImplementation( () => {
			throw new Error( 'blocked' );
		} );
		try {
			expect( isDebugEnabled( '?nodes-debug=1' ) ).toBe( true );
		} finally {
			spy.mockRestore();
		}
	} );
} );
