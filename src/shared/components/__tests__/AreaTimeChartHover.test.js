/**
 * AreaTimeChart — the hover's pending animation frame belongs to the draw that
 * scheduled it: a redraw or an unmount cancels it, so it never paints a
 * replaced draw's rows nor reaches a container React has let go.
 *
 * Real d3 and the real overlay against jsdom, with the frame queue held by the
 * test so it runs only when flushed.
 */

import { fireEvent, render } from '@testing-library/react';
import AreaTimeChart from '../AreaTimeChart';

const dates = [ 0, 1, 2 ].map(
	( i ) => new Date( 1700000000000 + i * 300000 )
);
const seriesOf = ( value ) => [
	{
		label: 'kea.p3',
		values: dates.map( ( date ) => ( { date, value } ) ),
	},
];
const chartProps = {
	yFormatFor: () => ( v ) => `${ v }u`,
	colorAt: () => '#5a6b7c',
	title: 'Kea',
	height: 167,
	storageKey: 'test:hover-chart',
};

let frames;
beforeEach( () => {
	frames = new Map();
	let next = 0;
	jest.spyOn( window, 'requestAnimationFrame' ).mockImplementation(
		( paint ) => {
			next += 1;
			frames.set( next, paint );
			return next;
		}
	);
	jest.spyOn( window, 'cancelAnimationFrame' ).mockImplementation( ( id ) =>
		frames.delete( id )
	);
} );
afterEach( () => {
	jest.restoreAllMocks();
} );

const flush = () => {
	const pending = [ ...frames.values() ];
	frames.clear();
	pending.forEach( ( paint ) => paint() );
};

const overlay = ( c ) =>
	c.querySelector( '.newspack-nodes-chart__plot rect[pointer-events="all"]' );
const tooltip = ( c ) => c.querySelector( '.newspack-nodes-chart__tooltip' );

describe( "AreaTimeChart hover's pending frame", () => {
	it( 'runs nothing after the chart unmounts', () => {
		const { container, unmount } = render(
			<AreaTimeChart series={ seriesOf( 41 ) } { ...chartProps } />
		);
		fireEvent.mouseMove( overlay( container ), { clientX: 354 } );
		unmount();
		expect( flush ).not.toThrow();
	} );

	it( "never paints a replaced draw's rows over the redraw's", () => {
		const { container, rerender } = render(
			<AreaTimeChart series={ seriesOf( 41 ) } { ...chartProps } />
		);
		fireEvent.mouseMove( overlay( container ), { clientX: 354 } );
		flush();
		expect( tooltip( container ).textContent ).toContain( 'kea.p3: 41u' );

		fireEvent.mouseMove( overlay( container ), { clientX: 360 } );
		rerender(
			<AreaTimeChart series={ seriesOf( 83 ) } { ...chartProps } />
		);
		flush();
		expect( tooltip( container ).textContent ).toContain( 'kea.p3: 83u' );
	} );
} );
