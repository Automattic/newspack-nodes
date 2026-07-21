/**
 * TimelineView tests — a parsed, filterable view over the transcript's
 * `DEBUG: <event> <payload>` trace lines (produced when a node's debug_state
 * is on). Non-DEBUG entries are excluded; two substring filters narrow rows.
 */

import { render, fireEvent } from '@testing-library/react';
import TimelineView from '../TimelineView';

// A DEBUG line as it lands in the transcript: log-prefixed + `<node>: ` midfix.
const PREFIX = '2026-07-20 12:00:00 UTC browser: ';

const transcript = [
	{
		key: 'a',
		ts: 1_777_000_000,
		kind: 'recv',
		text: `${ PREFIX }request-builder: DEBUG: rotate seg=42`,
	},
	{
		key: 'b',
		ts: 1_777_000_001,
		kind: 'recv',
		text: 'firehose-in: DEBUG: flush',
	},
	{
		key: 'c',
		ts: 1_777_000_002,
		kind: 'recv',
		text: 'just some ordinary command output',
	},
	{
		key: 'd',
		ts: 1_777_000_003,
		kind: 'info',
		text: `${ PREFIX }combined.p0: DEBUG: crawl checkpoint=3`,
	},
];

const rowsOf = ( container ) =>
	Array.from( container.querySelectorAll( '.timeline-view__row' ) );

describe( 'TimelineView', () => {
	it( 'parses DEBUG traces into node/event/payload rows and drops non-DEBUG lines', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const rows = rowsOf( container );
		// Only the three DEBUG lines; the ordinary output line is excluded.
		expect( rows ).toHaveLength( 3 );
		const first = rows[ 0 ];
		expect(
			first.querySelector( '.timeline-view__node' ).textContent
		).toBe( 'request-builder' );
		expect(
			first.querySelector( '.timeline-view__event' ).textContent
		).toBe( 'rotate' );
		expect(
			first.querySelector( '.timeline-view__payload' ).textContent
		).toBe( 'seg=42' );
	} );

	it( 'parses a payload-less DEBUG line (no prefix) with an empty payload', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const flush = rowsOf( container ).find(
			( r ) =>
				r.querySelector( '.timeline-view__event' ).textContent ===
				'flush'
		);
		expect( flush ).toBeTruthy();
		expect(
			flush.querySelector( '.timeline-view__node' ).textContent
		).toBe( 'firehose-in' );
		expect(
			flush.querySelector( '.timeline-view__payload' ).textContent
		).toBe( '' );
	} );

	it( 'renders the entry ts as a UTC HH:MM:SS time cell', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const expected = new Date( 1_777_000_000 * 1000 )
			.toISOString()
			.slice( 11, 19 );
		expect(
			rowsOf( container )[ 0 ].querySelector( '.timeline-view__time' )
				.textContent
		).toBe( expected );
	} );

	it( 'preserves transcript order (newest-last)', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const events = rowsOf( container ).map(
			( r ) => r.querySelector( '.timeline-view__event' ).textContent
		);
		expect( events ).toEqual( [ 'rotate', 'flush', 'crawl' ] );
	} );

	it( 'narrows rows by a case-insensitive node substring filter', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const nodeFilter = container.querySelectorAll(
			'.timeline-view__filter'
		)[ 0 ];
		fireEvent.change( nodeFilter, { target: { value: 'FIREHOSE' } } );
		const rows = rowsOf( container );
		expect( rows ).toHaveLength( 1 );
		expect(
			rows[ 0 ].querySelector( '.timeline-view__node' ).textContent
		).toBe( 'firehose-in' );
	} );

	it( 'narrows rows by a case-insensitive event substring filter', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const eventFilter = container.querySelectorAll(
			'.timeline-view__filter'
		)[ 1 ];
		fireEvent.change( eventFilter, { target: { value: 'craw' } } );
		const rows = rowsOf( container );
		expect( rows ).toHaveLength( 1 );
		expect(
			rows[ 0 ].querySelector( '.timeline-view__event' ).textContent
		).toBe( 'crawl' );
	} );

	it( 'ignores free text containing DEBUG: without a node midfix', () => {
		const { container } = render(
			<TimelineView
				transcript={ [
					{
						key: 'x',
						ts: 1_777_000_009,
						kind: 'sent',
						text: 'echoed the word DEBUG: not_a_trace',
					},
				] }
			/>
		);
		expect( rowsOf( container ) ).toHaveLength( 0 );
	} );

	it( 'shows the toggle-Trace empty state when there are no DEBUG traces', () => {
		const { container } = render(
			<TimelineView
				transcript={ [
					{
						key: 'x',
						ts: 1_777_000_000,
						kind: 'recv',
						text: 'nothing here',
					},
				] }
			/>
		);
		expect( rowsOf( container ) ).toHaveLength( 0 );
		expect(
			container.querySelector( '.timeline-view__empty' ).textContent
		).toMatch( /Trace/ );
	} );
} );
