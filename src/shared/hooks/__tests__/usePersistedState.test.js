/**
 * usePersistedState / usePersistedChoice — the read → validate → fall back →
 * write back state machine three dashboards wrote by hand.
 *
 * The type-preservation cases are the load-bearing ones: the Gyroscope's
 * refresh interval is a NUMBER of seconds and the Performance dashboard's is a
 * STRING of milliseconds, and localStorage hands both back as text. Matching an
 * option by its own `String( value )` is what returns each in its own type.
 */

import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import {
	usePersistedState,
	usePersistedChoice,
	usePersistedFlag,
} from '../usePersistedState';

// Seeds no caller defaults to: neither 5/10/30s nor 5000/15000/30000ms.
const SECOND_OPTIONS = [
	{ label: '0.75s', value: 0.75 },
	{ label: '7s', value: 7 },
	{ label: '42s', value: 42 },
];

const MS_OPTIONS = [
	{ label: '250ms', value: '250' },
	{ label: '90s', value: '90000' },
];

beforeEach( () => window.localStorage.clear() );

it( 'restores through the caller-supplied decoder', () => {
	window.localStorage.setItem( 'persisted:list', '["ripe","olive"]' );

	const { result } = renderHook( () =>
		usePersistedState(
			'persisted:list',
			( raw ) => ( null === raw ? [ 'plum' ] : JSON.parse( raw ) ),
			JSON.stringify
		)
	);

	expect( result.current[ 0 ] ).toEqual( [ 'ripe', 'olive' ] );
} );

it( 'writes the new value back through the caller-supplied encoder', () => {
	const { result } = renderHook( () =>
		usePersistedState(
			'persisted:list',
			( raw ) => ( null === raw ? [ 'plum' ] : JSON.parse( raw ) ),
			JSON.stringify
		)
	);

	act( () => result.current[ 1 ]( [ 'quince' ] ) );

	expect( window.localStorage.getItem( 'persisted:list' ) ).toBe(
		'["quince"]'
	);
} );

it( 'keeps a stored numeric option A NUMBER, not the stored text', () => {
	window.localStorage.setItem( 'persisted:seconds', '0.75' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	expect( result.current[ 0 ] ).toBe( 0.75 );
} );

it( 'keeps a stored string option A STRING', () => {
	window.localStorage.setItem( 'persisted:ms', '90000' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:ms', MS_OPTIONS, '250' )
	);

	expect( result.current[ 0 ] ).toBe( '90000' );
} );

it( 'falls back when the stored value is no longer an option', () => {
	window.localStorage.setItem( 'persisted:seconds', '3600' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 42 )
	);

	expect( result.current[ 0 ] ).toBe( 42 );
} );

it( 'persists a new choice as the option list spells it', () => {
	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	act( () => result.current[ 1 ]( 42 ) );

	expect( result.current[ 0 ] ).toBe( 42 );
	expect( window.localStorage.getItem( 'persisted:seconds' ) ).toBe( '42' );
} );

it( 'falls back on a storage-blocked browser without throwing', () => {
	const getItem = jest
		.spyOn( window.localStorage.__proto__, 'getItem' )
		.mockImplementation( () => {
			throw new Error( 'SecurityError' );
		} );
	const setItem = jest
		.spyOn( window.localStorage.__proto__, 'setItem' )
		.mockImplementation( () => {
			throw new Error( 'SecurityError' );
		} );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	expect( result.current[ 0 ] ).toBe( 7 );
	act( () => result.current[ 1 ]( 0.75 ) );
	expect( result.current[ 0 ] ).toBe( 0.75 );

	getItem.mockRestore();
	setItem.mockRestore();
} );

describe( 'usePersistedFlag', () => {
	const flag = ( key, def ) =>
		renderHook( ( p ) => usePersistedFlag( p.key, p.def ), {
			initialProps: { key, def },
		} );

	it.each( [
		[ '1', false, true ],
		[ '0', true, false ],
		[ 'yes', true, true ],
		[ 'yes', false, false ],
	] )( "reads stored '%s' with default %s as %s", ( raw, def, want ) => {
		window.localStorage.setItem( 'flag:read', raw );
		expect( flag( 'flag:read', def ).result.current[ 0 ] ).toBe( want );
	} );

	it( 'writes nothing on mount', () => {
		flag( 'flag:quiet', true );
		expect( window.localStorage.getItem( 'flag:quiet' ) ).toBeNull();
	} );

	it( "toggles and writes '1' or '0'", () => {
		const { result } = flag( 'flag:toggle', false );
		act( () => result.current[ 2 ]() );
		expect( result.current[ 0 ] ).toBe( true );
		expect( window.localStorage.getItem( 'flag:toggle' ) ).toBe( '1' );
		act( () => result.current[ 2 ]() );
		expect( window.localStorage.getItem( 'flag:toggle' ) ).toBe( '0' );
	} );

	it( 'sets without writing', () => {
		const { result } = flag( 'flag:set', false );
		act( () => result.current[ 1 ]( true ) );
		expect( result.current[ 0 ] ).toBe( true );
		act( () => result.current[ 1 ]( ( on ) => ! on ) );
		expect( result.current[ 0 ] ).toBe( false );
		expect( window.localStorage.getItem( 'flag:set' ) ).toBeNull();
	} );

	it( 're-reads a changed key and writes nothing under it', () => {
		window.localStorage.setItem( 'flag:a', '1' );
		window.localStorage.setItem( 'flag:c', '1' );
		const { result, rerender } = flag( 'flag:a', false );
		expect( result.current[ 0 ] ).toBe( true );
		rerender( { key: 'flag:b', def: false } );
		expect( result.current[ 0 ] ).toBe( false );
		expect( window.localStorage.getItem( 'flag:b' ) ).toBeNull();
		rerender( { key: 'flag:c', def: false } );
		expect( result.current[ 0 ] ).toBe( true );
	} );

	it( 'follows a changed default under an unstored key from its first render', () => {
		const seen = [];
		const { rerender } = renderHook(
			( p ) => {
				const [ value ] = usePersistedFlag( 'flag:def', p.def );
				seen.push( [ p.def, value ] );
				return value;
			},
			{ initialProps: { def: false } }
		);
		rerender( { def: true } );
		const values = seen
			.filter( ( [ def ] ) => def )
			.map( ( [ , value ] ) => value );
		expect( new Set( values ) ).toEqual( new Set( [ true ] ) );
	} );

	it( 'toggles under the new key after a key change', () => {
		window.localStorage.setItem( 'flag:before', '1' );
		const { result, rerender } = flag( 'flag:before', false );
		rerender( { key: 'flag:after', def: false } );
		act( () => result.current[ 2 ]() );
		expect( window.localStorage.getItem( 'flag:after' ) ).toBe( '1' );
		expect( window.localStorage.getItem( 'flag:before' ) ).toBe( '1' );
	} );

	it( 'returns the new key’s value from the first render after a change', () => {
		window.localStorage.setItem( 'flag:old', '1' );
		window.localStorage.setItem( 'flag:new', '0' );
		const seen = [];
		const { rerender } = renderHook(
			( p ) => {
				const [ value ] = usePersistedFlag( p.key, false );
				seen.push( [ p.key, value ] );
				return value;
			},
			{ initialProps: { key: 'flag:old' } }
		);
		rerender( { key: 'flag:new' } );
		const values = seen
			.filter( ( [ key ] ) => 'flag:new' === key )
			.map( ( [ , value ] ) => value );
		expect( new Set( values ) ).toEqual( new Set( [ false ] ) );
	} );

	it( 'reads storage once on mount', () => {
		const read = jest.spyOn(
			Object.getPrototypeOf( window.localStorage ),
			'getItem'
		);
		try {
			flag( 'flag:once', true );
			expect(
				read.mock.calls.filter( ( [ key ] ) => 'flag:once' === key )
			).toHaveLength( 1 );
		} finally {
			read.mockRestore();
		}
	} );

	it( 'writes once per toggle under StrictMode', () => {
		const write = jest.spyOn(
			Object.getPrototypeOf( window.localStorage ),
			'setItem'
		);
		try {
			const { result } = renderHook(
				() => usePersistedFlag( 'flag:strict', false ),
				{ wrapper: StrictMode }
			);
			act( () => result.current[ 2 ]() );
			act( () => result.current[ 2 ]() );
			expect( write.mock.calls.map( ( [ , raw ] ) => raw ) ).toEqual( [
				'1',
				'0',
			] );
			expect( result.current[ 0 ] ).toBe( false );
		} finally {
			write.mockRestore();
		}
	} );
} );
