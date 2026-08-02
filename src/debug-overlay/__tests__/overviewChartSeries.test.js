import { overviewChartSeries } from '../overviewChartSeries';

// Ring rows are [ t, msgInRate, msgOutRate, byteInRate, byteOutRate ].
const RING = [
	[ 100, 1, 2, 10, 20 ],
	[ 105, 3, 4, 30, 40 ],
];

describe( 'overviewChartSeries', () => {
	test( 'splits the ring into In/Out message-rate and byte-rate panels', () => {
		const { msgRate, byteRate } = overviewChartSeries( RING );
		expect( msgRate.In.points ).toEqual( [
			{ ts: 100, value: 1 },
			{ ts: 105, value: 3 },
		] );
		expect( msgRate.Out.points ).toEqual( [
			{ ts: 100, value: 2 },
			{ ts: 105, value: 4 },
		] );
		expect( byteRate.In.points ).toEqual( [
			{ ts: 100, value: 10 },
			{ ts: 105, value: 30 },
		] );
		expect( byteRate.Out.points ).toEqual( [
			{ ts: 100, value: 20 },
			{ ts: 105, value: 40 },
		] );
	} );

	test( 'each series carries the max + avg the chart legend ranks on', () => {
		const { msgRate } = overviewChartSeries( RING );
		expect( msgRate.In.max ).toBe( 3 );
		expect( msgRate.In.avg ).toBeCloseTo( 2 );
		expect( msgRate.Out.max ).toBe( 4 );
	} );

	test( 'an empty ring yields empty point arrays', () => {
		const { msgRate, byteRate } = overviewChartSeries( [] );
		expect( msgRate.In.points ).toEqual( [] );
		expect( byteRate.Out.points ).toEqual( [] );
		expect( msgRate.In.max ).toBe( 0 );
	} );
} );
