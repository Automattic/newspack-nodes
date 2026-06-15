import {
	registerDevtoolsTab,
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '../tabRegistry';

describe( 'devtools tab registry', () => {
	beforeEach( resetDevtoolsTabs );

	const Comp = () => null;

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
		// Labels deliberately disagree with the desired order so the NaN
		// comparator path can't pass by accident: 'z' (non-finite order) must
		// coerce to 0 and sort before 'a' (order 1) despite 'Zzz' > 'Aaa'.
		// Without the fix, 'high' - 1 = NaN falls through to localeCompare and
		// 'a' wins.
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
		// The build emits each bundle as its own IIFE inlining its own copy of
		// this module. resetModules() simulates that second copy: a tab
		// registered through one module instance must be visible to a freshly
		// required instance — i.e. the store lives on the global, not module
		// scope. A module-local Map would lose the tab here.
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
