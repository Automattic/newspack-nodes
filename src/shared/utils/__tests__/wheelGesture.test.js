/* eslint-env jest */
/**
 * A wheel stream is a swipe (pan) or a notch run (zoom), decided by its first
 * event, and the zoom a notch or a key asks for is one multiplicative step.
 */

import {
	KEY_ZOOM,
	ZOOM_STEP,
	createWheelStream,
	wheelNotches,
} from '../wheelGesture';

const wheel = ( init, timeStamp = 1000 ) => {
	const e = new window.WheelEvent( 'wheel', init );
	Object.defineProperty( e, 'timeStamp', { value: timeStamp } );
	if ( undefined !== init.wheelDeltaY ) {
		Object.defineProperty( e, 'wheelDeltaY', { value: init.wheelDeltaY } );
	}
	return e;
};

describe( 'createWheelStream', () => {
	it( 'pans a swipe with sideways travel', () => {
		const verdict = createWheelStream();
		expect( verdict( wheel( { deltaX: 7, deltaY: 13 } ) ) ).toBe( 'pan' );
	} );

	it( 'pans a delta that is exactly -3 times wheelDeltaY', () => {
		const verdict = createWheelStream();
		expect( verdict( wheel( { deltaY: 37, wheelDeltaY: -111 } ) ) ).toBe(
			'pan'
		);
	} );

	it( 'zooms a wheel notch of whole 120 units', () => {
		const verdict = createWheelStream();
		expect( verdict( wheel( { deltaY: 100, wheelDeltaY: -120 } ) ) ).toBe(
			'zoom'
		);
	} );

	it( 'zooms under ctrl and under meta whatever the event looks like', () => {
		expect(
			createWheelStream()(
				wheel( { deltaX: 9, deltaY: 4, ctrlKey: true } )
			)
		).toBe( 'zoom' );
		expect(
			createWheelStream()(
				wheel( { deltaX: 9, deltaY: 4, metaKey: true } )
			)
		).toBe( 'zoom' );
	} );

	it( 'zooms a line-mode delta', () => {
		const verdict = createWheelStream();
		expect(
			verdict( wheel( { deltaMode: 1, deltaX: 5, deltaY: 2 } ) )
		).toBe( 'zoom' );
	} );

	it( 'keeps the first verdict while events arrive inside the gap', () => {
		const verdict = createWheelStream();
		verdict( wheel( { deltaX: 3, deltaY: 8 }, 5000 ) );
		expect( verdict( wheel( { deltaY: 2 }, 5149 ) ) ).toBe( 'pan' );
		expect( verdict( wheel( { deltaY: 2 }, 5298 ) ) ).toBe( 'pan' );
	} );

	it( 'keeps the verdict at a gap of exactly 150 ms', () => {
		const verdict = createWheelStream();
		verdict( wheel( { deltaX: 3, deltaY: 8 }, 5000 ) );
		expect( verdict( wheel( { deltaY: 100 }, 5150 ) ) ).toBe( 'pan' );
	} );

	it( 'decides afresh after a pause longer than the gap', () => {
		const verdict = createWheelStream();
		verdict( wheel( { deltaX: 3, deltaY: 8 }, 5000 ) );
		expect( verdict( wheel( { deltaY: 100 }, 5151 ) ) ).toBe( 'zoom' );
	} );

	it( 'decides afresh when the zoom modifier changes', () => {
		const verdict = createWheelStream();
		verdict( wheel( { deltaX: 3, deltaY: 8 }, 5000 ) );
		expect(
			verdict( wheel( { deltaX: 3, deltaY: 8, ctrlKey: true }, 5010 ) )
		).toBe( 'zoom' );
	} );

	it( 'holds no state between two streams', () => {
		createWheelStream()( wheel( { deltaX: 3, deltaY: 8 }, 5000 ) );
		expect( createWheelStream()( wheel( { deltaY: 100 }, 5010 ) ) ).toBe(
			'zoom'
		);
	} );
} );

describe( 'wheelNotches', () => {
	it( 'counts pixels in hundreds, capped at one either way', () => {
		expect( wheelNotches( wheel( { deltaY: 40 } ) ) ).toBeCloseTo( 0.4 );
		expect( wheelNotches( wheel( { deltaY: -250 } ) ) ).toBe( -1 );
	} );

	it( 'counts lines in threes', () => {
		expect(
			wheelNotches( wheel( { deltaMode: 1, deltaY: 1 } ) )
		).toBeCloseTo( 1 / 3 );
	} );

	it( 'counts a page as one notch with its sign', () => {
		expect( wheelNotches( wheel( { deltaMode: 2, deltaY: -9 } ) ) ).toBe(
			-1
		);
	} );

	it( 'gains a pinch tenfold', () => {
		expect(
			wheelNotches( wheel( { ctrlKey: true, deltaY: 4 } ) )
		).toBeCloseTo( 0.4 );
	} );
} );

describe( 'KEY_ZOOM', () => {
	it( 'zooms in on = and +, out on - and _, by the wheel step', () => {
		expect( ZOOM_STEP ).toBe( 1.12 );
		expect( KEY_ZOOM[ '=' ] ).toBe( 1 / ZOOM_STEP );
		expect( KEY_ZOOM[ '+' ] ).toBe( 1 / ZOOM_STEP );
		expect( KEY_ZOOM[ '-' ] ).toBe( ZOOM_STEP );
		expect( KEY_ZOOM._ ).toBe( ZOOM_STEP );
	} );
} );
