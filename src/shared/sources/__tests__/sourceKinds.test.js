/* eslint-env jest */
/**
 * What a page's own sources ask of the registry beyond B1's three kinds: a
 * name namespaced by `/`, a poll over a view class with a transform node on
 * its edge, refreshed off its cadence, at its declared interval, a
 * derived source reading other sources, so a model joined from several is
 * declared once and every block reading it shares the inputs' fetches, and
 * a hold that keeps every source still, as a row drag needs.
 */

import { render, screen, act } from '@testing-library/react';
import {
	Core,
	TO,
	VALUE,
	TYPE,
	FROM,
	TM_STRUCT,
} from '@newspack-nodes/runtime';
import { newMessage } from '../../../runtime/message';
import { Node } from '../../../runtime/node';
import { SliceViewNode } from '../../nodes/slice-view-node';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import {
	registerSource,
	useSource,
	useSourcesPaused,
	SourcesProvider,
} from '..';
import * as registry from '../registry';

/** The view the pukeko poll lands on, holding the transform's model. */
class PukekoViewNode extends SliceViewNode {
	fill( message ) {
		this.counter += 1;
		if ( 'model' === message[ VALUE ]?.action ) {
			this.setField( 'view', message[ VALUE ].model );
		}
	}
	emptySlice() {
		return { roost: null, error: null, loading: true };
	}
}

/** The edge between the receiver and the view, joining a running total. */
class PukekoTransformNode extends Node {
	constructor() {
		super();
		this.seen = 0;
	}
	fill( message ) {
		this.counter += 1;
		if ( 'graze' !== message[ VALUE ]?.name ) {
			return;
		}
		this.seen += 1;
		const out = newMessage();
		out[ TYPE ] = TM_STRUCT;
		out[ FROM ] = this.name;
		out[ TO ] = this.target;
		out[ VALUE ] = {
			action: 'model',
			model: {
				roost: `${ message[ VALUE ].payload.roost } #${ this.seen }`,
				error: null,
				loading: false,
			},
		};
		this.sink.fill( out );
	}
}

registerSource( 'nodes/pukeko-7870', {
	kind: 'poll',
	group: 'swamp-7870',
	ci: 'reed-7870',
	command: 'graze',
	viewClass: PukekoViewNode,
	transformClass: PukekoTransformNode,
	intervalMs: 60000,
} );

registerSource( 'nodes/kahu-7871', {
	kind: 'poll',
	group: 'swamp-7871',
	ci: 'reed-7871',
	command: 'soar',
	args: () => [],
	intervalMs: 9000,
} );

registerSource( 'nodes/ruru-7873', {
	kind: 'poll',
	group: 'swamp-7873',
	ci: 'reed-7873',
	command: 'hoot',
	args: () => [],
	intervalMs: 1000,
} );

registerSource( 'nodes/ruru-7874', {
	kind: 'poll',
	group: 'swamp-7874',
	ci: 'reed-7874',
	command: 'screech',
	args: () => [],
	intervalMs: 1000,
	retry: false,
} );

registerSource( 'nodes/kereru-7876', {
	kind: 'poll',
	group: 'canopy-7876',
	ci: 'reed-7876',
	command: 'perch',
	args: ( { tree } ) => ( tree ? [ tree ] : null ),
	transform: ( answer ) => answer,
	scope: ( { forest } ) => forest,
	params: [ 'tree', 'forest' ],
	intervalMs: 60000,
} );

registerSource( 'nodes/marsh-7872', {
	kind: 'derived',
	from: [ 'nodes/pukeko-7870', 'nodes/kahu-7871' ],
	derive: ( [ pukeko, kahu ] ) => ( {
		joined: `${ pukeko.roost } over ${ kahu.thermal }`,
	} ),
} );

/** Each tree's answer to `perch`; one left out goes unanswered. */
let perches = {};

/** The commands the server routes onward and never answers. */
const UNANSWERED = new Set( [ 'hoot', 'screech' ] );

let wire;
let clock;
let replies;

/**
 * Every command of one verb the wire carried.
 *
 * @param {string} verb The verb.
 * @return {Array} The commands.
 */
const sent = ( verb ) =>
	wire.batches.flat().filter( ( m ) => verb === m[ VALUE ]?.name );

beforeEach( () => {
	Core.reset();
	clock = steppedClock();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	perches = { 'miro-7876': { birds: 7 }, 'tawa-7876': { birds: 11 } };
	replies = {
		graze: { roost: 'raupo' },
		soar: { thermal: 'Ruapehu' },
	};
	wire = installFakeCommandWire( ( m ) => {
		if ( UNANSWERED.has( m[ VALUE ].name ) ) {
			return undefined;
		}
		if ( 'perch' === m[ VALUE ].name ) {
			return perches[ m[ VALUE ].arguments[ 0 ] ];
		}
		return m[ VALUE ].name in replies ? replies[ m[ VALUE ].name ] : null;
	} );
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

function Roost( { onState } ) {
	const state = useSource( 'nodes/pukeko-7870' );
	onState?.( state );
	return <p>{ state.model?.roost ?? 'waiting' }</p>;
}

function Marsh() {
	const { model, loading, error } = useSource( 'nodes/marsh-7872' );
	if ( error ) {
		return <p>{ `refused: ${ error }` }</p>;
	}
	return <p>{ loading ? 'marsh waiting' : model.joined }</p>;
}

describe( 'a source name namespaced by /', () => {
	it( 'names its nodes with : in place of /, so no path splits', async () => {
		render(
			<SourcesProvider>
				<Roost />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1' );
		const names = [ ...Core.nodes.keys() ].filter( ( name ) =>
			name.startsWith( 'nodes:pukeko-7870:' )
		);
		expect( names.length ).toBeGreaterThan( 0 );
		expect( names.some( ( name ) => name.includes( '/' ) ) ).toBe( false );
	} );
} );

describe( 'a poll over a view class', () => {
	it( 'puts its transform on the edge and shows the view’s model', async () => {
		render(
			<SourcesProvider>
				<Roost />
			</SourcesProvider>
		);
		expect( await screen.findByText( 'raupo #1' ) ).toBeTruthy();
		const transforms = [ ...Core.nodes.values() ].filter(
			( node ) => node instanceof PukekoTransformNode
		);
		expect( transforms ).toHaveLength( 1 );
	} );

	it( 'polls at its declared interval', async () => {
		render(
			<SourcesProvider>
				<Roost />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1' );
		await clock.tick( 7 );
		expect( sent( 'graze' ) ).toHaveLength( 1 );
		await clock.tick( 40 );
		expect( sent( 'graze' ) ).toHaveLength( 2 );
	} );

	it( 'asks again at once on refresh()', async () => {
		let state;
		render(
			<SourcesProvider>
				<Roost onState={ ( one ) => ( state = one ) } />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1' );
		replies.graze = { roost: 'harakeke' };
		await act( async () => state.refresh() );
		expect( await screen.findByText( 'harakeke #2' ) ).toBeTruthy();
	} );
} );

describe( 'a poll whose answer never comes', () => {
	/**
	 * Read one source and show nothing.
	 *
	 * @param {{name: string}} props The source.
	 * @return {null} Nothing.
	 */
	function Waits( { name } ) {
		useSource( name );
		return null;
	}

	it( "asks again once the Fetcher's retry window has passed", async () => {
		render(
			<SourcesProvider>
				<Waits name="nodes/ruru-7873" />
			</SourcesProvider>
		);
		await clock.tick( 1 );
		await clock.tick( 20 );
		await clock.tick( 1 );
		expect( sent( 'hoot' ).length ).toBeGreaterThan( 1 );
	} );

	it( 'asks once when it declares retry: false', async () => {
		render(
			<SourcesProvider>
				<Waits name="nodes/ruru-7874" />
			</SourcesProvider>
		);
		await clock.tick( 1 );
		await clock.tick( 20 );
		await clock.tick( 1 );
		expect( sent( 'screech' ) ).toHaveLength( 1 );
	} );
} );

describe( 'a derived source', () => {
	it( 'shows what it derives from its inputs once each has answered', async () => {
		render(
			<SourcesProvider>
				<Marsh />
			</SourcesProvider>
		);
		expect(
			await screen.findByText( 'raupo #1 over Ruapehu' )
		).toBeTruthy();
	} );

	it( 'shares its inputs’ fetches with a block reading one directly', async () => {
		render(
			<SourcesProvider>
				<Marsh />
				<Roost />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1 over Ruapehu' );
		expect( screen.getByText( 'raupo #1' ) ).toBeTruthy();
		expect( sent( 'graze' ) ).toHaveLength( 1 );
		expect( sent( 'soar' ) ).toHaveLength( 1 );
	} );

	it( 'waits while an input has not answered', async () => {
		replies = { graze: { roost: 'raupo' } };
		render(
			<SourcesProvider>
				<Marsh />
			</SourcesProvider>
		);
		await screen.findByText( 'marsh waiting' );
		await act( async () => {} );
		expect( screen.getByText( 'marsh waiting' ) ).toBeTruthy();
	} );
} );

/**
 * Holds the page's sources still while `held`, as a row drag does.
 *
 * @param {{held: boolean}} props Whether it holds them.
 * @return {null} Nothing.
 */
function Hold( { held } ) {
	useSourcesPaused( held );
	return null;
}

describe( 'sources held still', () => {
	it( 'asks nothing and shows nothing new while a hold stands, then asks at once', async () => {
		const { rerender } = render(
			<SourcesProvider>
				<Roost />
				<Hold held={ false } />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1' );
		rerender(
			<SourcesProvider>
				<Roost />
				<Hold held />
			</SourcesProvider>
		);
		replies.graze = { roost: 'harakeke' };
		await clock.tick( 13 );
		expect( sent( 'graze' ) ).toHaveLength( 1 );
		expect( screen.getByText( 'raupo #1' ) ).toBeTruthy();

		rerender(
			<SourcesProvider>
				<Roost />
				<Hold held={ false } />
			</SourcesProvider>
		);
		expect( await screen.findByText( 'harakeke #2' ) ).toBeTruthy();
		expect( sent( 'graze' ) ).toHaveLength( 2 );
	} );

	it( 'keeps a derived model still while a hold stands', async () => {
		const { rerender } = render(
			<SourcesProvider>
				<Marsh />
				<Hold held={ false } />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1 over Ruapehu' );
		rerender(
			<SourcesProvider>
				<Marsh />
				<Hold held />
			</SourcesProvider>
		);
		await clock.tick( 13 );
		expect( sent( 'graze' ) ).toHaveLength( 1 );
		expect( sent( 'soar' ) ).toHaveLength( 1 );
		expect( screen.getByText( 'raupo #1 over Ruapehu' ) ).toBeTruthy();
	} );
} );

/**
 * Reads the kereru poll under one tree in one forest, and shows its birds.
 *
 * @param {{tree: ?string, forest: string, onState?: Function}} props The params.
 * @return {import('react').ReactElement} The count.
 */
function Perch( { tree, forest, onState } ) {
	const state = useSource( 'nodes/kereru-7876', { tree, forest } );
	onState?.( state );
	return <p>{ state.model ? `birds ${ state.model.birds }` : 'no birds' }</p>;
}

describe( 'a poll whose params change', () => {
	it( 'shows its last model, stale, until the new key answers', async () => {
		let state;
		const { rerender } = render(
			<SourcesProvider>
				<Perch tree="miro-7876" forest="waipoua-7876" />
			</SourcesProvider>
		);
		await screen.findByText( 'birds 7' );
		delete perches[ 'tawa-7876' ];
		rerender(
			<SourcesProvider>
				<Perch
					tree="tawa-7876"
					forest="waipoua-7876"
					onState={ ( one ) => ( state = one ) }
				/>
			</SourcesProvider>
		);
		await clock.tick( 2 );
		expect( screen.getByText( 'birds 7' ) ).toBeTruthy();
		expect( state ).toMatchObject( { stale: true, loading: true } );
	} );

	it( 'shows the new key once it answers, no longer stale', async () => {
		let state;
		const { rerender } = render(
			<SourcesProvider>
				<Perch tree="miro-7876" forest="waipoua-7876" />
			</SourcesProvider>
		);
		await screen.findByText( 'birds 7' );
		rerender(
			<SourcesProvider>
				<Perch
					tree="tawa-7876"
					forest="waipoua-7876"
					onState={ ( one ) => ( state = one ) }
				/>
			</SourcesProvider>
		);
		await screen.findByText( 'birds 11' );
		expect( state.stale ).toBe( false );
	} );

	it( 'shows nothing of another scope while the new key loads', async () => {
		const { rerender } = render(
			<SourcesProvider>
				<Perch tree="miro-7876" forest="waipoua-7876" />
			</SourcesProvider>
		);
		await screen.findByText( 'birds 7' );
		delete perches[ 'tawa-7876' ];
		rerender(
			<SourcesProvider>
				<Perch tree="tawa-7876" forest="pureora-7876" />
			</SourcesProvider>
		);
		await clock.tick( 2 );
		expect( screen.getByText( 'no birds' ) ).toBeTruthy();
	} );

	it( 'asks nothing for a key its args answer null for', async () => {
		render(
			<SourcesProvider>
				<Perch tree={ null } forest="waipoua-7876" />
			</SourcesProvider>
		);
		await clock.tick( 2 );
		await clock.tick( 61 );
		expect( sent( 'perch' ) ).toHaveLength( 0 );
	} );
} );

/**
 * Holds one group's sources still while `held`.
 *
 * @param {{held: boolean, groups: string[]}} props What it holds, and whether.
 * @return {null} Nothing.
 */
function HoldGroups( { held, groups } ) {
	useSourcesPaused( held, groups );
	return null;
}

describe( 'one group held still', () => {
	it( 'asks nothing of the group it holds and leaves the others asking', async () => {
		render(
			<SourcesProvider>
				<Roost />
				<Perch tree="miro-7876" forest="waipoua-7876" />
				<HoldGroups held groups={ [ 'canopy-7876' ] } />
			</SourcesProvider>
		);
		await screen.findByText( 'raupo #1' );
		const perched = sent( 'perch' ).length;
		const grazed = sent( 'graze' ).length;
		await clock.tick( 70 );
		await clock.tick( 61 );
		expect( sent( 'perch' ) ).toHaveLength( perched );
		expect( sent( 'graze' ).length ).toBeGreaterThan( grazed );
	} );

	it( 'holds nothing when it names no group', () => {
		const hold = jest.spyOn( registry, 'hold' );
		render(
			<SourcesProvider>
				<HoldGroups held groups={ [] } />
			</SourcesProvider>
		);
		expect( hold ).not.toHaveBeenCalled();
	} );

	it( 'asks the group again on the next tick once the hold ends', async () => {
		const page = ( held ) => (
			<SourcesProvider>
				<Perch tree="miro-7876" forest="waipoua-7876" />
				<HoldGroups held={ held } groups={ [ 'canopy-7876' ] } />
			</SourcesProvider>
		);
		const { rerender } = render( page( false ) );
		await screen.findByText( 'birds 7' );
		rerender( page( true ) );
		await clock.tick( 5 );
		const perched = sent( 'perch' ).length;
		perches[ 'miro-7876' ] = { birds: 13 };
		rerender( page( false ) );
		await clock.tick( 1 );
		expect( sent( 'perch' ) ).toHaveLength( perched + 1 );
		expect( await screen.findByText( 'birds 13' ) ).toBeTruthy();
	} );
} );

describe( 'a derived source whose params change', () => {
	it( 'shows its last model, stale, until the new key derives one', async () => {
		registerSource( 'nodes/forest-7877', {
			kind: 'derived',
			from: [ 'nodes/kereru-7876' ],
			params: [ 'tree', 'forest' ],
			derive: ( [ kereru ] ) => ( { flock: kereru?.birds ?? 0 } ),
		} );
		/**
		 * @param {{tree: string}} props The tree.
		 * @return {import('react').ReactElement} The flock.
		 */
		function Forest( { tree } ) {
			const { model } = useSource( 'nodes/forest-7877', {
				tree,
				forest: 'waipoua-7876',
			} );
			return <p>{ model ? `flock ${ model.flock }` : 'no flock' }</p>;
		}
		const { rerender } = render(
			<SourcesProvider>
				<Forest tree="miro-7876" />
			</SourcesProvider>
		);
		await screen.findByText( 'flock 7' );
		delete perches[ 'tawa-7876' ];
		rerender(
			<SourcesProvider>
				<Forest tree="tawa-7876" />
			</SourcesProvider>
		);
		await clock.tick( 2 );
		expect( screen.getByText( 'flock 7' ) ).toBeTruthy();
	} );
} );

describe( 'a derived source declaring no scope', () => {
	it( 'shows nothing of another input scope while the new key derives', async () => {
		registerSource( 'nodes/grove-7878', {
			kind: 'derived',
			from: [ 'nodes/kereru-7876' ],
			params: [ 'tree', 'forest' ],
			derive: ( [ kereru ] ) => ( { flock: kereru?.birds ?? 0 } ),
		} );
		/**
		 * @param {{tree: string, forest: string}} props The tree and forest.
		 * @return {import('react').ReactElement} The flock.
		 */
		function Grove( { tree, forest } ) {
			const { model } = useSource( 'nodes/grove-7878', { tree, forest } );
			return <p>{ model ? `grove ${ model.flock }` : 'no grove' }</p>;
		}
		const { rerender } = render(
			<SourcesProvider>
				<Grove tree="miro-7876" forest="waipoua-7876" />
			</SourcesProvider>
		);
		await screen.findByText( 'grove 7' );
		delete perches[ 'tawa-7876' ];
		rerender(
			<SourcesProvider>
				<Grove tree="tawa-7876" forest="pureora-7878" />
			</SourcesProvider>
		);
		await clock.tick( 2 );
		expect( screen.getByText( 'no grove' ) ).toBeTruthy();
	} );
} );
