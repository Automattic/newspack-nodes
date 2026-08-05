/**
 * ProcessStats — the Inspector's sparkline rows.
 *
 * The geometry used to be computed against a module constant (60) rather than
 * against the data, which one of the two callers violates by 12x: the browser
 * scope feeds `IoTelemetry.getSeries()`, whose ring holds 720 samples.
 */

import { render } from '@testing-library/react';
import { SparklineRow } from '../ProcessStats';

const fmt = ( v ) => String( v );

// The x of every `M`/`L` command in a path string.
function xs( d ) {
	return [ ...d.matchAll( /[ML] (-?[\d.]+),/g ) ].map( ( m ) =>
		Number( m[ 1 ] )
	);
}

describe( 'SparklineRow geometry', () => {
	it( 'draws a 720-sample ring entirely inside the viewBox', () => {
		// The browser-scope ring is RING_SECONDS / SAMPLE_INTERVAL = 720.
		const history = Array.from( { length: 720 }, ( _, i ) => i % 7 );
		const { container } = render(
			<SparklineRow
				label="messages in /s"
				history={ history }
				currentValue={ 3 }
				format={ fmt }
			/>
		);
		const d = container.querySelector( 'path' ).getAttribute( 'd' );
		const points = xs( d );

		expect( points ).toHaveLength( 720 );
		// A constant-60 step put the first 660 points at negative x, clipped.
		expect( Math.min( ...points ) ).toBe( 0 );
		expect( Math.max( ...points ) ).toBeCloseTo( 270, 1 );
	} );

	it( 'spreads a short history across the same width', () => {
		const { container } = render(
			<SparklineRow
				label="messages out /s"
				history={ [ 1, 2, 3 ] }
				currentValue={ 3 }
				format={ fmt }
			/>
		);
		const points = xs(
			container.querySelector( 'path' ).getAttribute( 'd' )
		);
		expect( points ).toEqual( [ 0, 135, 270 ] );
	} );

	it( 'draws no curve for fewer than two samples', () => {
		const { container } = render(
			<SparklineRow
				label="idle"
				history={ [ 5 ] }
				currentValue={ 5 }
				format={ fmt }
			/>
		);
		expect( container.querySelector( 'path' ) ).toBeNull();
	} );
} );
