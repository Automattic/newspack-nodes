/**
 * useStreamGraph tests — the whole life of a streaming dashboard's graph: the
 * three nodes it declares, the pause/visibility gate that decides when the
 * stream is open, the recorded target every reopen goes through, and the paused
 * single-step read composed on top of it.
 *
 * The seam is the page link's EventSource, so the graph builds for real and
 * what was asked of the stream is read off the fake it opened. The link opens
 * once per tick, so a test flushes the microtask before it reads the fake.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import {
	Core,
	Node,
	VALUE,
	TM_STRUCT,
	mountExospine,
} from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useStreamGraph, useSteppedRead } from '../useStreamGraph';

let mockPageVisible = true;
jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => mockPageVisible,
} ) );

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.instances.push( this );
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
}

// A view of the shape the hook mounts: it declares the origin it trusts.
class ProbeViewNode extends Node {
	constructor() {
		super();
		this.controlFrom = '';
		this.maxLines = 0;
		this.taken = [];
	}
	fill( message ) {
		this.taken.push( message );
	}
}

const PREFIX = 'zed';
const LINK = '_stream';
const TEE = 'zed:stream';
const VIEW = 'zed:view';
const SUBSCRIBE = 'quux.p7';

let replyFor;

beforeEach( () => {
	mockPageVisible = true;
	Core.reset();
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => null );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

function mount( overrides = {} ) {
	return renderHook( () =>
		useStreamGraph( {
			prefix: PREFIX,
			subscribe: SUBSCRIBE,
			viewClass: ProbeViewNode,
			...overrides,
		} )
	);
}

/** The URL of the most recently opened stream. */
const opened = () =>
	FakeEventSource.instances[ FakeEventSource.instances.length - 1 ]?.url ??
	'';

/** Let the page link open what this tick asked of it. */
const flush = () => act( async () => {} );

/**
 * Watch how the graph rides the page link. The SseIn re-states its own tracked
 * offset either way, so only the link's calls say which decision was taken.
 *
 * @return {Object} The link, with `attach`, `park` and `detach` spied.
 */
function spyOnStream() {
	const link = Core.node( LINK );
	jest.spyOn( link, 'attach' );
	jest.spyOn( link, 'park' );
	jest.spyOn( link, 'detach' );
	return link;
}

/**
 * The seeks the spied `attach` carried, in call order.
 *
 * @param {Object} link The page link, its `attach` spied.
 * @return {Array} Each call's positions argument.
 */
const seeksAttached = ( link ) =>
	link.attach.mock.calls.map( ( [ , , , positions ] ) => positions );

describe( 'the declared graph', () => {
	test( 'builds stream → view and rides the page link with its subscription', async () => {
		mount();
		await flush();
		expect( Core.node( 'zed:link' ) ).toBeNull();
		expect( Core.node( TEE ).target ).toEqual( [ VIEW ] );
		expect( Core.node( VIEW ) ).toBeInstanceOf( ProbeViewNode );
		expect( Core.node( VIEW ).controlFrom ).toBe( VIEW );
		expect( Core.node( LINK ).graphs.get( PREFIX ) ).toEqual( {
			subscribe: [ SUBSCRIBE ],
			target: TEE,
			parked: false,
		} );
		expect( opened() ).toContain( `subscribe=${ SUBSCRIBE }` );
	} );

	test( 'a link carries no endpoint override', () => {
		mount( {} );
		expect( 'endpoint' in Core.node( LINK ) ).toBe( false );
	} );

	test( 'maxEntries caps the view ring', () => {
		mount( { maxEntries: 137 } );
		expect( Core.node( VIEW ).maxLines ).toBe( 137 );
	} );

	test( 'the view keeps its own cap when none is declared', () => {
		mount();
		expect( Core.node( VIEW ).maxLines ).toBe( 0 );
	} );

	test( 'the stream node shows only this graph’s skipped lines', async () => {
		mount();
		await flush();
		const frame = JSON.stringify( [
			64,
			0,
			'_stream',
			'',
			'',
			'unparseable_lines',
			`COUNT 9 COUNTS ${ SUBSCRIBE }=6,other.p2=3`,
		] );
		act( () =>
			FakeEventSource.instances
				.at( -1 )
				.listeners.unparseable_lines.forEach( ( cb ) =>
					cb( { data: frame } )
				)
		);
		expect( Core.node( TEE ).setStateCache.UNPARSEABLE_LINES ).toBe( 6 );
	} );

	test( 'opens the stream at mount', async () => {
		mount();
		await flush();
		expect( opened() ).toContain( SUBSCRIBE );
	} );

	test( 'an OMITTED subscription reads the same as an absent one', async () => {
		const { result } = renderHook( () =>
			useStreamGraph( { prefix: PREFIX, viewClass: ProbeViewNode } )
		);
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 0 );
		act( () => result.current.resubscribe( [ 'other.p3' ], null ) );
		await flush();
		expect( opened() ).toContain( 'other.p3' );
	} );

	test( 'no declared subscription opens nothing until one is named', async () => {
		const { result } = mount( { subscribe: null } );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 0 );
		act( () => result.current.resubscribe( [ 'other.p3' ], null ) );
		await flush();
		expect( opened() ).toContain( 'other.p3' );
	} );

	// A rebuild is Reset Graph: the soft nodes go and come back, and the stream
	// must come back with them — including after a selection has been delivered.
	test( 'a rebuild reopens the stream it had delivered a target to', async () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		act( () => Core.bumpGraphGeneration() );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 2 );
		expect( opened() ).toContain( 'a.p1' );
	} );

	test( 'teardown detaches the graph and leaves the page link standing', async () => {
		const owner = mountExospine( () => {} );
		const { unmount } = mount();
		await flush();
		const link = spyOnStream();
		const stream = FakeEventSource.instances.at( -1 );
		act( () => unmount() );
		await flush();
		expect( link.detach ).toHaveBeenCalledWith( PREFIX );
		expect( Core.node( LINK ) ).toBe( link );
		expect( link.graphs.has( PREFIX ) ).toBe( false );
		expect( stream.closed ).toBe( true );
		owner.teardown();
	} );
} );

describe( 'the gate', () => {
	test( 'a hidden page parks the graph, closing its stream', async () => {
		const { rerender } = mount();
		await flush();
		const link = spyOnStream();
		const es = FakeEventSource.instances[ 0 ];
		mockPageVisible = false;
		act( () => rerender() );
		await flush();
		expect( link.park ).toHaveBeenCalledWith( PREFIX );
		expect( link.detach ).not.toHaveBeenCalled();
		expect( es.closed ).toBe( true );
	} );

	test( 'pause closes the stream and publishes the control', async () => {
		const { result } = mount();
		await flush();
		const es = FakeEventSource.instances[ 0 ];
		act( () => result.current.setPaused( true ) );
		await flush();
		expect( es.closed ).toBe( true );
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toEqual( {
			action: 'pause',
			paused: true,
		} );
	} );

	test( 'Play re-attaches without restating the seek it already read past', async () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		await flush();
		const link = spyOnStream();
		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );
		// A pause parks; Play states no seek, so it resumes where it read to.
		expect( link.park ).toHaveBeenCalledWith( PREFIX );
		expect( link.detach ).not.toHaveBeenCalled();
		expect( link.attach ).toHaveBeenLastCalledWith(
			PREFIX,
			[ 'a.p1' ],
			TEE,
			undefined
		);
	} );

	test( 'a selection made while paused only records; Play applies it', async () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		act( () => result.current.setPaused( true ) );
		act( () => result.current.resubscribe( [ 'b.p2' ], null ) );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 0 );
		act( () => result.current.setPaused( false ) );
		await flush();
		expect( opened() ).toContain( 'subscribe=b.p2' );
	} );

	test( 'an explicit seek is single-use: a later pause/play resumes live', async () => {
		const { result } = mount( { subscribe: null } );
		await flush();
		act( () => result.current.setPaused( true ) );
		act( () =>
			result.current.resubscribe( [ 'a.p1' ], { 'a.p1': 'start' } )
		);
		const link = spyOnStream();
		act( () => result.current.setPaused( false ) );
		expect( link.attach ).toHaveBeenLastCalledWith(
			PREFIX,
			[ 'a.p1' ],
			TEE,
			{
				'a.p1': 'start',
			}
		);
		// The seek is spent; the next Play resumes the tail it reached.
		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );
		expect( seeksAttached( link ) ).toEqual( [
			{ 'a.p1': 'start' },
			undefined,
		] );
	} );

	test( 'a seek in the same tick as pause records instead of delivering', async () => {
		const { result } = mount( { subscribe: null } );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'a.p1' ], { 'a.p1': 'start' } );
		} );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 0 );
	} );

	// Follow and a fresh pick both tail: null is the seek that names the end.
	test( 'resubscribe while active re-points the stream at once', async () => {
		const { result } = mount( { subscribe: null } );
		await flush();
		const link = spyOnStream();
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		expect( link.attach ).toHaveBeenCalledWith(
			PREFIX,
			[ 'a.p1' ],
			TEE,
			null
		);
	} );

	// @longform The symmetric hole: play flips the gate refs synchronously, so
	// a same-tick seek delivers immediately and is marked consumed — the
	// isActive effect must NOT then re-deliver the consumed target at the live
	// resume position, silently overwriting the seek it just applied.
	test( 'play + a same-tick seek delivers once, at the seek', async () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.setPaused( true ) );
		await flush();
		act( () => {
			result.current.setPaused( false );
			result.current.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 2, offset: 0 },
			} );
		} );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		expect(
			JSON.parse(
				new URL( opened(), 'https://x.test' ).searchParams.get(
					'positions'
				)
			)
		).toEqual( { 'a.p1': { segment: 2, offset: 0 } } );
	} );

	test( 'clearOnOpen empties the view before every open', () => {
		const { result } = mount( { clearOnOpen: true } );
		const clears = () =>
			Core.node( VIEW ).taken.filter(
				( m ) => 'clear' === m[ VALUE ]?.action
			).length;
		expect( clears() ).toBe( 1 );
		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );
		// Rows that predate the gap are stale, on a reconnect as on a connect.
		expect( clears() ).toBe( 2 );
	} );

	test( 'no clearOnOpen leaves the view alone', () => {
		mount();
		expect( Core.node( VIEW ).taken ).toEqual( [] );
	} );

	test( 'a seek moves the stream AND states the mode it moved into', () => {
		const { result } = mount( { subscribe: null } );
		const link = spyOnStream();
		act( () =>
			result.current.seek(
				'a.p1',
				{ 'a.p1': 'start' },
				{ segments: [ { id: 6, size: 4096 } ] }
			)
		);
		expect( link.attach ).toHaveBeenCalledWith( PREFIX, [ 'a.p1' ], TEE, {
			'a.p1': 'start',
		} );
		// The boundary the replay catches up to rides the control.
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toMatchObject( {
			action: 'browse',
			segments: [ { id: 6, size: 4096 } ],
		} );
	} );

	test( 'a seek with no positions states the live tail', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.seek( 'a.p1', null ) );
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toEqual( {
			action: 'follow',
		} );
	} );

	test( "a filter term becomes the view's ingest gate", () => {
		const { result } = mount();
		act( () => result.current.setFilter( 'timeout' ) );
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toEqual( {
			action: 'filter',
			term: 'timeout',
		} );
	} );

	test( "clear runs the view's ONE reset", () => {
		const { result } = mount();
		act( () => result.current.clear() );
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toEqual( {
			action: 'clear',
		} );
	} );

	test( 'a redundant re-render while streaming does NOT reopen', async () => {
		const { rerender } = mount();
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		act( () => rerender() );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
	} );
} );

describe( 'one connection per page', () => {
	const declare = ( prefix, subscribe ) => ( {
		prefix,
		subscribe,
		viewClass: ProbeViewNode,
		openAt: { [ subscribe ]: 0 },
	} );
	const mountOne = ( prefix, subscribe ) =>
		renderHook( () => useStreamGraph( declare( prefix, subscribe ) ) );
	const mountTwo = ( wrapper ) =>
		renderHook(
			() => ( {
				jobs: useStreamGraph( declare( 'jobs', 'jobstats.p0' ) ),
				backlog: useStreamGraph(
					declare( 'backlog', 'topicprobe.p0' )
				),
			} ),
			{ wrapper }
		);
	const subscribed = () =>
		new URL( opened(), 'https://x.test' ).searchParams.get( 'subscribe' );

	test( 'two graphs on one page open ONE stream carrying both', async () => {
		mountTwo();
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		expect( subscribed() ).toBe( 'jobstats.p0,topicprobe.p0' );
	} );

	test( 'three mounts in one tick open one connection', async () => {
		mountOne( 'jobs', 'jobstats.p0' );
		mountOne( 'backlog', 'topicprobe.p0' );
		mountOne( 'tables', 'tablestats.p0' );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		expect( subscribed() ).toBe(
			'jobstats.p0,tablestats.p0,topicprobe.p0'
		);
	} );

	test( 'unmounting one graph reopens with the other alone', async () => {
		mountOne( 'jobs', 'jobstats.p0' );
		const backlog = mountOne( 'backlog', 'topicprobe.p0' );
		await flush();
		act( () => backlog.unmount() );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 2 );
		expect( FakeEventSource.instances[ 0 ].closed ).toBe( true );
		expect( subscribed() ).toBe( 'jobstats.p0' );
	} );

	// The first graph to mount owns the backbone; its leaving must not take
	// the page's stream from the graph that stays.
	test( 'the backbone owner unmounting reopens with the other alone', async () => {
		const jobs = mountOne( 'jobs', 'jobstats.p0' );
		mountOne( 'backlog', 'topicprobe.p0' );
		await flush();
		const before = FakeEventSource.instances.length;
		act( () => jobs.unmount() );
		await flush();
		expect( FakeEventSource.instances.length - before ).toBe( 1 );
		expect( subscribed() ).toBe( 'topicprobe.p0' );
		const record = [
			TM_STRUCT,
			0,
			'topicprobe.p0/probe',
			'',
			'7:40:12',
			'',
			{ seen: 'owner-gone-5521' },
		];
		act( () =>
			FakeEventSource.instances
				.at( -1 )
				.listeners.msg.forEach( ( cb ) =>
					cb( { data: JSON.stringify( record ) } )
				)
		);
		expect(
			Core.node( 'backlog:view' ).taken.map( ( m ) => m[ VALUE ] )
		).toContainEqual( { seen: 'owner-gone-5521' } );
	} );

	test( 'a pause and an unmount in one commit reopen once', async () => {
		const jobs = mountOne( 'jobs', 'jobstats.p0' );
		mountOne( 'backlog', 'topicprobe.p0' );
		const tables = mountOne( 'tables', 'tablestats.p0' );
		await flush();
		const before = FakeEventSource.instances.length;
		act( () => {
			jobs.result.current.setPaused( true );
			tables.unmount();
		} );
		await flush();
		expect( FakeEventSource.instances.length - before ).toBe( 1 );
		expect( subscribed() ).toBe( 'topicprobe.p0' );
		const link = Core.node( LINK );
		expect( link.graphs.get( 'jobs' ).parked ).toBe( true );
		expect( link.graphs.has( 'tables' ) ).toBe( false );
	} );

	// Follow states no seed, so a second follower joins the stream the first
	// opened instead of asking to move it.
	test( 'two following graphs on one stamp both ride it', async () => {
		const follow = ( prefix ) =>
			renderHook( () =>
				useStreamGraph( {
					prefix,
					subscribe: 'jobstats.p0',
					viewClass: ProbeViewNode,
					openAt: null,
				} )
			);
		follow( 'jobs' );
		follow( 'ledger' );
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		expect( [ ...Core.node( LINK ).graphs.keys() ] ).toEqual( [
			'jobs',
			'ledger',
		] );
	} );

	// StrictMode unmounts the owner and its neighbour once before remounting
	// both; the remounted owner must still run the full rebuild.
	test( 'StrictMode keeps the remounted owner the one that rebuilds', async () => {
		const { StrictMode, createElement } = require( '@wordpress/element' );
		mountTwo( ( { children } ) =>
			createElement( StrictMode, null, children )
		);
		await flush();
		expect( Core.rebuildable ).toBe( true );
		const before = Core.node( '_command_interpreter' );
		act( () => Core.bumpGraphGeneration() );
		await flush();
		expect( Core.node( '_command_interpreter' ) ).not.toBe( before );
		expect( [ ...Core.node( LINK ).graphs.keys() ].sort() ).toEqual( [
			'backlog',
			'jobs',
		] );
		expect(
			FakeEventSource.instances.filter( ( es ) => ! es.closed )
		).toHaveLength( 1 );
	} );

	test( 'StrictMode double-mount attaches once and opens one stream', async () => {
		const { StrictMode, createElement } = require( '@wordpress/element' );
		mountTwo( ( { children } ) =>
			createElement( StrictMode, null, children )
		);
		await flush();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		expect( [ ...Core.node( LINK ).graphs.keys() ].sort() ).toEqual( [
			'backlog',
			'jobs',
		] );
	} );
} );

describe( 'useSteppedRead', () => {
	const STEP_READ = {
		group: 'kestrel',
		ci: 'raw-logs',
		command: 'read_message',
	};

	// Every read_message the fake wire was asked for, as its argument list.
	const stepArgs = () =>
		replyFor.mock.calls
			.map( ( [ m ] ) => m[ VALUE ] )
			.filter( ( v ) => 'read_message' === v?.name )
			.map( ( v ) => v.arguments );

	function mountStepped() {
		return renderHook( () => {
			const graph = useStreamGraph( {
				prefix: PREFIX,
				subscribe: null,
				viewClass: ProbeViewNode,
			} );
			return { graph, step: useSteppedRead( { graph, ...STEP_READ } ) };
		} );
	}

	test( 'names its nodes from the graph it steps', () => {
		mountStepped();
		expect( Core.node( `${ PREFIX }-step:result` ) ).toBeTruthy();
		expect( Core.node( `${ PREFIX }:read:result` ) ).toBeNull();
	} );

	test( 'steps from the seek recorded in the same tick as the pause', async () => {
		const { result } = mountStepped();
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 4, offset: 96 },
			} );
		} );
		act( () => result.current.step() );
		await waitFor( () =>
			expect( stepArgs() ).toEqual( [ [ 'a.p1', '4:96' ] ] )
		);
		// The read belongs to the dashboard's group, not the console's.
		expect( Core.node( 'shell:kestrel' ).counter ).toBe( 1 );
	} );

	test( 'steps from the magic start token a Replay seeks', async () => {
		const { result } = mountStepped();
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], { 'a.p1': 'start' } );
		} );
		act( () => result.current.step() );
		await waitFor( () =>
			expect( stepArgs() ).toEqual( [ [ 'a.p1', 'start' ] ] )
		);
	} );

	test( 'an unpaused stream never steps', async () => {
		const { result } = mountStepped();
		act( () => result.current.graph.resubscribe( [ 'a.p1' ], null ) );
		act( () => result.current.step() );
		await act( async () => {} );
		expect( stepArgs() ).toEqual( [] );
	} );

	test( 'the stepped record is admitted and the target advances', async () => {
		replyFor = jest.fn( ( m ) =>
			'read_message' === m[ VALUE ]?.name
				? {
						message: [ 1, 'x', '', '', 'k', 0, 'row' ],
						cursor: { segment: 4, offset: 200 },
				  }
				: null
		);
		installFakeCommandWire( ( m ) => replyFor( m ) );
		const { result } = mountStepped();
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 4, offset: 96 },
			} );
		} );
		act( () => result.current.step() );
		await waitFor( () =>
			expect( result.current.graph.targetRef.current.positions ).toEqual(
				{
					'a.p1': { segment: 4, offset: 200 },
				}
			)
		);
		const taken = Core.node( VIEW ).taken;
		expect( taken[ taken.length - 2 ][ VALUE ] ).toEqual( {
			action: 'step',
			frames: 1,
		} );
		expect( taken[ taken.length - 1 ][ VALUE ] ).toBe( 'row' );
	} );

	test( 'a line consumed without a record advances the target past it', async () => {
		replyFor = jest.fn( ( m ) =>
			'read_message' === m[ VALUE ]?.name
				? {
						source: 'a.p1',
						message: null,
						cursor: { segment: 4, offset: 173 },
						at_eof: false,
				  }
				: null
		);
		installFakeCommandWire( ( m ) => replyFor( m ) );
		const { result } = mountStepped();
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 4, offset: 96 },
			} );
		} );
		const before = Core.node( VIEW ).taken.length;
		act( () => result.current.step() );
		await waitFor( () =>
			expect( result.current.graph.targetRef.current.positions ).toEqual(
				{ 'a.p1': { segment: 4, offset: 173 } }
			)
		);
		expect( Core.node( VIEW ).taken ).toHaveLength( before );
	} );

	test( 'no record at the position adds no row and keeps the target', async () => {
		replyFor = jest.fn( ( m ) =>
			'read_message' === m[ VALUE ]?.name
				? {
						source: 'a.p1',
						message: null,
						cursor: { segment: 4, offset: 96 },
						at_eof: true,
				  }
				: null
		);
		installFakeCommandWire( ( m ) => replyFor( m ) );
		const { result } = mountStepped();
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 4, offset: 96 },
			} );
		} );
		const before = Core.node( VIEW ).taken.length;
		const target = result.current.graph.targetRef.current;
		act( () => result.current.step() );
		await waitFor( () => expect( stepArgs() ).toHaveLength( 1 ) );
		await act( async () => {} );
		expect( Core.node( VIEW ).taken ).toHaveLength( before );
		expect( result.current.graph.targetRef.current ).toBe( target );
	} );
} );
