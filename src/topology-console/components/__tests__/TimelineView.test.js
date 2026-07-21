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

	it( 'captures a full colon-bearing sidecar node name, not just the suffix', () => {
		// Substrate sidecar naming puts a colon INSIDE the node name
		// (`scored:consumer`, `jobs:offsetlog`, `combined.p0:crawler`); the
		// capture must take the whole space-free token before ` DEBUG: `.
		const { container } = render(
			<TimelineView
				transcript={ [
					{
						key: 's',
						ts: 1_777_000_050,
						kind: 'recv',
						text: `${ PREFIX }scored:consumer: DEBUG: enqueue id=99`,
					},
				] }
			/>
		);
		const rows = rowsOf( container );
		expect( rows ).toHaveLength( 1 );
		expect(
			rows[ 0 ].querySelector( '.timeline-view__node' ).textContent
		).toBe( 'scored:consumer' );
		expect(
			rows[ 0 ].querySelector( '.timeline-view__event' ).textContent
		).toBe( 'enqueue' );
	} );

	// A debug_level 2 transcript entry is the Dumper's multi-line envelope dump
	// (buildDebugHeader2), the DEBUG trace riding the `value:` line. The parse
	// must stay line-scoped: the payload capture never crosses into the `}` line.
	const VERBOSE_ENVELOPE = [
		'Message {',
		'    type:      TM_BYTESTREAM',
		'    from:      combined',
		'    to:        ',
		'    id:        ',
		'    key:       ',
		'    timestamp: 1777000000 (2026-07-21 08:01:12 UTC)',
		'    value:     2026-07-21 08:01:12 UTC 598fcf combined[5070]: _repl: DEBUG: SEGMENT 1',
		'}',
	].join( '\n' );

	it( 'line-scopes a verbose envelope dump: parses the DEBUG line only, not the trailing "}"', () => {
		const { container } = render(
			<TimelineView
				transcript={ [
					{
						key: 'v',
						ts: 1_777_000_060,
						kind: 'info',
						text: VERBOSE_ENVELOPE,
					},
				] }
			/>
		);
		const rows = rowsOf( container );
		expect( rows ).toHaveLength( 1 );
		// The node is the space-free token immediately before ` DEBUG:`.
		expect(
			rows[ 0 ].querySelector( '.timeline-view__node' ).textContent
		).toBe( '_repl' );
		expect(
			rows[ 0 ].querySelector( '.timeline-view__event' ).textContent
		).toBe( 'SEGMENT' );
		// Payload is the DEBUG line's tail ONLY — the envelope `}` is not swallowed.
		const payload = rows[ 0 ].querySelector(
			'.timeline-view__payload'
		).textContent;
		expect( payload ).toBe( '1' );
		expect( payload ).not.toContain( '}' );
	} );

	it( 'a plain DEBUG entry keeps its payload free of any envelope brace', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const payloads = rowsOf( container ).map(
			( r ) => r.querySelector( '.timeline-view__payload' ).textContent
		);
		payloads.forEach( ( p ) => expect( p ).not.toContain( '}' ) );
	} );

	it( 'renders the column header outside the scrollable row body (no sticky)', () => {
		const { container } = render(
			<TimelineView transcript={ transcript } />
		);
		const head = container.querySelector( '.timeline-view__head' );
		const body = container.querySelector( '.timeline-view__body' );
		expect( head ).toBeTruthy();
		expect( body ).toBeTruthy();
		// Every parsed row lives in the scrollable body, never in the header.
		expect( body.querySelectorAll( '.timeline-view__row' ) ).toHaveLength(
			3
		);
		expect( head.querySelectorAll( '.timeline-view__row' ) ).toHaveLength(
			0
		);
		// The header is a sibling of the body, not an ancestor of the rows.
		expect( head.contains( rowsOf( container )[ 0 ] ) ).toBe( false );
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
