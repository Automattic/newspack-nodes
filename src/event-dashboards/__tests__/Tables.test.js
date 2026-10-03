/**
 * Tables — the station's per-Table operation board over the durable
 * tablestats.p0 log. useProbeStream (link) is stubbed; the view model is fed
 * via useNodeField. TopicsChart (d3) is stubbed to capture each panel's props.
 */

import { render } from '@testing-library/react';
import Tables from '../Tables';
import { useProbeStream } from '../hooks/useProbeStream';
import { Core } from '../../runtime/core';
import { publishSkippedLines } from '@newspack-nodes/shared/test-utils/skippedLines';

jest.mock( '../hooks/useProbeStream', () => ( {
	useProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeField: jest.fn(),
} ) );
jest.mock( '../TopicsChart', () => {
	const el = require( '@wordpress/element' );
	const TopicsChart = ( props ) => {
		( globalThis.__tablesPanels ||= [] ).push( props );
		return el.createElement(
			'div',
			{ className: 'nodes-topics' },
			props.title
		);
	};
	return {
		...jest.requireActual( '../TopicsChart' ),
		TopicsChart,
		TopicsPanels: ( { panels } ) =>
			panels.map( ( p ) =>
				el.createElement( TopicsChart, { key: p.title, ...p } )
			),
	};
} );

import { useNodeField } from '../../runtime/react';

function model() {
	const sample = ( ts, extra ) => ( {
		ts,
		elapsed: 15,
		opsDelta: 30,
		opsRate: 2,
		missRate: 0.5,
		meanMs: 1.25,
		maxMs: 4.5,
		fileBytes: 8192,
		opRates: { GET: 1.5, MSET: 0.5 },
		worker: 'flame-builder-4417.p0',
		...extra,
	} );
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
			purgeBehind: 0,
			walStalled: 0,
			...extra,
		},
		series: [ sample( 1500 ), sample( 1515 ) ],
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
			purgeBehind: null,
			walStalled: null,
		},
		series: base.series.map( ( s ) => ( { ...s, fileBytes: null } ) ),
	};
}

const cellsOf = ( container, key ) =>
	[
		...container.querySelector( `[data-table-key="${ key }"]` ).children,
	].map( ( c ) => c.textContent );

beforeEach( () => {
	Core.reset();
	globalThis.__tablesPanels = [];
	useProbeStream.mockClear();
} );

describe( 'Tables', () => {
	it( 'replays the tablestats log from its start', () => {
		render( <Tables /> );
		expect( useProbeStream ).toHaveBeenCalledWith( 'tablestats', {
			mode: 'history',
		} );
	} );

	it( 'draws five panels, the operation chart one series per operation per worker', () => {
		useNodeField.mockReturnValue( model() );
		render( <Tables /> );
		expect( globalThis.__tablesPanels.map( ( p ) => p.yLabel ) ).toEqual( [
			'Ops',
			'Ops',
			'Misses',
			'Latency',
			'Size',
		] );
		const ops = globalThis.__tablesPanels[ 1 ].series;
		expect( Object.keys( ops ).sort() ).toEqual( [
			'GET · flame-builder-4417.p0',
			'MSET · flame-builder-4417.p0',
		] );
		// Two Tables one worker swept at one instant sum into one point.
		expect(
			ops[ 'GET · flame-builder-4417.p0' ].points.map( ( p ) => p.value )
		).toEqual( [ 3, 3 ] );
	} );

	it( 'charts each worker’s operation rate apart', () => {
		const m = model();
		m.tables[ 'flame-stats:aggregate.p0' ].series = m.tables[
			'flame-stats:aggregate.p0'
		].series.map( ( s ) => ( { ...s, worker: 'flame-builder-4417.p1' } ) );
		useNodeField.mockReturnValue( m );
		render( <Tables /> );
		const ops = globalThis.__tablesPanels[ 1 ].series;
		expect( Object.keys( ops ) ).toEqual(
			expect.arrayContaining( [
				'GET · flame-builder-4417.p0',
				'GET · flame-builder-4417.p1',
			] )
		);
		expect(
			ops[ 'GET · flame-builder-4417.p1' ].points.map( ( p ) => p.value )
		).toEqual( [ 1.5, 1.5 ] );
	} );

	it( 'stacks every panel but latency, whose means never sum', () => {
		useNodeField.mockReturnValue( model() );
		render( <Tables /> );
		expect(
			globalThis.__tablesPanels.map( ( p ) => Boolean( p.stacked ) )
		).toEqual( [ true, true, true, false, true ] );
		for ( const p of globalThis.__tablesPanels ) {
			expect( p ).not.toHaveProperty( 'metric' );
			expect( p ).not.toHaveProperty( 'totalLabel' );
		}
		expect( globalThis.__tablesPanels[ 3 ].stackable ).toBe( false );
		expect( Object.keys( globalThis.__tablesPanels[ 0 ].series ) ).toEqual(
			expect.arrayContaining( [
				'flame-stats:url.p0',
				'flame-stats:aggregate.p0',
			] )
		);
	} );

	it( 'charts mean and max latency per Table, the max a MAX series', () => {
		useNodeField.mockReturnValue( model() );
		render( <Tables /> );
		const latency = globalThis.__tablesPanels[ 3 ].series;
		expect( latency[ 'flame-stats:url.p0' ].mode ).toEqual( {
			fill: 'zero',
			agg: 'rate',
		} );
		expect( latency[ 'flame-stats:url.p0 max' ].mode ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
	} );

	it( 'tabulates each Table worst first, with the agreed columns', () => {
		useNodeField.mockReturnValue( model() );
		const { container } = render( <Tables /> );
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
		useNodeField.mockReturnValue( m );
		const { container } = render( <Tables /> );
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
		useNodeField.mockReturnValue( m );
		const { container } = render( <Tables /> );
		const cells = cellsOf( container, 'kea:auto.p3' );
		expect( cells[ 6 ] ).toBe( '8 KB' );
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
		useNodeField.mockReturnValue( m );
		const { container } = render( <Tables /> );
		const cells = [
			...container.querySelector(
				'[data-table-key="flame-stats:aggregate.p0"]'
			).children,
		].map( ( c ) => c.textContent );
		expect( cells.slice( 4, 6 ) ).toEqual( [ '-', '-' ] );
	} );

	it( 'sizes only a Table that reports a size, and charts no flat zero for the rest', () => {
		const m = model();
		m.tables[ 'sess:w.p0' ] = volatile( m, 'sess:w.p0', 'wpdb' );
		m.tables[ 'sess:w.p0' ].latest.purgeBehind = 0;
		useNodeField.mockReturnValue( m );
		const { container } = render( <Tables /> );
		const cells = cellsOf( container, 'sess:w.p0' );
		expect( cells[ 6 ] ).toBe( '-' );
		expect( cells[ 9 ] ).toBe( 'no' );
		expect( cells[ 10 ] ).toBe( '-' );
		expect( Object.keys( globalThis.__tablesPanels[ 4 ].series ) ).toEqual(
			[ 'flame-stats:aggregate.p0', 'flame-stats:url.p0' ]
		);
	} );

	it( 'shows no level a departed Table last reported', () => {
		const m = model();
		// The newest record sits past the live window behind a fresh peer.
		m.tables[ 'flame-stats:url.p0' ].latest.ts = 1515 - 61;
		useNodeField.mockReturnValue( m );
		const { container } = render( <Tables /> );
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
		expect( fresh[ 6 ] ).toBe( '8 KB' );
	} );

	it( 'keeps its panel series stable across renders of an unready model', () => {
		useNodeField.mockReturnValue( undefined );
		const { rerender } = render( <Tables /> );
		const first = globalThis.__tablesPanels[ 0 ].series;
		rerender( <Tables /> );
		expect( globalThis.__tablesPanels.at( -5 ).series ).toBe( first );
	} );

	it( 'shows an empty state before any Table reports', () => {
		useNodeField.mockReturnValue( { tables: {} } );
		const { container } = render( <Tables /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'tolerates an unready model', () => {
		useNodeField.mockReturnValue( undefined );
		const { container } = render( <Tables /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'names its skipped lines', () => {
		publishSkippedLines( 'tablestats:link', 4 );
		useNodeField.mockReturnValue( undefined );
		const { container } = render( <Tables /> );
		expect( container.textContent ).toContain(
			'Table statistics: 4 lines would not parse and were skipped.'
		);
	} );
} );
