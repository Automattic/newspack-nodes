import {
	registerTab,
	getTabs,
	resetTabs,
	subscribeTabs,
	getTabsVersion,
} from '../tabRegistry';

describe( 'tab registry', () => {
	beforeEach( resetTabs );

	const Comp = () => null;

	describe( 'subscription (so a host re-renders when a late bundle registers)', () => {
		it( 'notifies subscribers on register, and stops after unsubscribe', () => {
			const listener = jest.fn();
			const unsubscribe = subscribeTabs( listener );
			registerTab( {
				id: 'x',
				label: 'X',
				host: 'station',
				component: Comp,
			} );
			expect( listener ).toHaveBeenCalledTimes( 1 );
			unsubscribe();
			registerTab( {
				id: 'y',
				label: 'Y',
				host: 'station',
				component: Comp,
			} );
			expect( listener ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'changes the version snapshot on register and reset', () => {
			const v0 = getTabsVersion();
			registerTab( {
				id: 'x',
				label: 'X',
				host: 'station',
				component: Comp,
			} );
			const v1 = getTabsVersion();
			expect( v1 ).not.toBe( v0 );
			resetTabs();
			expect( getTabsVersion() ).not.toBe( v1 );
		} );
	} );

	it( 'returns tabs whose host matches, plus both', () => {
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'overlay',
			component: Comp,
		} );
		registerTab( {
			id: 'b',
			label: 'B',
			host: 'station',
			component: Comp,
		} );
		registerTab( {
			id: 'c',
			label: 'C',
			host: 'both',
			component: Comp,
		} );
		expect( getTabs( 'overlay' ).map( ( t ) => t.id ) ).toEqual( [
			'a',
			'c',
		] );
		expect( getTabs( 'station' ).map( ( t ) => t.id ) ).toEqual( [
			'b',
			'c',
		] );
	} );

	it( 'sorts by order then label', () => {
		registerTab( {
			id: 'z',
			label: 'Zed',
			host: 'station',
			order: 1,
			component: Comp,
		} );
		registerTab( {
			id: 'm',
			label: 'Mid',
			host: 'station',
			order: 1,
			component: Comp,
		} );
		registerTab( {
			id: 'a',
			label: 'Ack',
			host: 'station',
			order: 0,
			component: Comp,
		} );
		expect( getTabs( 'station' ).map( ( t ) => t.id ) ).toEqual( [
			'a',
			'm',
			'z',
		] );
	} );

	it( 're-registering an id shadows the prior descriptor', () => {
		registerTab( {
			id: 'a',
			label: 'Old',
			host: 'station',
			component: Comp,
		} );
		registerTab( {
			id: 'a',
			label: 'New',
			host: 'station',
			component: Comp,
		} );
		const list = getTabs( 'station' );
		expect( list ).toHaveLength( 1 );
		expect( list[ 0 ].label ).toBe( 'New' );
	} );

	it( 'excludes a tab whose gate returns false', () => {
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			component: Comp,
			gate: () => false,
		} );
		registerTab( {
			id: 'b',
			label: 'B',
			host: 'station',
			component: Comp,
			gate: () => true,
		} );
		expect( getTabs( 'station' ).map( ( t ) => t.id ) ).toEqual( [ 'b' ] );
	} );

	it( 'normalizes a non-finite order to 0', () => {
		// Non-finite order must coerce to 0 and sort 'z' before 'a' (order 1).
		registerTab( {
			id: 'z',
			label: 'Zzz',
			host: 'station',
			order: 'high',
			component: Comp,
		} );
		registerTab( {
			id: 'a',
			label: 'Aaa',
			host: 'station',
			order: 1,
			component: Comp,
		} );
		expect( getTabs( 'station' ).map( ( t ) => t.id ) ).toEqual( [
			'z',
			'a',
		] );
	} );

	it( 'defaults slug to the tab id when none is given', () => {
		registerTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'station',
			component: Comp,
		} );
		expect( getTabs( 'station' )[ 0 ].slug ).toBe( 'topology-console' );
	} );

	it( 'preserves an explicit slug', () => {
		registerTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'station',
			slug: 'console',
			component: Comp,
		} );
		expect( getTabs( 'station' )[ 0 ].slug ).toBe( 'console' );
	} );

	it( 'throws on a bad host', () => {
		expect( () =>
			registerTab( {
				id: 'a',
				label: 'A',
				host: 'nope',
				component: Comp,
			} )
		).toThrow( /host must be/ );
	} );

	it( 'throws when a required field is missing', () => {
		expect( () =>
			registerTab( { id: 'a', host: 'station', component: Comp } )
		).toThrow();
	} );

	it( 'shares the registry across separately-loaded module instances', () => {
		// resetModules() simulates a second inlined copy; the store is global.
		registerTab( {
			id: 'cross',
			label: 'Cross',
			host: 'station',
			component: Comp,
		} );
		jest.resetModules();
		const fresh = require( '../tabRegistry' );
		expect( fresh.getTabs( 'station' ).map( ( t ) => t.id ) ).toEqual( [
			'cross',
		] );
	} );
} );
