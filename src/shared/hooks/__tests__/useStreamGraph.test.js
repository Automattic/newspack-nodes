/**
 * useStreamGraph tests — the whole life of a streaming dashboard's graph: the
 * three nodes it declares, the pause/visibility gate that decides when the
 * stream is open, the recorded target every reopen goes through, and the paused
 * single-step read composed on top of it.
 *
 * The seam is the RemoteLink's EventSource, so the graph builds for real and
 * what was asked of the stream is read off the fake it opened.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, Node, VALUE } from '@newspack-nodes/runtime';
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
const LINK = 'zed:link';
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

/**
 * Watch the live link's two reopen paths. The SseIn re-states its own tracked
 * offset either way, so only the link says which decision was taken.
 *
 * @return {Object} The link, with `setSubscribe` and `reconnect` spied.
 */
function spyOnLink() {
	const link = Core.node( LINK );
	jest.spyOn( link, 'setSubscribe' );
	jest.spyOn( link, 'reconnect' );
	return link;
}

describe( 'the declared graph', () => {
	test( 'builds link → stream → view from the declaration alone', () => {
		mount();
		const link = Core.node( LINK );
		expect( link.arguments ).toEqual( [ SUBSCRIBE ] );
		expect( link.target ).toBe( TEE );
		expect( Core.node( TEE ).target ).toEqual( [ VIEW ] );
		expect( Core.node( VIEW ) ).toBeInstanceOf( ProbeViewNode );
		expect( Core.node( VIEW ).controlFrom ).toBe( VIEW );
	} );

	test( 'an endpoint override re-points the stream', () => {
		mount( { endpoint: 'newspack-nodes/v1/zed/stream' } );
		expect( Core.node( LINK ).endpoint ).toBe(
			'newspack-nodes/v1/zed/stream'
		);
		expect( opened() ).toContain( 'newspack-nodes/v1/zed/stream' );
	} );

	test( 'maxEntries caps the view ring', () => {
		mount( { maxEntries: 137 } );
		expect( Core.node( VIEW ).maxLines ).toBe( 137 );
	} );

	test( 'the view keeps its own cap when none is declared', () => {
		mount();
		expect( Core.node( VIEW ).maxLines ).toBe( 0 );
	} );

	test( 'opens the stream at mount', () => {
		mount();
		expect( opened() ).toContain( SUBSCRIBE );
	} );

	test( 'an OMITTED subscription reads the same as an absent one', () => {
		const { result } = renderHook( () =>
			useStreamGraph( { prefix: PREFIX, viewClass: ProbeViewNode } )
		);
		expect( FakeEventSource.instances ).toHaveLength( 0 );
		act( () => result.current.resubscribe( [ 'other.p3' ], null ) );
		expect( opened() ).toContain( 'other.p3' );
	} );

	test( 'no declared subscription opens nothing until one is named', () => {
		const { result } = mount( { subscribe: null } );
		expect( FakeEventSource.instances ).toHaveLength( 0 );
		act( () => result.current.resubscribe( [ 'other.p3' ], null ) );
		expect( opened() ).toContain( 'other.p3' );
	} );

	// A rebuild is Reset Graph: the soft nodes go and come back, and the stream
	// must come back with them — including after a selection has been delivered.
	test( 'a rebuild reopens the stream it had delivered a target to', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		act( () => Core.bumpGraphGeneration() );
		expect( FakeEventSource.instances.length ).toBeGreaterThan( 1 );
		expect( opened() ).toContain( 'a.p1' );
	} );

	test( 'teardown removes the link', () => {
		const { unmount } = mount();
		act( () => unmount() );
		expect( Core.node( LINK ) ).toBeFalsy();
	} );
} );

describe( 'the gate', () => {
	test( 'a hidden page closes the stream', () => {
		const { rerender } = mount();
		const es = FakeEventSource.instances[ 0 ];
		mockPageVisible = false;
		act( () => rerender() );
		expect( es.closed ).toBe( true );
	} );

	test( 'pause closes the stream and publishes the control', () => {
		const { result } = mount();
		const es = FakeEventSource.instances[ 0 ];
		act( () => result.current.setPaused( true ) );
		expect( es.closed ).toBe( true );
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toEqual( {
			action: 'pause',
			paused: true,
		} );
	} );

	test( 'Play reopens without restating the seek it already read past', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		const link = spyOnLink();
		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );
		// A reopen states no seek; the stream resumes where it read to.
		expect( link.reconnect ).toHaveBeenCalledWith( [ 'a.p1' ] );
		expect( link.setSubscribe ).not.toHaveBeenCalled();
	} );

	test( 'a selection made while paused only records; Play applies it', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		act( () => result.current.setPaused( true ) );
		act( () => result.current.resubscribe( [ 'b.p2' ], null ) );
		expect( opened() ).toContain( 'a.p1' );
		act( () => result.current.setPaused( false ) );
		expect( opened() ).toContain( 'b.p2' );
	} );

	test( 'an explicit seek is single-use: a later pause/play resumes live', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.setPaused( true ) );
		act( () =>
			result.current.resubscribe( [ 'a.p1' ], { 'a.p1': 'start' } )
		);
		const link = spyOnLink();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a.p1' ], {
			'a.p1': 'start',
		} );
		// The seek is spent; the next Play resumes the tail it reached.
		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledTimes( 1 );
		expect( link.reconnect ).toHaveBeenCalledWith( [ 'a.p1' ] );
	} );

	test( 'a seek in the same tick as pause records instead of delivering', () => {
		const { result } = mount( { subscribe: null } );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'a.p1' ], { 'a.p1': 'start' } );
		} );
		expect( FakeEventSource.instances ).toHaveLength( 0 );
	} );

	test( 'resubscribe while active re-points the stream at once', () => {
		const { result } = mount( { subscribe: null } );
		const link = spyOnLink();
		act( () => result.current.resubscribe( [ 'a.p1' ], null ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a.p1' ], null );
	} );

	// @longform The symmetric hole: play flips the gate refs synchronously, so
	// a same-tick seek delivers immediately and is marked consumed — the
	// isActive effect must NOT then re-deliver the consumed target at the live
	// resume position, silently overwriting the seek it just applied.
	test( 'play + a same-tick seek delivers once, at the seek', () => {
		const { result } = mount( { subscribe: null } );
		act( () => result.current.setPaused( true ) );
		const link = spyOnLink();
		act( () => {
			result.current.setPaused( false );
			result.current.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 2, offset: 0 },
			} );
		} );
		expect( link.setSubscribe ).toHaveBeenCalledTimes( 1 );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a.p1' ], {
			'a.p1': { segment: 2, offset: 0 },
		} );
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
		const link = spyOnLink();
		act( () =>
			result.current.seek(
				'a.p1',
				{ 'a.p1': 'start' },
				{ segments: [ { id: 6, size: 4096 } ] }
			)
		);
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a.p1' ], {
			'a.p1': 'start',
		} );
		// The boundary the replay catches up to rides the control.
		expect( Core.node( VIEW ).taken.pop()[ VALUE ] ).toMatchObject( {
			action: 'browse',
			endSegment: 6,
			endOffset: 4096,
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

	test( 'a redundant re-render while streaming does NOT reopen', () => {
		const { rerender } = mount();
		expect( FakeEventSource.instances ).toHaveLength( 1 );
		act( () => rerender() );
		expect( FakeEventSource.instances ).toHaveLength( 1 );
	} );
} );

describe( 'useSteppedRead', () => {
	const STEP_READ = { ci: 'raw-logs', command: 'read_message' };

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
		expect( Core.node( `${ PREFIX }:read:result` ) ).toBeTruthy();
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

	// @longform A verb with a SUB-VERB does not carry the source at args[0] —
	// `taillog read <sub> <pos>` puts the literal 'read' there. Reading the
	// reply's args positionally re-pointed the stream at a source called
	// 'read', which blanked the Log Viewer on the next Play. The partition
	// shape hides this, because there args[0] IS the source.
	test( 'advances the target using the SOURCE, not args[0], for a sub-verb', async () => {
		replyFor = jest.fn( () => ( {
			message: [ 1, 'x', '', '', 'k', 0, 'row' ],
			cursor: { segment: 2, offset: 9 },
		} ) );
		installFakeCommandWire( ( m ) => replyFor( m ) );
		const { result } = renderHook( () => {
			const graph = useStreamGraph( {
				prefix: PREFIX,
				subscribe: null,
				viewClass: ProbeViewNode,
			} );
			return {
				graph,
				step: useSteppedRead( {
					graph,
					command: 'taillog',
					argsFor: ( sub, position ) => [ 'read', sub, position ],
					subjectOf: ( args ) => args[ 1 ],
				} ),
			};
		} );
		act( () => {
			result.current.graph.setPaused( true );
			result.current.graph.resubscribe( [ 'a.p1' ], {
				'a.p1': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );
		// The post-step cursor, distinct from the seeded one: it lands under
		// the SOURCE only if the reply was addressed by it, not by 'read'.
		await waitFor( () =>
			expect( result.current.graph.targetRef.current ).toEqual( {
				subscribe: [ 'a.p1' ],
				positions: { 'a.p1': { segment: 2, offset: 9 } },
			} )
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
} );
