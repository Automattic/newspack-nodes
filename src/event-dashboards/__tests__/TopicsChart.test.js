import { render } from '@testing-library/react';
import { TopicsChart } from '../TopicsChart';

const fmt = ( v ) => `${ v }`;

describe( 'TopicsChart', () => {
	it( 'ranks the legend by max desc and renders a polyline per series', () => {
		const series = {
			'low.p0': {
				points: [
					{ ts: 100, value: 1 },
					{ ts: 115, value: 2 },
				],
				max: 2,
				avg: 1.5,
			},
			'high.p0': {
				points: [
					{ ts: 100, value: 90 },
					{ ts: 115, value: 100 },
				],
				max: 100,
				avg: 95,
			},
		};
		const { container } = render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		const rows = [
			...container.querySelectorAll( '.nodes-topics__legend tbody tr' ),
		].map(
			( tr ) => tr.querySelector( '.nodes-topics__series' ).textContent
		);
		expect( rows ).toEqual( [ 'high.p0', 'low.p0' ] ); // busiest first
		expect( container.querySelectorAll( 'polyline' ) ).toHaveLength( 2 );
	} );

	it( 'renders without a chart line when there is no data', () => {
		const { container } = render(
			<TopicsChart title="Rate" series={ {} } formatValue={ fmt } />
		);
		expect( container.querySelector( 'polyline' ) ).toBeNull();
		expect(
			container.querySelector( '.nodes-topics__title' ).textContent
		).toBe( 'Rate' );
	} );
} );
