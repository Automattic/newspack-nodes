import { resolveChartPalette } from '../resolveChartPalette';
import { PALETTE } from '@newspack-nodes/shared/hooks/useTimeChart';

test( 'returns the eight --chart-* values in order when all present', () => {
	const vars = {
		'--chart-1': '#111',
		'--chart-2': '#222',
		'--chart-3': '#333',
		'--chart-4': '#444',
		'--chart-5': '#555',
		'--chart-6': '#666',
		'--chart-7': '#777',
		'--chart-8': '#888',
	};
	const got = resolveChartPalette( ( n ) => vars[ n ] ?? '' );
	expect( got ).toEqual( [
		'#111',
		'#222',
		'#333',
		'#444',
		'#555',
		'#666',
		'#777',
		'#888',
	] );
} );

test( 'falls back to the shared PALETTE when the chart vars are absent', () => {
	expect( resolveChartPalette( () => '' ) ).toEqual( PALETTE );
} );

test( 'falls back to PALETTE if any single var is missing (partial)', () => {
	const vars = {
		'--chart-1': '#111',
		'--chart-2': '',
		'--chart-3': '#333',
		'--chart-4': '#444',
		'--chart-5': '#555',
		'--chart-6': '#666',
		'--chart-7': '#777',
		'--chart-8': '#888',
	};
	expect( resolveChartPalette( ( n ) => vars[ n ] ?? '' ) ).toEqual(
		PALETTE
	);
} );
