/**
 * overviewPrefs — localStorage read/write for the Overview tab's user-chosen
 * topology order + folded/unfolded state. Matches the usePanelChrome try/catch
 * idiom: corrupt payloads and a throwing localStorage degrade to the default
 * (readers → [], writers → no-op), never throw.
 *
 * The storage keys are private, so the format/separation assertions go through
 * `window.Storage.prototype` spies: `captureWrites` records what each writer
 * stored, and `serveRaw` feeds every reader one corrupt payload.
 */

import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
	readCollapsed,
	writeCollapsed,
} from '../overviewPrefs';

// Record every ( key, value ) a writer stores, without touching real storage.
function captureWrites() {
	const writes = [];
	jest.spyOn( window.Storage.prototype, 'setItem' ).mockImplementation(
		( key, value ) => writes.push( { key, value } )
	);
	return writes;
}

// Serve one raw payload to every reader, whatever key it asks for.
function serveRaw( raw ) {
	jest.spyOn( window.Storage.prototype, 'getItem' ).mockReturnValue( raw );
}

afterEach( () => jest.restoreAllMocks() );

describe( 'overviewPrefs order', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'round-trips an order array', () => {
		writeOrder( [ 'beta', 'alpha' ] );
		expect( readOrder() ).toEqual( [ 'beta', 'alpha' ] );
	} );

	it( 'stores the order as a JSON array', () => {
		const writes = captureWrites();
		writeOrder( [ 'beta', 'alpha' ] );
		expect( JSON.parse( writes[ 0 ].value ) ).toEqual( [
			'beta',
			'alpha',
		] );
	} );

	it( 'returns [] when nothing is stored', () => {
		expect( readOrder() ).toEqual( [] );
	} );

	it( 'returns [] on corrupt JSON', () => {
		serveRaw( '{not json' );
		expect( readOrder() ).toEqual( [] );
	} );

	it( 'returns [] on a non-array payload', () => {
		serveRaw( JSON.stringify( { a: 1 } ) );
		expect( readOrder() ).toEqual( [] );
	} );
} );

describe( 'overviewPrefs expanded', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'round-trips a Set, reading it back as a Set', () => {
		writeExpanded( new Set( [ 'alpha', 'beta' ] ) );
		const set = readExpanded();
		expect( set ).toBeInstanceOf( Set );
		expect( [ ...set ].sort() ).toEqual( [ 'alpha', 'beta' ] );
	} );

	it( 'stores the Set as a JSON array', () => {
		const writes = captureWrites();
		writeExpanded( new Set( [ 'alpha', 'beta' ] ) );
		expect( JSON.parse( writes[ 0 ].value ) ).toEqual( [
			'alpha',
			'beta',
		] );
	} );

	it( 'returns an empty Set when nothing is stored', () => {
		const set = readExpanded();
		expect( set ).toBeInstanceOf( Set );
		expect( set.size ).toBe( 0 );
	} );

	it( 'returns an empty Set on corrupt JSON', () => {
		serveRaw( '<broken>' );
		expect( readExpanded().size ).toBe( 0 );
	} );
} );

describe( 'overviewPrefs collapsed (inner node/partition folds)', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'round-trips a Set, reading it back as a Set', () => {
		writeCollapsed( new Set( [ 'firehose', 'firehose>completed' ] ) );
		const set = readCollapsed();
		expect( set ).toBeInstanceOf( Set );
		expect( [ ...set ].sort() ).toEqual( [
			'firehose',
			'firehose>completed',
		] );
	} );

	it( 'returns an empty Set when nothing is stored', () => {
		expect( readCollapsed().size ).toBe( 0 );
	} );

	it( 'returns an empty Set on corrupt JSON', () => {
		serveRaw( '<broken>' );
		expect( readCollapsed().size ).toBe( 0 );
	} );
} );

describe( 'overviewPrefs key separation', () => {
	beforeEach( () => window.localStorage.clear() );

	it( 'writes each preference under its own distinct key', () => {
		const writes = captureWrites();
		writeOrder( [ 'alpha' ] );
		writeExpanded( new Set( [ 'beta' ] ) );
		writeCollapsed( new Set( [ 'gamma' ] ) );
		const keys = writes.map( ( w ) => w.key );
		expect( new Set( keys ).size ).toBe( 3 );
	} );

	it( 'a collapsed write does not bleed into order or expanded', () => {
		writeCollapsed( new Set( [ 'firehose' ] ) );
		expect( readOrder() ).toEqual( [] );
		expect( readExpanded().size ).toBe( 0 );
	} );

	it( 'an expanded write does not bleed into order or collapsed', () => {
		writeExpanded( new Set( [ 'alpha' ] ) );
		expect( readOrder() ).toEqual( [] );
		expect( readCollapsed().size ).toBe( 0 );
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
