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

registerSource( 'nodes/marsh-7872', {
	kind: 'derived',
	from: [ 'nodes/pukeko-7870', 'nodes/kahu-7871' ],
	derive: ( [ pukeko, kahu ] ) => ( {
		joined: `${ pukeko.roost } over ${ kahu.thermal }`,
	} ),
} );

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
	replies = {
		graze: { roost: 'raupo' },
		soar: { thermal: 'Ruapehu' },
	};
	wire = installFakeCommandWire( ( m ) =>
		m[ VALUE ].name in replies ? replies[ m[ VALUE ].name ] : null
	);
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
