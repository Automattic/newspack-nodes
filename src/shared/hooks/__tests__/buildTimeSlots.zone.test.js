/*
 * @jest-environment ./src/shared/test-utils/zoneEnvironment.js
 * @timezone America/New_York
 */

import { BUCKET_MS, buildTimeSlots } from '../useTimeChart';

describe( 'buildTimeSlots across the end of daylight saving', () => {
	afterEach( () => {
		jest.useRealTimers();
	} );

	it( 'keeps slots ascending and distinct through the repeated hour', () => {
		// 06:30Z is 1:30 EST, half an hour after New York's clocks fell back.
		jest.useFakeTimers( { now: Date.parse( '2026-11-01T06:30:00Z' ) } );
		expect( new Date().getTimezoneOffset() ).toBe( 300 );

		const slots = buildTimeSlots( 3 * 3600 );
		const times = slots.map( ( slot ) => slot.date.getTime() );
		times.slice( 1 ).forEach( ( time, i ) => {
			expect( time - times[ i ] ).toBe( BUCKET_MS );
		} );
		const keys = slots.map( ( slot ) => slot.bucketKey );
		expect( new Set( keys ).size ).toBe( keys.length );
		expect( keys[ 0 ] ).toBe( '2026-11-01-03-35' );
		expect( keys[ keys.length - 1 ] ).toBe( '2026-11-01-06-30' );
	} );
} );
