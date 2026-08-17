/**
 * useLogPositions tests — the browse-model → SSE `positions` mapping shared by
 * the Partition Viewer (segments) and Log Viewer (sources). Live tails (null
 * positions → server 'end'); Browse opens a segment at offset 0; Replay seeks
 * 'start'; paging back walks to the previous existing segment id from log_status.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, TO, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import useLogPositions, {
	segmentPositions,
	replayPositions,
	stepPosition,
	useSegmentBrowse,
	useLogStatusSegments,
} from '../useLogPositions';

describe( 'pure position helpers', () => {
	it( 'segmentPositions() opens a segment at offset 0, keyed by subscription', () => {
		expect( segmentPositions( 'firehose.p7', 3 ) ).toEqual( {
			'firehose.p7': { segment: 3, offset: 0 },
		} );
	} );

	it( 'replayPositions() seeks the magic start token', () => {
		expect( replayPositions( 'errors.p2' ) ).toEqual( {
			'errors.p2': 'start',
		} );
	} );
} );

describe( 'useLogPositions', () => {
	it( 'starts at the live tail, with no clicked segment', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'browseSegment() records the click and seeds that segment', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		let seed;
		act( () => {
			seed = result.current.browseSegment( 6 );
		} );
		expect( result.current.segmentId ).toBe( 6 );
		expect( seed ).toEqual( { 'firehose.p7': { segment: 6, offset: 0 } } );
	} );

	it( 'replay() seeds start; follow() seeds the tail', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'firehose.p7': 'start' } );
		act( () => {
			seed = result.current.follow();
		} );
		expect( seed ).toBeNull();
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'resets to the live tail when the subscription changes', () => {
		const { result, rerender } = renderHook(
			( { sub } ) => useLogPositions( sub ),
			{ initialProps: { sub: 'firehose.p7' } }
		);
		act( () => result.current.browseSegment( 6 ) );
		expect( result.current.segmentId ).toBe( 6 );
		rerender( { sub: 'errors.p2' } );
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'seeds against the NEW subscription after a switch', () => {
		const { result, rerender } = renderHook(
			( { sub } ) => useLogPositions( sub ),
			{ initialProps: { sub: 'firehose.p7' } }
		);
		rerender( { sub: 'errors.p2' } );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'errors.p2': 'start' } );
	} );
} );

/**
 * The position a Step reads from. Replay seeks with the magic 'start' token, so
 * the cursor is a STRING there — the two step() implementations both required an
 * object and silently returned, which is why pause → Replay → Step did nothing.
 * One resolver now serves both.
 */
describe( 'stepPosition', () => {
	const link = ( resume ) => ( { cursor: ( sub ) => resume?.[ sub ] } );

	it( 'passes a magic token through verbatim', () => {
		expect(
			stepPosition( link( null ), 'firehose.p0', {
				'firehose.p0': 'start',
			} )
		).toBe( 'start' );
	} );

	it( 'formats an explicit cursor as <segment>:<offset>', () => {
		expect(
			stepPosition( link( null ), 'firehose.p0', {
				'firehose.p0': { segment: 4, offset: 128 },
			} )
		).toBe( '4:128' );
	} );

	it( 'falls back to the live resume position with no pending seek', () => {
		expect(
			stepPosition(
				link( { 'firehose.p0': { segment: 7, offset: 42 } } ),
				'firehose.p0',
				null
			)
		).toBe( '7:42' );
	} );

	it( 'returns null when there is no cursor at all', () => {
		expect( stepPosition( link( null ), 'firehose.p0', null ) ).toBeNull();
	} );
} );

/**
 * The derived `positions` was the module's headline product and NO consumer
 * read it — structurally, not by oversight: `browseSegment( id )` calls
 * `setSegmentId`, so the new positions only exist on the NEXT render, while
 * every call site needs the seed in the SAME tick to hand to `seek()`. All
 * three therefore set the state, discarded its product, and recomputed the
 * identical object from the click argument.
 *
 * The actions now RETURN what they compute. `mode` went with it: it was a
 * second state machine over `SeekTracker.mode`'s concept with a divergent
 * vocabulary ('browse' vs 'replay'), and all three consumers display the
 * view's, not this one.
 */
describe( 'the actions return the seed they compute', () => {
	it( 'browseSegment returns that segment position', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.browseSegment( 7 );
		} );
		expect( seed ).toEqual( {
			'firehose.p0': { segment: 7, offset: 0 },
		} );
		expect( result.current.segmentId ).toBe( 7 );
	} );

	it( 'replay returns the start token', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'firehose.p0': 'start' } );
		expect( result.current.segmentId ).toBe( 'start' );
	} );

	it( 'follow returns null — the absent seek IS the tail', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.follow();
		} );
		expect( seed ).toBe( null );
		expect( result.current.segmentId ).toBe( null );
	} );

	it( 'no longer publishes a second mode, nor dead surface', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		expect( Object.keys( result.current ).sort() ).toEqual( [
			'browseSegment',
			'follow',
			'replay',
			'segmentId',
		] );
	} );
} );

/**
 * The whole browse controller both log-stream dashboards drive: the rail's
 * maintenance, the four seek intents, and the rail itself. The Partition Viewer
 * and the Log Viewer each wrote all three out longhand, identically.
 */
describe( 'useSegmentBrowse', () => {
	const SUB = 'quartz.p7';
	const SEGMENTS = [ { id: 41, size: 2048 } ];
	// A segmented source carries `segments`; a file source carries `bytes`.
	const SOURCE = { segments: SEGMENTS, bytes: 8191 };

	function browse( overrides = {} ) {
		const calls = {
			seek: jest.fn(),
			setPaused: jest.fn(),
			step: jest.fn(),
			refresh: jest.fn(),
		};
		const props = {
			sub: SUB,
			source: SOURCE,
			railName: 'quartz:refresh',
			mode: 'replay',
			lastReceivedSegment: null,
			...calls,
			...overrides,
		};
		const view = renderHook( ( p ) => useSegmentBrowse( p ), {
			initialProps: props,
		} );
		return { ...view, ...calls, props };
	}

	it( 'renders the segment rail: the segments, their labels and sizes', () => {
		const { result } = browse();
		const rail = result.current.sidebar.props;
		expect( rail.items ).toBe( SEGMENTS );
		expect( rail.title ).toBe( 'Segments' );
		expect( rail.itemKey( SEGMENTS[ 0 ] ) ).toBe( 41 );
		expect( rail.itemLabel( SEGMENTS[ 0 ] ) ).toBe( 'Segment 41' );
		expect( rail.itemMeta( SEGMENTS[ 0 ] ) ).toBe( '2 KB' );
	} );

	it( 'highlights the received segment over the clicked one', () => {
		const { result } = browse( { lastReceivedSegment: 77 } );
		expect( result.current.sidebar.props.mode ).toBe( 'replay' );
		expect( result.current.sidebar.props.activeKey ).toBe( 77 );
	} );

	it( 'browsing a segment pauses and seeks it, carrying the source row', () => {
		const { result, seek, setPaused } = browse();
		act( () => result.current.sidebar.props.onSelectItem( SEGMENTS[ 0 ] ) );
		expect( setPaused ).toHaveBeenCalledWith( true );
		expect( seek ).toHaveBeenCalledWith(
			SUB,
			{ [ SUB ]: { segment: 41, offset: 0 } },
			SOURCE
		);
		expect( result.current.sidebar.props.selectedKey ).toBe( 41 );
	} );

	it( 'Replay seeks start with the boundary; Live drops the positions', () => {
		const { result, seek } = browse();
		act( () => result.current.sidebar.props.onReplay() );
		expect( seek ).toHaveBeenCalledWith(
			SUB,
			{ [ SUB ]: 'start' },
			SOURCE
		);
		act( () => result.current.sidebar.props.onFollow() );
		expect( seek.mock.lastCall.slice( 0, 2 ) ).toEqual( [ SUB, null ] );
	} );

	it( 'a pasted message ID pauses, seeks that offset and steps it', () => {
		const { result, seek, setPaused, step } = browse();
		act( () => result.current.jump( '41:8191:12' ) );
		expect( setPaused ).toHaveBeenCalledWith( true );
		expect( seek ).toHaveBeenCalledWith(
			SUB,
			{ [ SUB ]: { segment: 41, offset: 8191 } },
			SOURCE
		);
		expect( step ).toHaveBeenCalled();
	} );

	it( 'a bare offset lands in the last-received segment', () => {
		const { result, seek } = browse( { lastReceivedSegment: 77 } );
		act( () => result.current.jump( '8191' ) );
		expect( seek ).toHaveBeenCalledWith(
			SUB,
			{ [ SUB ]: { segment: 77, offset: 8191 } },
			SOURCE
		);
	} );

	it( 'garbage in the offset input seeks nothing', () => {
		const { result, seek, setPaused } = browse();
		act( () => result.current.jump( 'nonsense-9x' ) );
		expect( seek ).not.toHaveBeenCalled();
		expect( setPaused ).not.toHaveBeenCalled();
	} );

	// An empty `sub` is the whole-glob view: there is no dir to seek within,
	// and seeking one would point the stream at an empty subscription.
	// The rail renders before a dir is picked, so Live/Replay are clickable
	// then; a seek into '' would point the stream at an empty subscription.
	it( 'seeks nothing while no subscription is selected', () => {
		const { result, seek, setPaused } = browse( { sub: '' } );
		act( () => result.current.sidebar.props.onFollow() );
		act( () => result.current.sidebar.props.onReplay() );
		act( () => result.current.sidebar.props.onSelectItem( { id: 41 } ) );
		act( () => result.current.jump( '7:120' ) );
		expect( seek ).not.toHaveBeenCalled();
		expect( setPaused ).not.toHaveBeenCalled();
	} );

	it( 'a record from an unknown segment re-catalogs once, not in a loop', () => {
		const { rerender, refresh, props } = browse();
		expect( refresh ).not.toHaveBeenCalled();
		rerender( { ...props, lastReceivedSegment: 77 } );
		expect( refresh ).toHaveBeenCalledTimes( 1 );
		rerender( { ...props, lastReceivedSegment: 77 } );
		expect( refresh ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'a record from a listed segment leaves the rail alone', () => {
		const { refresh } = browse( { lastReceivedSegment: 41 } );
		expect( refresh ).not.toHaveBeenCalled();
	} );
} );

describe( 'useLogStatusSegments', () => {
	const DIR = 'quartz.p7';
	const RAIL = [ { id: 41, size: 2048 } ];

	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	} );

	it( 'resolves the rail for the selected dir', async () => {
		const wire = installFakeCommandWire( ( m ) =>
			'log_status' === m[ VALUE ]?.name ? { segments: RAIL } : null
		);
		const { result } = renderHook( ( p ) => useLogStatusSegments( p ), {
			initialProps: { sub: DIR, scope: 'quartz:status' },
		} );
		await waitFor( () =>
			expect( result.current.source.segments ).toEqual( RAIL )
		);
		// Addressed to the CI that owns the verb, and about the dir it names.
		const asked = wire.batches
			.flat()
			.find( ( m ) => 'log_status' === m[ VALUE ]?.name );
		expect( asked[ TO ] ).toBe( 'raw-logs' );
		expect( asked[ VALUE ].arguments ).toEqual( [ DIR ] );
	} );

	it( 'asks about the dir it is on, and nothing while none is selected', async () => {
		const asked = [];
		installFakeCommandWire( ( m ) => {
			if ( 'log_status' === m[ VALUE ]?.name ) {
				asked.push( m[ VALUE ].arguments );
			}
			return { segments: RAIL };
		} );
		const { rerender } = renderHook( ( p ) => useLogStatusSegments( p ), {
			initialProps: { sub: '', scope: 'quartz:status' },
		} );
		await act( async () => {} );
		expect( asked ).toEqual( [] );
		await act( async () =>
			rerender( { sub: DIR, scope: 'quartz:status' } )
		);
		await waitFor( () => expect( asked ).toEqual( [ [ DIR ] ] ) );
	} );

	// A `source` whose identity changed every render re-ran every effect that
	// took it, which is a render loop one dependency away.
	it( 'keeps one source identity while the rail has not moved', async () => {
		installFakeCommandWire( () => ( { segments: RAIL } ) );
		const { result, rerender } = renderHook(
			( p ) => useLogStatusSegments( p ),
			{ initialProps: { sub: DIR, scope: 'quartz:status' } }
		);
		await waitFor( () =>
			expect( result.current.source.segments ).toEqual( RAIL )
		);
		const first = result.current.source;
		await act( async () =>
			rerender( { sub: DIR, scope: 'quartz:status' } )
		);
		expect( result.current.source ).toBe( first );
	} );

	// A refusal must CLEAR the rail, not leave the last dir's segments under a
	// new one; seeded so the assertion cannot hold on the initial state.
	it( 'a refused answer leaves the rail empty', async () => {
		let refuse = false;
		installFakeCommandWire( ( m ) => {
			if ( 'log_status' !== m[ VALUE ]?.name ) {
				return null;
			}
			return refuse ? new Error( 'nope' ) : { segments: RAIL };
		} );
		const { result, rerender } = renderHook(
			( p ) => useLogStatusSegments( p ),
			{ initialProps: { sub: DIR, scope: 'quartz:status' } }
		);
		await waitFor( () =>
			expect( result.current.source.segments ).toEqual( RAIL )
		);
		refuse = true;
		await act( async () =>
			rerender( { sub: 'quartz.p8', scope: 'quartz:status' } )
		);
		await act( async () => result.current.refresh() );
		expect( result.current.source.segments ).toEqual( [] );
	} );

	it( 'deselecting empties the rail', async () => {
		installFakeCommandWire( () => ( { segments: RAIL } ) );
		const { result, rerender } = renderHook(
			( p ) => useLogStatusSegments( p ),
			{ initialProps: { sub: DIR, scope: 'quartz:status' } }
		);
		await waitFor( () =>
			expect( result.current.source.segments ).toEqual( RAIL )
		);
		await act( async () =>
			rerender( { sub: '', scope: 'quartz:status' } )
		);
		expect( result.current.source.segments ).toEqual( [] );
	} );
} );
