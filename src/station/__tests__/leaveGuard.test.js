import { beforeStationLeave, guardLeave } from '../leaveGuard';

describe( 'leaveGuard', () => {
	let other;

	beforeAll( () => {
		jest.isolateModules( () => {
			other = require( '../leaveGuard' );
		} );
	} );

	it( "answers a station tab's leave in every bundle's copy", () => {
		const asked = [];
		const release = guardLeave( ( next ) => {
			asked.push( next.slug );
			return false;
		} );
		expect( other.beforeStationLeave( { slug: 'jobs' } ) ).toBe( false );
		expect( asked ).toEqual( [ 'jobs' ] );
		release();
		expect( other.beforeStationLeave( { slug: 'jobs' } ) ).toBe( true );
	} );

	it( 'keeps a later answer when an earlier one is released', () => {
		const first = guardLeave( () => false );
		const second = other.guardLeave( () => 'later' );
		first();
		expect( beforeStationLeave( { slug: 'tables' } ) ).toBe( 'later' );
		second();
		expect( beforeStationLeave( { slug: 'tables' } ) ).toBe( true );
	} );
} );
