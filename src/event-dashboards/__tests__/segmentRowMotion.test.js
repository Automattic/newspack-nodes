/**
 * How a partition's row of segment bars moves between two polls.
 *
 * Three rules hold, each read off the rendered row the way an operator would
 * see it:
 *
 * - The fill cascade counts from the first bar whose regions changed, so a
 *   change confined to the tail animates at once instead of waiting out a
 *   sweep from the left edge; an unchanged bar carries no delay.
 * - Only the live tail's growth animates. A bar a newer segment now follows
 *   is drawn at its final width with no fill transition, and a new segment
 *   that arrived complete slides in already full; a new tail grows from 0.
 * - A rotation of N segments slides the whole drawn stack left by N slots:
 *   the N departing bars slide out, the N arriving ones slide in, and every
 *   bar but the new tail already shows its final content, so the edge between
 *   written and unwritten stays at the tail instead of jumping back N slots.
 * - A poll after a hidden-tab gap has no baseline, so nothing moves.
 * - A departed bar belongs to the row drawing it: it leaves on its own
 *   slide-out, and a folded row takes its departures with it.
 *
 * Ids and sizes sit far from every default: segments 4471-4483, 7,340,032-byte
 * tails against an 8,388,608-byte rotation size.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcssScss from 'postcss-scss';
import { act, render, fireEvent, createEvent } from '@testing-library/react';
import {
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	newMessage,
} from '../../runtime/message';
import { Core } from '../../runtime/core';
import { WorkerStatusTransformNode } from '../nodes/worker-status-transform-node';
import { WorkerStatusViewNode } from '../nodes/worker-status-view-node';
import { sectionFor } from '../TopologyRow';
import TopologySection from '../TopologySection';

/**
 * Fire `animationend` naming the animation; jsdom has no AnimationEvent, so
 * the name is stamped onto the generic event React reads it from.
 *
 * @param {Element} el   The animated element.
 * @param {string}  name The `animation-name` that ended.
 */
function endAnimation( el, name ) {
	const event = createEvent.animationEnd( el );
	Object.defineProperty( event, 'animationName', { value: name } );
	fireEvent( el, event );
}

const MAX = 8_388_608;
const TAIL = 7_340_032;

const graph = {
	fw: {
		nodes: [
			{ name: 'fw-in', kind: 'consumer', reads: 'firehose.p{partition}' },
			{ name: 'fw-log', kind: 'log', writes: 'firehose.p{partition}' },
		],
		edges: [ [ 'fw-in', 'fw-log' ] ],
	},
};

/**
 * One `dump_graph` payload: every segment full but the last, which holds
 * `tailSize`, and a reader at `cursor`.
 *
 * @param {number[]} ids      Live segment ids, oldest first.
 * @param {number}   ts       Snapshot timestamp.
 * @param {number}   tailSize Bytes in the newest segment.
 * @param {Object}   cursor   `{ segment, offset }` the reader sits at.
 * @return {Object} The lean payload the transform takes.
 */
function snapshot( ids, ts, tailSize, cursor ) {
	const segments = ids.map( ( id, i ) => ( {
		id,
		size: i === ids.length - 1 ? tailSize : MAX,
	} ) );
	const tail = ids[ ids.length - 1 ];
	return {
		graph,
		timestamp: ts,
		segment_size: MAX,
		workers: [ { type: 'fw', partition: 0, state: 'live' } ],
		consumers: [
			{
				reader: 'firehose.fw.p0',
				source: 'firehose.p0',
				partition: 0,
				cursor_segment: cursor.segment,
				cursor_offset: cursor.offset,
				end_segment: tail,
				end_size: tailSize,
				distance: 0,
			},
		],
		logs: [
			{
				name: 'firehose.p0',
				partitions: [ { partition: 0, segments, total_size: 0 } ],
				segment_size: MAX,
			},
		],
	};
}

/**
 * One model's row, drawn as the dashboard draws it.
 *
 * @param {Object} m The worker-status model.
 * @return {import('react').ReactElement} The topology section.
 */
function sectionElement( m ) {
	const section = sectionFor( 'fw', { ...m, graph: m.graph.fw } );
	return (
		<TopologySection
			section={ section }
			workers={ section.workers }
			writeRates={ m.writeRates }
			segmentSize={ MAX }
			currentTime={ 0 }
			prevSegments={ m.prevSegments }
			removingSegments={ m.removingSegments }
			collapsed={ new Set() }
			onToggle={ () => {} }
		/>
	);
}

/**
 * Feed snapshots through the real transform, collecting each poll's model.
 *
 * @param {Array<Object>} snaps The payloads, in poll order.
 * @return {Array<Object>} The model each payload produced.
 */
function models( snaps ) {
	const transform = new WorkerStatusTransformNode();
	transform.name = 'worker-status:transform';
	const out = [];
	transform.sink = { fill: ( m ) => out.push( m[ VALUE ].model ) };
	snaps.forEach( ( payload ) => {
		const message = newMessage();
		message[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		message[ VALUE ] = { name: 'dump_graph', payload };
		transform.fill( message );
	} );
	return out;
}

/**
 * Feed snapshots through the real transform and render each model's row, as
 * the dashboard does on each poll.
 *
 * @param {Array<Object>} snaps The payloads, in poll order.
 * @return {HTMLElement} The container after the last render.
 */
function renderPolls( snaps ) {
	const [ first, ...rest ] = models( snaps );
	const mounted = render( sectionElement( first ) );
	rest.forEach( ( m ) => mounted.rerender( sectionElement( m ) ) );
	return mounted.container;
}

/**
 * The rendered row, one entry per bar in DOM order.
 *
 * @param {HTMLElement} container Render container.
 * @return {Array<Object>} `{ id, classes, stagger, widths, drawn }` per bar,
 *   `drawn` summing the three fill widths.
 */
function row( container ) {
	return [ ...container.querySelectorAll( '.worker-segment-h' ) ].map(
		( bar ) => {
			const widths = [ ...bar.querySelectorAll( '.segment-fill-h' ) ].map(
				( f ) => parseFloat( f.style.width )
			);
			return {
				id: Number( bar.getAttribute( 'title' ).match( /\d+/ )[ 0 ] ),
				classes: bar.className,
				stagger: bar.style.getPropertyValue( '--seg-stagger' ),
				widths,
				drawn: widths.reduce( ( a, w ) => a + w, 0 ),
			};
		}
	);
}

const byId = ( bars, id ) => bars.find( ( b ) => b.id === id );
const stylesheet = () =>
	readFileSync( join( __dirname, '../styles/worker-status.scss' ), 'utf8' );
const ids = ( from, to ) =>
	Array.from( { length: to - from + 1 }, ( _, i ) => from + i );

beforeEach( () => Core.reset() );

describe( 'the fill cascade counts from the first changed bar', () => {
	it( 'a change in the tail alone animates at once', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
					segment: 4480,
					offset: 1_048_576,
				} ),
				snapshot( ids( 4471, 4480 ), 305, TAIL, {
					segment: 4480,
					offset: 1_048_576,
				} ),
			] )
		);
		expect( byId( bars, 4480 ).stagger ).toBe( '0' );
		bars.forEach( ( b ) => expect( b.stagger ).toBe( '0' ) );
	} );

	it( 'a cursor crossing several bars cascades from the first one it moved', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, TAIL, {
					segment: 4476,
					offset: 2_097_152,
				} ),
				snapshot( ids( 4471, 4480 ), 305, TAIL, {
					segment: 4478,
					offset: 4_194_304,
				} ),
			] )
		);
		expect( byId( bars, 4476 ).stagger ).toBe( '0' );
		expect( byId( bars, 4477 ).stagger ).toBe( '1' );
		expect( byId( bars, 4478 ).stagger ).toBe( '2' );
		// Unchanged bars on either side wait for nothing.
		expect( byId( bars, 4475 ).stagger ).toBe( '0' );
		expect( byId( bars, 4480 ).stagger ).toBe( '0' );
	} );

	it( 'the stylesheet owns the step: each stagger count is one fill duration', () => {
		const root = postcssScss.parse( stylesheet() );
		const decls = {};
		root.walkRules( '.segment-fill-h', ( rule ) =>
			rule.walkDecls( ( decl ) => ( decls[ decl.prop ] = decl.value ) )
		);
		const step = decls.transition.match( /width\s+(\S+)/ )[ 1 ];
		expect( decls[ 'transition-delay' ] ).toBe(
			`calc(var(--seg-stagger, 0) * #{${ step }})`
		);
	} );
} );

describe( 'a poll after a hidden-tab gap moves nothing', () => {
	// The transform's gap is 6 heartbeats of 10 s; these polls sit 95 s apart.
	it( 'a cursor that crossed bars during the gap cascades from nothing', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, TAIL, {
					segment: 4476,
					offset: 2_097_152,
				} ),
				snapshot( ids( 4471, 4480 ), 395, TAIL, {
					segment: 4478,
					offset: 4_194_304,
				} ),
			] )
		);
		bars.forEach( ( b ) =>
			expect( [ b.id, b.stagger ] ).toEqual( [ b.id, '0' ] )
		);
	} );

	it( 'a rotation during the gap neither snaps nor slides', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
					segment: 4480,
					offset: 3_145_728,
				} ),
				snapshot( ids( 4474, 4483 ), 395, TAIL, {
					segment: 4483,
					offset: 1_048_576,
				} ),
			] )
		);
		bars.forEach( ( b ) =>
			expect( [ b.id, b.classes ] ).toEqual( [
				b.id,
				'worker-segment-h',
			] )
		);
		expect( byId( bars, 4483 ).drawn ).toBe( 87.5 );
	} );
} );

describe( 'only the live tail grows; a bar that moved left is drawn full', () => {
	it( 'the old tail, now followed by a newer segment, snaps to its final width', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
					segment: 4480,
					offset: 3_145_728,
				} ),
				snapshot( ids( 4472, 4481 ), 305, TAIL, {
					segment: 4481,
					offset: 1_048_576,
				} ),
			] )
		);
		const oldTail = byId( bars, 4480 );
		expect( oldTail.classes ).toContain( 'segment-snap' );
		expect( oldTail.drawn ).toBe( 100 );
		// The new tail grows its partial fill from nothing.
		const newTail = byId( bars, 4481 );
		expect( newTail.classes ).not.toContain( 'segment-snap' );
		expect( newTail.drawn ).toBe( 0 );
	} );

	it( 'a new segment that arrived complete slides in already full', () => {
		const bars = row(
			renderPolls( [
				snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
					segment: 4480,
					offset: 3_145_728,
				} ),
				snapshot( ids( 4473, 4482 ), 305, TAIL, {
					segment: 4482,
					offset: 1_048_576,
				} ),
			] )
		);
		const complete = byId( bars, 4481 );
		expect( complete.classes ).toContain( 'segment-slide-in' );
		expect( complete.classes ).toContain( 'segment-snap' );
		expect( complete.drawn ).toBe( 100 );
	} );
} );

describe( 'a rotation of three slides the drawn stack left three slots', () => {
	const polls = () =>
		renderPolls( [
			snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
				segment: 4480,
				offset: 3_145_728,
			} ),
			snapshot( ids( 4474, 4483 ), 305, TAIL, {
				segment: 4483,
				offset: 1_048_576,
			} ),
		] );

	it( 'three bars depart on the left and three arrive on the right', () => {
		const bars = row( polls() );
		expect(
			bars
				.filter( ( b ) => b.classes.includes( 'segment-slide-out' ) )
				.map( ( b ) => b.id )
		).toEqual( [ 4471, 4472, 4473 ] );
		expect(
			bars
				.filter( ( b ) => b.classes.includes( 'segment-slide-in' ) )
				.map( ( b ) => b.id )
		).toEqual( [ 4481, 4482, 4483 ] );
	} );

	it( 'every live bar but the new tail already shows its final content', () => {
		const bars = row( polls() );
		ids( 4474, 4482 ).forEach( ( id ) =>
			expect( [ id, byId( bars, id ).drawn ] ).toEqual( [ id, 100 ] )
		);
		// Nothing waits on a cascade: the tail is the one animated change.
		expect( byId( bars, 4483 ).drawn ).toBe( 0 );
		expect( byId( bars, 4483 ).stagger ).toBe( '0' );
	} );

	it( 'departure and arrival run on one clock, so the stack translates rigidly', () => {
		const root = postcssScss.parse( stylesheet() );
		const animations = {};
		root.walkDecls( 'animation', ( decl ) => {
			const [ name, ...timing ] = decl.value.split( /\s+/ );
			animations[ name ] = timing.filter( ( t ) => t !== 'forwards' );
		} );
		expect( animations[ 'segment-slide-in' ] ).toEqual(
			animations[ 'segment-slide-out' ]
		);
		// A slot's gap leaves with its bar, not in one jump at the clear.
		const frames = {};
		root.walkAtRules( 'keyframes', ( rule ) => {
			frames[ rule.params ] = rule.toString();
		} );
		expect( frames[ 'segment-slide-in' ] ).toMatch( /margin-left/ );
		expect( frames[ 'segment-slide-out' ] ).toMatch( /margin-right/ );
	} );
} );

describe( 'a departed bar belongs to the row drawing it', () => {
	/**
	 * The dashboard's graph from the transform on, the view named as
	 * `useTopologyManager` names it, drawn in a tree whose folds a click on a
	 * caret toggles.
	 *
	 * @return {{ poll: Function, container: Function, bar: Function,
	 *   departing: Function, toggleLog: Function }} A poller that fills one
	 *   payload and re-renders the view's model, and readers of the row.
	 */
	function mountView() {
		const view = new WorkerStatusViewNode();
		view.name = 'worker-status:view';
		const transform = new WorkerStatusTransformNode();
		transform.name = 'worker-status:transform';
		transform.sink = view;
		const collapsed = new Set();
		let mounted;
		const element = () => {
			const m = view.view;
			const section = sectionFor( 'fw', { ...m, graph: m.graph.fw } );
			return (
				<TopologySection
					section={ section }
					workers={ section.workers }
					writeRates={ m.writeRates }
					segmentSize={ MAX }
					currentTime={ 0 }
					prevSegments={ m.prevSegments }
					removingSegments={ m.removingSegments }
					collapsed={ new Set( collapsed ) }
					onToggle={ ( key ) => {
						if ( ! collapsed.delete( key ) ) {
							collapsed.add( key );
						}
						mounted.rerender( element() );
					} }
				/>
			);
		};
		const poll = ( payload ) => {
			const message = newMessage();
			message[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			message[ VALUE ] = { name: 'dump_graph', payload };
			transform.fill( message );
			if ( mounted ) {
				mounted.rerender( element() );
			} else {
				mounted = render( element() );
			}
		};
		const container = () => mounted.container;
		return {
			poll,
			container,
			bar: ( id ) =>
				[ ...container().querySelectorAll( '.worker-segment-h' ) ].find(
					( el ) => el.getAttribute( 'title' ).includes( `${ id }:` )
				),
			departing: () =>
				row( container() )
					.filter( ( b ) =>
						b.classes.includes( 'segment-slide-out' )
					)
					.map( ( b ) => b.id ),
			toggleLog: () =>
				fireEvent.click(
					container().querySelector( '.log-name' )
						.previousElementSibling
				),
		};
	}

	const rotated = () => [
		snapshot( ids( 4471, 4480 ), 300, 3_145_728, {
			segment: 4480,
			offset: 3_145_728,
		} ),
		snapshot( ids( 4473, 4482 ), 305, TAIL, {
			segment: 4482,
			offset: 1_048_576,
		} ),
	];

	it( 'stays through time and later polls until its slide-out ends', () => {
		jest.useFakeTimers();
		try {
			const { poll, bar, departing } = mountView();
			rotated().forEach( poll );
			act( () => jest.advanceTimersByTime( 60000 ) );
			expect( departing() ).toEqual( [ 4471, 4472 ] );
			// Polls that rotate nothing leave a slide in flight alone.
			poll(
				snapshot( ids( 4473, 4482 ), 310, TAIL, {
					segment: 4482,
					offset: 2_097_152,
				} )
			);
			poll(
				snapshot( ids( 4473, 4482 ), 315, TAIL, {
					segment: 4482,
					offset: 3_145_728,
				} )
			);
			expect( departing() ).toEqual( [ 4471, 4472 ] );

			// The arriving bars' slide-in ending is not a departure.
			endAnimation( bar( 4481 ), 'segment-slide-in' );
			endAnimation( bar( 4471 ), 'segment-slide-in' );
			expect( departing() ).toEqual( [ 4471, 4472 ] );

			endAnimation( bar( 4471 ), 'segment-slide-out' );
			expect( departing() ).toEqual( [ 4472 ] );
			endAnimation( bar( 4472 ), 'segment-slide-out' );
			expect( departing() ).toEqual( [] );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'a departure ending mid-slide leaves the arrivals moving', () => {
		const { poll, bar, container } = mountView();
		rotated().forEach( poll );
		endAnimation( bar( 4471 ), 'segment-slide-out' );
		const bars = row( container() );
		expect( byId( bars, 4471 ) ).toBeUndefined();
		expect( byId( bars, 4481 ).classes ).toBe(
			'worker-segment-h segment-slide-in segment-snap'
		);
		expect( byId( bars, 4482 ).classes ).toBe(
			'worker-segment-h segment-slide-in'
		);
	} );

	it( 'a rebuilt but equal removingSegments holds each departure once', () => {
		const errors = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			const [ first, second ] = models( rotated() );
			// Each render gets a fresh object carrying the same departures.
			const rebuilt = () =>
				sectionElement( {
					...second,
					removingSegments: {
						'firehose.p0': second.removingSegments[
							'firehose.p0'
						].map( ( seg ) => ( { ...seg } ) ),
					},
				} );
			const { container, rerender } = render( sectionElement( first ) );
			rerender( rebuilt() );
			rerender( rebuilt() );
			const departing = () =>
				row( container )
					.filter( ( b ) =>
						b.classes.includes( 'segment-slide-out' )
					)
					.map( ( b ) => b.id );
			expect( departing() ).toEqual( [ 4471, 4472 ] );

			// A bar that slid out stays gone when the equal object comes again.
			const bar = [
				...container.querySelectorAll( '.worker-segment-h' ),
			];
			endAnimation( bar[ 0 ], 'segment-slide-out' );
			rerender( rebuilt() );
			expect( departing() ).toEqual( [ 4472 ] );
			expect(
				errors.mock.calls.filter( ( [ msg ] ) =>
					String( msg ).includes( 'same key' )
				)
			).toEqual( [] );
		} finally {
			errors.mockRestore();
		}
	} );

	it( 'a folded row unmounts and takes its departures with it', () => {
		const { poll, container, departing, toggleLog } = mountView();
		rotated().forEach( poll );
		expect( departing() ).toEqual( [ 4471, 4472 ] );
		toggleLog();
		expect( container().querySelector( '.worker-segment-h' ) ).toBeNull();
		toggleLog();
		expect( departing() ).toEqual( [] );
		// The unfolded row draws what is, with nothing arriving or leaving.
		row( container() ).forEach( ( b ) =>
			expect( [ b.id, b.classes ] ).toEqual( [
				b.id,
				'worker-segment-h',
			] )
		);
	} );
} );
