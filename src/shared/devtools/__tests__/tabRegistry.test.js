import {
	registerDevtoolsTab,
	getDevtoolsTabs,
	resetDevtoolsTabs,
	subscribeDevtoolsTabs,
	getDevtoolsTabsVersion,
} from '../tabRegistry';

describe( 'devtools tab registry', () => {
	beforeEach( resetDevtoolsTabs );

	const Comp = () => null;

	describe( 'subscription (so a host re-renders when a late bundle registers)', () => {
		it( 'notifies subscribers on register, and stops after unsubscribe', () => {
			const listener = jest.fn();
			const unsubscribe = subscribeDevtoolsTabs( listener );
			registerDevtoolsTab( {
				id: 'x',
				label: 'X',
				host: 'hub',
				component: Comp,
			} );
			expect( listener ).toHaveBeenCalledTimes( 1 );
			unsubscribe();
			registerDevtoolsTab( {
				id: 'y',
				label: 'Y',
				host: 'hub',
				component: Comp,
			} );
			expect( listener ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'changes the version snapshot on register and reset', () => {
			const v0 = getDevtoolsTabsVersion();
			registerDevtoolsTab( {
				id: 'x',
				label: 'X',
				host: 'hub',
				component: Comp,
			} );
			const v1 = getDevtoolsTabsVersion();
			expect( v1 ).not.toBe( v0 );
			resetDevtoolsTabs();
			expect( getDevtoolsTabsVersion() ).not.toBe( v1 );
		} );
	} );

	it( 'returns tabs whose host matches, plus both', () => {
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'overlay',
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'b',
			label: 'B',
			host: 'hub',
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'c',
			label: 'C',
			host: 'both',
			component: Comp,
		} );
		expect( getDevtoolsTabs( 'overlay' ).map( ( t ) => t.id ) ).toEqual( [
			'a',
			'c',
		] );
		expect( getDevtoolsTabs( 'hub' ).map( ( t ) => t.id ) ).toEqual( [
			'b',
			'c',
		] );
	} );

	it( 'sorts by order then label', () => {
		registerDevtoolsTab( {
			id: 'z',
			label: 'Zed',
			host: 'hub',
			order: 1,
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'm',
			label: 'Mid',
			host: 'hub',
			order: 1,
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'a',
			label: 'Ack',
			host: 'hub',
			order: 0,
			component: Comp,
		} );
		expect( getDevtoolsTabs( 'hub' ).map( ( t ) => t.id ) ).toEqual( [
			'a',
			'm',
			'z',
		] );
	} );

	it( 're-registering an id shadows the prior descriptor', () => {
		registerDevtoolsTab( {
			id: 'a',
			label: 'Old',
			host: 'hub',
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'a',
			label: 'New',
			host: 'hub',
			component: Comp,
		} );
		const list = getDevtoolsTabs( 'hub' );
		expect( list ).toHaveLength( 1 );
		expect( list[ 0 ].label ).toBe( 'New' );
	} );

	it( 'excludes a tab whose gate returns false', () => {
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'hub',
			component: Comp,
			gate: () => false,
		} );
		registerDevtoolsTab( {
			id: 'b',
			label: 'B',
			host: 'hub',
			component: Comp,
			gate: () => true,
		} );
		expect( getDevtoolsTabs( 'hub' ).map( ( t ) => t.id ) ).toEqual( [
			'b',
		] );
	} );

	it( 'normalizes a non-finite order to 0', () => {
		// Non-finite order must coerce to 0 and sort 'z' before 'a' (order 1).
		registerDevtoolsTab( {
			id: 'z',
			label: 'Zzz',
			host: 'hub',
			order: 'high',
			component: Comp,
		} );
		registerDevtoolsTab( {
			id: 'a',
			label: 'Aaa',
			host: 'hub',
			order: 1,
			component: Comp,
		} );
		expect( getDevtoolsTabs( 'hub' ).map( ( t ) => t.id ) ).toEqual( [
			'z',
			'a',
		] );
	} );

	it( 'defaults slug to the tab id when none is given', () => {
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			component: Comp,
		} );
		expect( getDevtoolsTabs( 'hub' )[ 0 ].slug ).toBe( 'topology-console' );
	} );

	it( 'preserves an explicit slug', () => {
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			slug: 'console',
			component: Comp,
		} );
		expect( getDevtoolsTabs( 'hub' )[ 0 ].slug ).toBe( 'console' );
	} );

	it( 'throws on a bad host', () => {
		expect( () =>
			registerDevtoolsTab( {
				id: 'a',
				label: 'A',
				host: 'nope',
				component: Comp,
			} )
		).toThrow( /host must be/ );
	} );

	it( 'throws when a required field is missing', () => {
		expect( () =>
			registerDevtoolsTab( { id: 'a', host: 'hub', component: Comp } )
		).toThrow();
	} );

	it( 'shares the registry across separately-loaded module instances', () => {
		// resetModules() simulates a second inlined copy; the store is global.
		registerDevtoolsTab( {
			id: 'cross',
			label: 'Cross',
			host: 'hub',
			component: Comp,
		} );
		jest.resetModules();
		const fresh = require( '../tabRegistry' );
		expect( fresh.getDevtoolsTabs( 'hub' ).map( ( t ) => t.id ) ).toEqual( [
			'cross',
		] );
	} );
} );
