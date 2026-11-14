/* eslint-env jest */
/**
 * A stream source over a glob that declares `browse`: its readers get the
 * glob's partition picker, and once one dir is picked the segment rail, the
 * offset jump and the paused step; and a stream that declares a `cadence`
 * page-state key sends its view a `snapshot` control at the milliseconds the
 * key holds.
 */

import { act, render, waitFor } from '@testing-library/react';
import { Core, Node, ReactBridge, VALUE } from '@newspack-nodes/runtime';
import { isControl } from '@newspack-nodes/shared/helpers/controlMsg';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import {
	definePageState,
	usePageState,
} from '../../composition/page/pageState';
import { registerSource, SourcesProvider, useSource } from '..';

/** The glob, distinct from every real log's. */
const GLOB = 'pipit.*';

/** A view recording the controls it is sent, by their origin. */
class PipitViewNode extends ReactBridge( Node ) {
	constructor() {
		super();
		this.controlFrom = '';
		this.controls = [];
	}
	fill( message ) {
		if ( isControl( this, message ) ) {
			this.controls.push( message[ VALUE ] );
		}
	}
	last( action ) {
		return [ ...this.controls ]
			.reverse()
			.find( ( one ) => action === one.action );
	}
}

registerSource( 'pipit-7950', {
	kind: 'stream',
	group: 'alpine-7950',
	subscribe: () => GLOB,
	viewClass: PipitViewNode,
	mode: 'follow',
	browse: true,
} );

registerSource( 'piwakawaka-7951', {
	kind: 'stream',
	subscribe: () => 'piwakawaka.p1',
	viewClass: PipitViewNode,
	mode: 'follow',
	cadence: 'beat',
} );

const PageState = definePageState( { beat: { default: '3000' } } );

const MIXED = [
	{ key: 'pipit.p0', label: 'pipit.p0' },
	{ key: 'pipit.p3', label: 'pipit.p3' },
	{ key: 'completed.p0', label: 'completed.p0' },
];

class FakeEventSource {
	addEventListener() {}
	close() {}
}

let clock;
let wire;
let stream;

beforeEach( () => {
	Core.reset();
	clock = steppedClock();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	global.EventSource = FakeEventSource;
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
	stream = null;
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

/** Reads the browsed source, keeping what it hands its readers. */
function Reader() {
	stream = useSource( 'pipit-7950' ).stream;
	return null;
}

/**
 * Mount a reader of the browsed source against a catalog and a footprint.
 *
 * @param {Array}  catalog  What `list_logs` answers.
 * @param {Object} [answer] What `dump_log` answers.
 */
async function browse(
	catalog,
	answer = { segments: [ { id: 79, size: 512 } ] }
) {
	wire = installFakeCommandWire( ( m ) => {
		const verb = m[ VALUE ]?.name;
		if ( 'list_logs' === verb ) {
			return catalog;
		}
		return 'dump_log' === verb ? answer : null;
	} );
	render(
		<SourcesProvider>
			<Reader />
		</SourcesProvider>
	);
	await clock.tick( 1 );
	await clock.tick( 1 );
}

/** The browsed source's view. */
const view = () => stream.node();

/** What the page's stream is subscribed to; this source rides alone. */
const subscribedTo = () => Core.node( '_stream' ).sseIn.subscribe;

describe( 'a browsed stream', () => {
	it( 'offers the glob’s dirs under an All row, and starts on the glob', async () => {
		await browse( MIXED );
		expect( stream.browse.pickerOptions ).toEqual( [
			{ key: '', label: 'All partitions (live)' },
			{ key: 'pipit.p0', label: 'pipit.p0' },
			{ key: 'pipit.p3', label: 'pipit.p3' },
		] );
		expect( stream.browse.selectedPartition ).toBe( '' );
		expect( subscribedTo() ).toEqual( [ GLOB ] );
		expect( Core.node( 'alpine-7950:shell' ).counter ).toBeGreaterThan( 0 );
	} );

	it( 'has no rail, jump or step across the whole glob', async () => {
		await browse( MIXED );
		expect( stream.browse.sidebar ).toBeNull();
		expect( stream.browse.jump ).toBeUndefined();
		expect( stream.step ).toBeUndefined();
	} );

	it( 'narrows to a picked dir, telling the view, and brings the rail, jump and step', async () => {
		await browse( MIXED );
		await act( async () => stream.browse.selectPartition( 'pipit.p3' ) );
		expect( subscribedTo() ).toEqual( [ 'pipit.p3' ] );
		expect( view().last( 'select' ) ).toEqual( {
			action: 'select',
			dir: 'pipit.p3',
		} );
		expect( stream.browse.sidebar ).not.toBeNull();
		expect( typeof stream.browse.jump ).toBe( 'function' );
		expect( typeof stream.step ).toBe( 'function' );
	} );

	it( 'widens back to the glob on the All row', async () => {
		await browse( MIXED );
		await act( async () => stream.browse.selectPartition( 'pipit.p3' ) );
		await act( async () => stream.browse.selectPartition( '' ) );
		expect( subscribedTo() ).toEqual( [ GLOB ] );
	} );

	it( 'auto-selects a sole dir, which is the whole live glob', async () => {
		await browse( [ { key: 'pipit.p0', label: 'pipit.p0' } ] );
		await waitFor( () =>
			expect( stream.browse.selectedPartition ).toBe( 'pipit.p0' )
		);
		expect( stream.browse.pickerOptions ).toEqual( [
			{ key: 'pipit.p0', label: 'pipit.p0' },
		] );
		expect( subscribedTo() ).toEqual( [ 'pipit.p0' ] );
	} );

	it( 'fills the picked dir’s rail from its footprint', async () => {
		await browse( MIXED, { segments: [ { id: 7952, size: 640 } ] } );
		await act( async () => stream.browse.selectPartition( 'pipit.p0' ) );
		await clock.tick( 1 );
		const rail = render( stream.browse.sidebar );
		await waitFor( () =>
			expect( rail.container.textContent ).toContain( 'Segment 7952' )
		);
		const dumped = wire.batches
			.flat()
			.filter( ( m ) => 'dump_log' === m[ VALUE ]?.name )
			.map( ( m ) => m[ VALUE ].arguments );
		expect( dumped ).toContainEqual( [ 'pipit.p0' ] );
	} );

	it( 'hands its readers one browse model across a render that moves none of it', async () => {
		await browse( MIXED );
		await act( async () => stream.browse.selectPartition( 'pipit.p3' ) );
		await clock.tick( 1 );
		const before = stream.browse;
		await act( async () =>
			view().setField( 'view', {
				mode: 'live',
				lastReceivedSegment: null,
			} )
		);
		expect( stream.browse ).toBe( before );
	} );

	it( 'leaves the picker empty on a refused catalog', async () => {
		wire = installFakeCommandWire( () => new Error( 'list_logs' ) );
		render(
			<SourcesProvider>
				<Reader />
			</SourcesProvider>
		);
		await clock.tick( 1 );
		expect( stream.browse.pickerOptions ).toEqual( [] );
	} );
} );

describe( 'a stream on a cadence', () => {
	/** Reads the cadenced source, and holds a setter for its key. */
	let setBeat;
	function Beat() {
		stream = useSource( 'piwakawaka-7951' ).stream;
		setBeat = usePageState( 'beat', { writes: true } )[ 1 ];
		return null;
	}

	/**
	 * The snapshots the view was sent over `seconds` one-second ticks.
	 *
	 * @param {number} seconds How long.
	 * @return {Promise<number>} How many.
	 */
	async function snapshotsOver( seconds ) {
		const before = view().controls.filter(
			( one ) => 'snapshot' === one.action
		).length;
		for ( let at = 0; at < seconds; at++ ) {
			await clock.tick( 1 );
		}
		return (
			view().controls.filter( ( one ) => 'snapshot' === one.action )
				.length - before
		);
	}

	it( 'sends its view a snapshot at the milliseconds its key holds, and moves with the key', async () => {
		installFakeCommandWire( () => null );
		render(
			<PageState>
				<SourcesProvider>
					<Beat />
				</SourcesProvider>
			</PageState>
		);
		expect(
			view().controls.filter( ( one ) => 'snapshot' === one.action )
		).toHaveLength( 1 );
		await clock.tick( 1 );
		// Past that first, the timer waits out an interval from the next boundary.
		expect( await snapshotsOver( 9 ) ).toBe( 2 );

		await act( async () => setBeat( '1000' ) );
		await clock.tick( 1 );
		expect( await snapshotsOver( 6 ) ).toBe( 6 );
	} );
} );
