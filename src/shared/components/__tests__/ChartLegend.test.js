/**
 * ChartLegend — the scrolling, pickable legend beside every dashboard chart.
 */

import { render, fireEvent } from '@testing-library/react';
import ChartLegend from '../ChartLegend';

const ITEMS = [
	{ label: 'firehose.p0', color: '#4e79a7' },
	{
		label: 'a-very-long-partition-name-that-used-to-be-cut',
		color: '#f28e2b',
	},
	{ label: 'jobs.p0', color: '#e15759' },
];

const mount = ( props = {} ) =>
	render(
		<ChartLegend
			items={ ITEMS }
			selected={ new Set() }
			onSelect={ () => {} }
			height={ 217 }
			{ ...props }
		/>
	);

it( 'lists every series in order, with its swatch and its whole label', () => {
	const { container } = mount();
	const rows = [ ...container.querySelectorAll( 'li' ) ];
	expect( rows.map( ( r ) => r.textContent ) ).toEqual(
		ITEMS.map( ( i ) => i.label )
	);
	const swatches = [ ...container.querySelectorAll( 'li span[style]' ) ];
	expect( swatches.map( ( s ) => s.style.background ) ).toEqual(
		ITEMS.map( ( i ) => i.color ).map( ( c ) => {
			const s = document.createElement( 'span' );
			s.style.background = c;
			return s.style.background;
		} )
	);
	// The full name rides the title too, for a label the column clips.
	expect( rows[ 1 ].querySelector( 'button' ).title ).toBe(
		ITEMS[ 1 ].label
	);
} );

it( 'scrolls inside the chart height instead of growing past it', () => {
	const { container } = mount();
	const list = container.querySelector( 'ul' );
	expect( list.style.maxHeight ).toBe( '217px' );
	expect( list.className ).toContain( 'newspack-nodes-chart-legend' );
} );

it( 'a click picks the series; a ctrl- or cmd-click picks additively', () => {
	const onSelect = jest.fn();
	const { container } = mount( { onSelect } );
	const [ first, second, third ] = container.querySelectorAll( 'button' );
	fireEvent.click( first );
	fireEvent.click( second, { ctrlKey: true } );
	fireEvent.click( third, { metaKey: true } );
	expect( onSelect.mock.calls ).toEqual( [
		[ 'firehose.p0', false ],
		[ ITEMS[ 1 ].label, true ],
		[ 'jobs.p0', true ],
	] );
} );

it( 'marks the picked series pressed and dims the rest', () => {
	const { container } = mount( { selected: new Set( [ 'jobs.p0' ] ) } );
	const buttons = [ ...container.querySelectorAll( 'button' ) ];
	expect( buttons.map( ( b ) => b.getAttribute( 'aria-pressed' ) ) ).toEqual(
		[ 'false', 'false', 'true' ]
	);
	expect(
		buttons.map( ( b ) => b.classList.contains( 'is-dimmed' ) )
	).toEqual( [ true, true, false ] );
} );

it( 'dims nothing while nothing is picked: every series is shown', () => {
	const { container } = mount();
	const buttons = [ ...container.querySelectorAll( 'button' ) ];
	expect( buttons.some( ( b ) => b.classList.contains( 'is-dimmed' ) ) ).toBe(
		false
	);
} );
