/**
 * The Tables tab — its default layout's charts and its Table table over the
 * durable tablestats.p0 log. `useSource` hands back the source's model as
 * the test seeds it; a panel is what the time-chart block hands `TimeChart`
 * from the layout's attributes and the source's declared field.
 */

const mockModels = {};
jest.mock( '@newspack-nodes/shared/sources', () => ( {
	...jest.requireActual( '@newspack-nodes/shared/sources' ),
	useSource: ( name ) => ( {
		model: mockModels[ name ] ?? null,
		error: null,
		loading: ! mockModels[ name ],
		stale: false,
	} ),
} ) );

import { render } from '@testing-library/react';
import { sourceDeclaration } from '@newspack-nodes/shared/sources';
import { axisDuration } from '@newspack-nodes/shared/utils/axis-ticks';
import { buildAlignedSeries } from '@newspack-nodes/shared/utils/buildAlignedSeries';
import { publishSkippedLines } from '@newspack-nodes/shared/test-utils/skippedLines';
import { bucketsFrom } from './bucketTestUtils';
import { Core } from '../../runtime/core';
import { TablesTab } from '../stationTabs';
import LAYOUTS from '../../../tests/fixtures/station-layouts.json';
import { localizeStationPages } from '../../station/__tests__/localizeStationPages';

/**
 * Every time chart a layout's tree holds, in order.
 *
 * @param {Array<Object>} tree The tree.
 * @return {Array<Object>} Each chart's attributes.
 */
const chartsOf = ( tree ) =>
	tree.flatMap( ( node ) =>
		'newspack-nodes/time-chart' === node.name
			? [ node.attributes ]
			: chartsOf( node.inner )
	);

/**
 * Each panel the default layout draws, as the time-chart block hands it to
 * `TimeChart`: the chart's title and stacking, and its one metric's axis,
 * formatters and series, derived from the models seeded now.
 *
 * @return {Array<Object>} The panels.
 */
const panels = () =>
	chartsOf( LAYOUTS[ 'newspack-nodes/station-tables' ] ).map(
		( { source, metrics: [ key ], stacked, title } ) => {
			const field = sourceDeclaration( source ).fields[ key ];
			return Object.fromEntries(
				Object.entries( {
					title,
					stacked,
					yLabel: field.axis ?? field.label,
					formatFor: field.formatFor,
					formatValue: field.format,
					series: field.value( mockModels[ source ] ?? {} ),
				} ).filter( ( [ , value ] ) => undefined !== value )
			);
		}
	);

/**
 * Seed the sources the page reads.
 *
 * @param {?Object} stats   The probe stats model.
 * @param {?Object} [probe] The topic probe model.
 */
function seed( stats, probe ) {
	for ( const name of Object.keys( mockModels ) ) {
		delete mockModels[ name ];
	}
	if ( stats ) {
		mockModels[ 'nodes/tablestats' ] = stats;
	}
	if ( probe ) {
		mockModels[ 'nodes/topicprobe' ] = probe;
	}
}

// Two sweeps of one Table, as the view's `_fold` yields them.
function samples( extra = {} ) {
	return [ 1500, 1515 ].map( ( ts ) => ( {
		ts,
		elapsed: 15,
		opsDelta: 30,
		misses: 7.5,
		ms: 37.5,
		maxMs: 4.5,
		fileBytes: 8192,
		fileDiskBytes: 12288,
		'op:GET': 22.5,
		'op:MSET': 7.5,
		worker: 'flame-builder-4417.p0',
		...extra,
	} ) );
}

function model() {
	const table = ( key, backend, errors, extra = {} ) => ( {
		key,
		backend,
		windowed: {
			ops: 240,
			hitPct: 87.5,
			meanMs: 1.25,
			maxMs: 9.75,
			errors,
			purged: 4210,
			walWritten: 3700,
			walFrames: 3712,
		},
		latest: {
			ts: 1515,
			fileBytes: 8192,
			fileDiskBytes: 12288,
			purgeBehind: 0,
			walStalled: 0,
			...extra,
		},
		buckets: bucketsFrom( samples() ),
	} );
	// The worst Table goes in LAST, so only the sort can put it first.
	return {
		tables: {
			'flame-stats:aggregate.p0': table(
				'flame-stats:aggregate.p0',
				'sqlite',
				0
			),
			'flame-stats:url.p0': table( 'flame-stats:url.p0', 'sqlite', 3, {
				purgeBehind: 1,
				walStalled: 4,
			} ),
		},
	};
}

// A Table whose record says no size, no WAL and no purge apply.
function volatile( m, key, backend ) {
	const base = m.tables[ 'flame-stats:aggregate.p0' ];
	return {
		...base,
		key,
		backend,
		latest: {
			...base.latest,
			fileBytes: null,
			fileDiskBytes: null,
			purgeBehind: null,
			walStalled: null,
		},
		buckets: bucketsFrom(
			samples( { fileBytes: null, fileDiskBytes: null } )
		),
	};
}

const cellsOf = ( container, key ) =>
	[
		...container.querySelector( `[data-table-key="${ key }"]` ).children,
	].map( ( c ) => c.textContent );

beforeEach( () => {
	Core.reset();
	seed( null );
	localizeStationPages();
} );

describe( 'the Tables tab', () => {
	it( 'replays the tablestats log from its start', () => {
		const decl = sourceDeclaration( 'nodes/tablestats' );
		expect( [ decl.mode, decl.subscribe( {} ) ] ).toEqual( [
			'history',
			'tablestats.p0',
		] );
	} );

	it( 'draws six panels, the operation chart one series per operation per worker and one point per bucket', () => {
		seed( model() );
		render( <TablesTab /> );
		expect( panels().map( ( p ) => p.yLabel ) ).toEqual( [
			'Ops',
			'Ops',
			'Misses',
			'Latency',
			'Size',
			'On Disk',
		] );
		const ops = panels()[ 1 ].series;
		expect( Object.keys( ops ).sort() ).toEqual( [
			'GET · flame-builder-4417.p0',
			'MSET · flame-builder-4417.p0',
		] );
		// Two Tables one worker swept in one bucket sum into one point.
		expect(
			ops[ 'GET · flame-builder-4417.p0' ].points.map( ( p ) => p.value )
		).toEqual( [ 3 ] );
	} );

	it( 'charts each worker’s operation rate apart, one point per bucket', () => {
		const m = model();
		m.tables[ 'flame-stats:aggregate.p0' ].buckets = bucketsFrom(
			samples( { worker: 'flame-builder-4417.p1' } )
		);
		seed( m );
		render( <TablesTab /> );
		const ops = panels()[ 1 ].series;
		expect( Object.keys( ops ) ).toEqual(
			expect.arrayContaining( [
				'GET · flame-builder-4417.p0',
				'GET · flame-builder-4417.p1',
			] )
		);
		expect(
			ops[ 'GET · flame-builder-4417.p1' ].points.map( ( p ) => p.value )
		).toEqual( [ 1.5 ] );
	} );

	it( 'reads an operation idle in a sweep as 0 over that probe bucket’s elapsed', () => {
		const m = model();
		const sweep = ( ts, ops ) => ( {
			ts,
			elapsed: 15,
			worker: 'flame-builder-4417.p0',
			...ops,
		} );
		// GET is called 30 times in one of six sweeps; MSET in every one.
		m.tables = {
			'flame-stats:url.p0': {
				...m.tables[ 'flame-stats:url.p0' ],
				buckets: bucketsFrom(
					[ 1800, 1815, 1830, 1845, 1860, 1875 ].map( ( ts ) =>
						sweep(
							ts,
							1830 === ts
								? { 'op:GET': 30, 'op:MSET': 3.75 }
								: { 'op:MSET': 3.75 }
						)
					)
				),
			},
			// The six sweeps share one probe bucket; a later sweep widens the axis.
			'flame-stats:aggregate.p0': {
				...m.tables[ 'flame-stats:aggregate.p0' ],
				buckets: bucketsFrom( [ sweep( 3600, { 'op:MSET': 3.75 } ) ] ),
			},
		};
		seed( m );
		render( <TablesTab /> );
		const ops = panels()[ 1 ].series;
		const get = buildAlignedSeries( ops, 4 ).series.find(
			( x ) => 'GET · flame-builder-4417.p0' === x.label
		).values;
		expect( get[ 0 ].value ).toBeCloseTo( 30 / 90, 10 );
	} );

	it( 'stacks every panel but latency, whose means never sum', () => {
		seed( model() );
		render( <TablesTab /> );
		expect( panels().map( ( p ) => Boolean( p.stacked ) ) ).toEqual( [
			true,
			true,
			true,
			false,
			true,
			true,
		] );
		for ( const p of panels() ) {
			expect( p ).not.toHaveProperty( 'metric' );
			expect( p ).not.toHaveProperty( 'totalLabel' );
		}
		expect( panels()[ 3 ] ).not.toHaveProperty( 'stackable' );
		expect( Object.keys( panels()[ 0 ].series ) ).toEqual(
			expect.arrayContaining( [
				'flame-stats:url.p0',
				'flame-stats:aggregate.p0',
			] )
		);
	} );

	it( 'charts mean and max latency per Table, the max a MAX series', () => {
		seed( model() );
		render( <TablesTab /> );
		const latency = panels()[ 3 ].series;
		expect( latency[ 'flame-stats:url.p0' ].mode ).toEqual( {
			fill: 'zero',
			agg: 'mean',
		} );
		expect( latency[ 'flame-stats:url.p0 max' ].mode ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
		// A duration axis picks one unit from the panel's peak.
		expect( panels()[ 3 ].formatFor ).toBe( axisDuration );
		expect( panels()[ 3 ] ).not.toHaveProperty( 'formatValue' );
	} );

	it( 'tabulates each Table worst first, with the agreed columns', () => {
		seed( model() );
		const { container } = render( <TablesTab /> );
		const heads = [ ...container.querySelectorAll( 'th' ) ].map(
			( h ) => h.textContent
		);
		expect( heads ).toEqual( [
			'Table',
			'Backend',
			'Ops',
			'Hit %',
			'Avg',
			'Max',
			'Size',
			'Errors',
			'Purged',
			'Purge behind',
			'WAL',
		] );
		const first = container.querySelector( 'tbody tr' );
		expect( first.dataset.tableKey ).toBe( 'flame-stats:url.p0' );
		expect( first.textContent ).toContain( 'behind' );
		expect( first.textContent ).toContain( '3,700 / 3,712 · stalled 4' );
	} );

	it( 'marks the upkeep a volatile Table’s record says it has none of', () => {
		const m = model();
		m.tables[ 'memo:x.p0' ] = volatile( m, 'memo:x.p0', 'memcache' );
		seed( m );
		const { container } = render( <TablesTab /> );
		const cells = cellsOf( container, 'memo:x.p0' );
		// Size (6), Purged (8), Purge behind (9) and WAL (10) all read '-'.
		expect( [ cells[ 6 ], ...cells.slice( 8 ) ] ).toEqual( [
			'-',
			'-',
			'-',
			'-',
		] );
		const durable = cellsOf( container, 'flame-stats:aggregate.p0' );
		expect( durable[ 8 ] ).toBe( '4,210' );
		// A durable Table that is caught up says so; '-' is "does not apply".
		expect( durable[ 9 ] ).toBe( 'no' );
	} );

	it( 'reads what applies off the record, not off the backend name', () => {
		const m = model();
		m.tables[ 'kea:auto.p3' ] = {
			...m.tables[ 'flame-stats:aggregate.p0' ],
			key: 'kea:auto.p3',
			backend: 'auto',
		};
		seed( m );
		const { container } = render( <TablesTab /> );
		const cells = cellsOf( container, 'kea:auto.p3' );
		expect( cells[ 6 ] ).toBe( '8 KB (12 KB on disk)' );
		expect( cells.slice( 8 ) ).toEqual( [
			'4,210',
			'no',
			'3,700 / 3,712',
		] );
	} );

	it( 'reads a mean or max with no calls behind it as -', () => {
		const m = model();
		Object.assign( m.tables[ 'flame-stats:aggregate.p0' ].windowed, {
			ops: 0,
			meanMs: null,
			maxMs: null,
		} );
		seed( m );
		const { container } = render( <TablesTab /> );
		const cells = [
			...container.querySelector(
				'[data-table-key="flame-stats:aggregate.p0"]'
			).children,
		].map( ( c ) => c.textContent );
		expect( cells.slice( 4, 6 ) ).toEqual( [ '-', '-' ] );
	} );

	it( 'sizes only a Table that reports a size, one point per bucket, and charts no flat zero for the rest', () => {
		const m = model();
		m.tables[ 'sess:w.p0' ] = volatile( m, 'sess:w.p0', 'wpdb' );
		m.tables[ 'sess:w.p0' ].latest.purgeBehind = 0;
		seed( m );
		const { container } = render( <TablesTab /> );
		const cells = cellsOf( container, 'sess:w.p0' );
		expect( cells[ 6 ] ).toBe( '-' );
		expect( cells[ 9 ] ).toBe( 'no' );
		expect( cells[ 10 ] ).toBe( '-' );
		for ( const panel of panels().slice( 4 ) ) {
			expect( Object.keys( panel.series ) ).toEqual( [
				'flame-stats:aggregate.p0',
				'flame-stats:url.p0',
			] );
		}
		expect(
			panels()[ 5 ].series[ 'flame-stats:url.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 12288 ] );
	} );

	it( 'shows no level a departed Table last reported', () => {
		const m = model();
		// The newest record sits past the live window behind a fresh peer.
		m.tables[ 'flame-stats:url.p0' ].latest.ts = 1515 - 61;
		seed( m );
		const { container } = render( <TablesTab /> );
		const cells = [
			...container.querySelector(
				'[data-table-key="flame-stats:url.p0"]'
			).children,
		].map( ( c ) => c.textContent );
		// Size (6), Purge behind (9), and WAL (10) without its stall.
		expect( cells[ 6 ] ).toBe( '-' );
		expect( cells[ 9 ] ).toBe( '-' );
		expect( cells[ 10 ] ).toBe( '3,700 / 3,712' );
		const fresh = [
			...container.querySelector(
				'[data-table-key="flame-stats:aggregate.p0"]'
			).children,
		].map( ( c ) => c.textContent );
		expect( fresh[ 6 ] ).toBe( '8 KB (12 KB on disk)' );
	} );

	it( 'shows an empty state before any Table reports', () => {
		seed( { tables: {} } );
		const { container } = render( <TablesTab /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'shows the empty state while its log has answered nothing', () => {
		seed( null );
		const { container } = render( <TablesTab /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' ).textContent
		).toBe( 'No Table has reported yet.' );
	} );

	it( 'names its skipped lines', () => {
		publishSkippedLines( 'tablestats.p0', 4 );
		const { container } = render( <TablesTab /> );
		expect( container.textContent ).toContain(
			'Table statistics: 4 lines would not parse and were skipped.'
		);
	} );
} );
