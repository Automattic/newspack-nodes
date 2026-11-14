/* eslint-env jest */
/**
 * Sources: a declared name over a poll, a command or a stream, read through
 * `useSource( name, params )` under a `SourcesProvider`, so that every hook
 * on one key shares one live source, every key has its own, a late answer
 * never paints another key's model, a hidden tab quiets every kind, and the
 * last release takes the source's nodes away.
 */

import { render, screen, act, waitFor } from '@testing-library/react';
import { StrictMode } from '@wordpress/element';
import { Core, Node, TO, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import {
	declaredSources,
	registerSource,
	sourceDeclaration,
	useSource,
	SourcesProvider,
} from '..';

/** The poll source's cadence, distinct from every default. */
const KEA_MS = 7000;

registerSource( 'kea-7810', {
	kind: 'poll',
	group: 'alpine-7810',
	ci: 'tern-7810',
	command: 'roost',
	args: ( { perch } ) => [ `--perch=${ perch }` ],
	transform: ( answer, { perch } ) => ( {
		perch,
		height: answer.height,
	} ),
	intervalMs: KEA_MS,
} );

/** A stream view that takes the frames it is handed. */
class WekaViewNode extends Node {
	constructor() {
		super();
		this.controlFrom = '';
	}
	fill() {}
}

registerSource( 'weka-7811', {
	kind: 'stream',
	subscribe: ( { log } ) => `${ log }.p3`,
	viewClass: WekaViewNode,
	mode: 'follow',
} );

registerSource( 'kaka-7812', {
	kind: 'command',
	group: 'alpine-7812',
	ci: 'tern-7812',
	command: 'forage',
	args: ( { tree } ) => [ tree ],
} );

registerSource( 'takahe-7813', {
	kind: 'stream',
	subscribe: ( { log } ) => log,
	viewClass: WekaViewNode,
	mode: 'drift',
} );

registerSource( 'kiwi-7816', { kind: 'swoop' } );

/**
 * Formats a perch's height, one function for every declaration of it.
 *
 * @param {number} v The height.
 * @return {string} It, in metres.
 */
const metres = ( v ) => `${ v } m`;

/** The tieke's args, one function for every declaration of it. */
const silent = () => [];

/**
 * The tieke's declaration, built afresh on every call.
 *
 * @param {string} label The height's label.
 * @return {Object} The declaration.
 */
const tieke = ( label ) => ( {
	kind: 'command',
	group: 'alpine-7830',
	ci: 'tern-7830',
	command: 'sing',
	args: silent,
	params: [ 'grove' ],
	fields: { height: { label, kind: 'value', format: metres } },
} );

registerSource( 'tieke-7830', tieke( 'Song 7830' ) );

/** A stream view recording every message it is handed. */
class HihiViewNode extends Node {
	constructor() {
		super();
		this.controlFrom = '';
		this.filled = [];
	}
	fill( message ) {
		this.filled.push( message );
	}
}

registerSource( 'hihi-7831', {
	kind: 'stream',
	subscribe: ( { log } ) => `${ log }.p5`,
	viewClass: HihiViewNode,
	mode: 'follow',
} );

registerSource( 'ruru-7817', {
	kind: 'poll',
	group: 'alpine-7817',
	ci: 'tern-7817',
	command: 'hoot',
	args: ( { calls } ) => calls,
	intervalMs: KEA_MS,
} );

registerSource( 'kokako-7821', {
	kind: 'poll',
	group: 'alpine-7821',
	ci: 'tern-7821',
	command: 'chime',
	args: ( { bell } ) => {
		throw new Error( `no bell named ${ bell }` );
	},
	intervalMs: KEA_MS,
} );

let wire;
let clock;
let replyFor;

class FakeEventSource {
	constructor( url ) {
		this.url = url;
	}
	addEventListener() {}
	close() {}
}

/**
 * Hold the tab visible or hidden, as `usePageVisibility` reads it.
 *
 * @param {string} state `visible` or `hidden`.
 */
function setVisibility( state ) {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => state,
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );
}

beforeEach( () => {
	Core.reset();
	clock = steppedClock();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	global.EventSource = FakeEventSource;
	setVisibility( 'visible' );
	replyFor = ( m ) => {
		const [ token ] = m[ VALUE ].arguments ?? [];
		return { height: `${ token } at 41m` };
	};
	wire = installFakeCommandWire( ( m ) => replyFor( m ) );
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

/**
 * Render under one provider, and re-render under the same one.
 *
 * @param {import('react').ReactElement} ui The page.
 * @return {Object} What `render` answers, its `rerender` keeping the provider.
 */
function renderSources( ui ) {
	const result = render( <SourcesProvider>{ ui }</SourcesProvider> );
	return {
		...result,
		rerender: ( next ) =>
			result.rerender( <SourcesProvider>{ next }</SourcesProvider> ),
	};
}

/**
 * Every command of one verb the wire carried, as its tokens.
 *
 * @param {string} verb The verb.
 * @return {string[][]} One entry per command.
 */
const sent = ( verb ) =>
	wire.batches
		.flat()
		.filter( ( m ) => verb === m[ VALUE ]?.name )
		.map( ( m ) => m[ VALUE ].arguments ?? [] );

/**
 * The names of every node a source declared as `name` holds.
 *
 * @param {string} name The source.
 * @return {string[]} The node names.
 */
const nodesOf = ( name ) =>
	[ ...Core.nodes.keys() ].filter( ( node ) =>
		node.startsWith( `${ name }:` )
	);

/**
 * The views attached to one subscription on the page's link.
 *
 * @param {string} sub The subscription.
 * @return {string[]} The views' paths.
 */
const viewsOn = ( sub ) =>
	Core.node( '_stream' )?.tees.get( sub )?.target ?? [];

function Perch( { perch, label } ) {
	const { model, error, loading } = useSource( 'kea-7810', { perch } );
	if ( error ) {
		return <p>{ `${ label } refused: ${ error }` }</p>;
	}
	if ( loading ) {
		return <p>{ `${ label } loading` }</p>;
	}
	return <p>{ `${ label }: ${ model.perch } ${ model.height }` }</p>;
}

function Tail( { log } ) {
	useSource( 'weka-7811', { log } );
	return null;
}

function Forage( { tree, label } ) {
	const { model, loading } = useSource( 'kaka-7812', { tree } );
	return (
		<p>
			{ loading ? `${ label } loading` : `${ label }: ${ model.height }` }
		</p>
	);
}

describe( 'registerSource', () => {
	it( 'takes the same declaration twice', () => {
		const decl = {
			kind: 'command',
			group: 'alpine-7814',
			ci: 'tern-7814',
			command: 'nest',
			args: () => [],
		};
		registerSource( 'kakapo-7814', decl );
		expect( () =>
			registerSource( 'kakapo-7814', { ...decl } )
		).not.toThrow();
	} );

	it( 'takes an equal declaration again, its params and fields built afresh', () => {
		expect( () =>
			registerSource( 'tieke-7830', tieke( 'Song 7830' ) )
		).not.toThrow();
	} );

	it( 'refuses a declaration whose field reads otherwise', () => {
		expect( () =>
			registerSource( 'tieke-7830', tieke( 'Chorus 7830' ) )
		).toThrow( /source 'tieke-7830' is already declared/ );
	} );

	it.each( [
		[ 'cell', () => 'tui-7866' ],
		[ 'width', '97px' ],
		[ 'tooltip', 'Chorus height 7866' ],
		[ 'icon', 'location-alt' ],
		[ 'description', 'Chorus perches 7866' ],
	] )(
		'refuses a declaration whose field draws another %s',
		( part, value ) => {
			const declared = tieke( 'Song 7830' );
			expect( () =>
				registerSource( 'tieke-7830', {
					...declared,
					fields: {
						height: { ...declared.fields.height, [ part ]: value },
					},
				} )
			).toThrow( /source 'tieke-7830' is already declared/ );
		}
	);

	it( 'refuses a declaration whose label reads otherwise', () => {
		expect( () =>
			registerSource( 'tieke-7830', {
				...tieke( 'Song 7830' ),
				label: 'Saddleback 7865',
			} )
		).toThrow( /source 'tieke-7830' is already declared/ );
	} );

	it( 'refuses two fields of one kind sharing a label, naming both', () => {
		expect( () =>
			registerSource( 'piwakawaka-7866', {
				kind: 'command',
				fields: {
					fan: { label: 'Flit 7866', kind: 'value' },
					tail: { label: 'Flit 7866', kind: 'value' },
				},
			} )
		).toThrow(
			/piwakawaka-7866 fields 'fan' and 'tail' are both labelled 'Flit 7866'/
		);
	} );

	it( 'refuses a field declaring no kind it knows', () => {
		expect( () =>
			registerSource( 'kotare-7833', {
				kind: 'command',
				fields: { dive: { label: 'Dive 7833', kind: 'splash' } },
			} )
		).toThrow(
			/kotare-7833 field 'dive' declares no kind of value, series, line or rows/
		);
	} );

	it( 'refuses a second, different declaration under one name', () => {
		expect( () =>
			registerSource( 'kea-7810', {
				kind: 'poll',
				group: 'alpine-7810',
				ci: 'tern-7810',
				command: 'perch',
				args: () => [],
				intervalMs: KEA_MS,
			} )
		).toThrow( /kea-7810/ );
	} );

	it( 'refuses an empty name', () => {
		expect( () => registerSource( '', { kind: 'command' } ) ).toThrow(
			/a source is named by a string/
		);
	} );

	it( 'keeps each bundle’s declarations to that bundle', () => {
		const copies = [];
		for ( let n = 0; n < 2; n++ ) {
			jest.isolateModules( () => {
				copies.push( {
					fixture: require( './fixtures/tuiSource' ),
					registry: require( '../registry' ),
				} );
			} );
		}
		for ( const { fixture, registry } of copies ) {
			const entry = registry.acquire(
				registry.createSources(),
				'tui-7820',
				{}
			);
			expect( entry.decl ).toBe( fixture.TUI );
		}
		expect( copies[ 0 ].fixture.TUI ).not.toBe( copies[ 1 ].fixture.TUI );
	} );
} );

describe( 'sourceDeclaration', () => {
	it( 'answers what a name declares, its fields among it', () => {
		expect( sourceDeclaration( 'tieke-7830' ).fields ).toEqual( {
			height: { label: 'Song 7830', kind: 'value', format: metres },
		} );
	} );

	it( 'refuses a name nothing declares', () => {
		expect( () => sourceDeclaration( 'piopio-7832' ) ).toThrow(
			/no source is declared as 'piopio-7832'/
		);
	} );
} );

describe( 'declaredSources', () => {
	it( 'lists every name this bundle declares with its declaration', () => {
		const listed = new Map( declaredSources() );
		expect( listed.get( 'tieke-7830' ) ).toBe(
			sourceDeclaration( 'tieke-7830' )
		);
		expect( listed.has( 'kea-7810' ) ).toBe( true );
	} );
} );

describe( 'SourcesProvider', () => {
	it( 'is required above every reader, and says so', () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		expect( () => render( <Perch perch="rimu" label="one" /> ) ).toThrow(
			/useSource\( 'kea-7810' \).*SourcesProvider/
		);
	} );

	it( 'keeps a held source through StrictMode’s remount of its host', async () => {
		render(
			<StrictMode>
				<SourcesProvider>
					<Perch perch="matai" label="strict" />
				</SourcesProvider>
			</StrictMode>
		);

		expect(
			await screen.findByText( 'strict: matai --perch=matai at 41m' )
		).toBeTruthy();
		const prefixes = new Set(
			nodesOf( 'kea-7810' ).map( ( name ) =>
				name.split( ':' ).slice( 0, 2 ).join( ':' )
			)
		);
		expect( prefixes.size ).toBe( 1 );
	} );

	it( 'takes its sources down with its tree', async () => {
		const page = renderSources( <Perch perch="rimu" label="one" /> );
		await screen.findByText( 'one: rimu --perch=rimu at 41m' );
		expect( nodesOf( 'kea-7810' ).length ).toBeGreaterThan( 0 );

		page.unmount();

		expect( nodesOf( 'kea-7810' ) ).toEqual( [] );
		expect( Core.backboneMounts ).toHaveLength( 0 );
	} );
} );

describe( 'useSource on a poll', () => {
	it( 'shows the transformed answer to its own parameters', async () => {
		renderSources( <Perch perch="rimu" label="one" /> );
		expect(
			await screen.findByText( 'one: rimu --perch=rimu at 41m' )
		).toBeTruthy();
		expect( sent( 'roost' ) ).toEqual( [ [ '--perch=rimu' ] ] );
	} );

	it( 'sends one command per tick for two hooks on one key', async () => {
		renderSources(
			<>
				<Perch perch="rimu" label="one" />
				<Perch perch="rimu" label="two" />
			</>
		);
		await screen.findByText( 'two: rimu --perch=rimu at 41m' );
		expect( sent( 'roost' ) ).toHaveLength( 1 );

		await clock.tick( KEA_MS / 1000 );

		expect( sent( 'roost' ) ).toHaveLength( 2 );
	} );

	it( 'sends one command per key for two keys', async () => {
		renderSources(
			<>
				<Perch perch="rimu" label="one" />
				<Perch perch="totara" label="two" />
			</>
		);
		await screen.findByText( 'two: totara --perch=totara at 41m' );
		expect(
			screen.getByText( 'one: rimu --perch=rimu at 41m' )
		).toBeTruthy();
		expect( sent( 'roost' ) ).toEqual(
			expect.arrayContaining( [
				[ '--perch=rimu' ],
				[ '--perch=totara' ],
			] )
		);
		expect( sent( 'roost' ) ).toHaveLength( 2 );
	} );

	it( 'never paints a late answer to old parameters on the new key', async () => {
		let answerRimu;
		replyFor = ( m ) => {
			const [ token ] = m[ VALUE ].arguments;
			if ( '--perch=rimu' === token ) {
				return new Promise( ( resolve ) => {
					answerRimu = () => resolve( { height: 'late 9m' } );
				} );
			}
			return { height: `${ token } at 41m` };
		};
		const { rerender } = renderSources(
			<>
				<Perch perch="rimu" label="stays" />
				<Perch perch="rimu" label="moves" />
			</>
		);
		await waitFor( () => expect( answerRimu ).toBeDefined() );

		rerender(
			<>
				<Perch perch="rimu" label="stays" />
				<Perch perch="totara" label="moves" />
			</>
		);
		await screen.findByText( 'moves: totara --perch=totara at 41m' );

		await act( async () => answerRimu() );

		expect( await screen.findByText( 'stays: rimu late 9m' ) ).toBeTruthy();
		expect(
			screen.getByText( 'moves: totara --perch=totara at 41m' )
		).toBeTruthy();
	} );

	/**
	 * Hold the reply to `rimu` until the test lands it; answer the rest.
	 *
	 * @return {{land: () => void}} Lands the held reply, once it is owed.
	 */
	function holdRimu() {
		const held = {};
		replyFor = ( m ) => {
			const [ token ] = m[ VALUE ].arguments;
			if ( '--perch=rimu' === token ) {
				return new Promise( ( resolve ) => {
					held.land = () => resolve( { height: 'late 9m' } );
				} );
			}
			return { height: `${ token } at 41m` };
		};
		return held;
	}

	it( 'has the Router drop a late answer whose key lost its last holder', async () => {
		const held = holdRimu();
		const { rerender } = renderSources(
			<>
				<Perch perch="rimu" label="moves" />
				<Forage tree="rata" label="keeps the backbone up" />
			</>
		);
		await waitFor( () => expect( held.land ).toBeDefined() );
		const rimuNodes = nodesOf( 'kea-7810' );

		rerender(
			<>
				<Perch perch="totara" label="moves" />
				<Forage tree="rata" label="keeps the backbone up" />
			</>
		);
		await screen.findByText( 'moves: totara --perch=totara at 41m' );
		for ( const name of rimuNodes ) {
			expect( Core.node( name ) ).toBeNull();
		}
		const drop = jest.spyOn( Core.node( '_router' ), 'dropMessage' );
		const warn = jest
			.spyOn( console, 'warn' )
			.mockImplementation( () => {} );

		await act( async () => held.land() );

		expect( screen.queryByText( /late 9m/ ) ).toBeNull();
		expect(
			screen.getByText( 'moves: totara --perch=totara at 41m' )
		).toBeTruthy();
		expect( warn ).toHaveBeenCalledWith(
			expect.stringMatching(
				/_router: NOT_AVAILABLE - TM_COMMAND\|TM_RESPONSE .*to: kea-7810:\d+:in payload: roost --perch=rimu/
			)
		);
		const dropped = drop.mock.calls.filter(
			( [ message, why ] ) =>
				'NOT_AVAILABLE' === why && rimuNodes.includes( message[ TO ] )
		);
		expect( dropped ).toHaveLength( 1 );
	} );

	it( 'discards a late answer at `_http` when its source took the backbone with it', async () => {
		const held = holdRimu();
		const { rerender } = renderSources(
			<Perch perch="rimu" label="moves" />
		);
		await waitFor( () => expect( held.land ).toBeDefined() );
		const http = Core.node( '_http' );

		rerender( <Perch perch="totara" label="moves" /> );
		await screen.findByText( 'moves: totara --perch=totara at 41m' );
		expect( Core.node( '_http' ) ).not.toBe( http );
		const drop = jest.spyOn( Core.node( '_router' ), 'dropMessage' );

		await act( async () => held.land() );

		expect( screen.queryByText( /late 9m/ ) ).toBeNull();
		expect( drop ).not.toHaveBeenCalled();
		expect(
			screen.getByText( 'moves: totara --perch=totara at 41m' )
		).toBeTruthy();
	} );

	it( 'reuses its graph for a reader remounting in the same commit', async () => {
		const { rerender } = renderSources(
			<div>
				<Perch key="first" perch="rimu" label="one" />
			</div>
		);
		await screen.findByText( 'one: rimu --perch=rimu at 41m' );
		const held = nodesOf( 'kea-7810' );

		rerender(
			<div>
				<Perch key="second" perch="rimu" label="one" />
			</div>
		);
		await act( async () => {} );
		rerender(
			<section>
				<Perch key="second" perch="rimu" label="one" />
			</section>
		);
		await act( async () => {} );

		expect( sent( 'roost' ) ).toHaveLength( 1 );
		expect( nodesOf( 'kea-7810' ) ).toEqual( held );
		expect(
			screen.getByText( 'one: rimu --perch=rimu at 41m' )
		).toBeTruthy();
	} );

	it( 'removes its nodes and its group’s Tap on the last unmount, not before', async () => {
		const { rerender } = renderSources(
			<>
				<Perch perch="rimu" label="one" />
				<Perch perch="rimu" label="two" />
			</>
		);
		await screen.findByText( 'two: rimu --perch=rimu at 41m' );
		const held = nodesOf( 'kea-7810' );
		expect( held.length ).toBeGreaterThan( 0 );
		expect( Core.node( 'alpine-7810:shell' ) ).not.toBeNull();

		rerender( <Perch perch="rimu" label="two" /> );
		await act( async () => {} );
		expect( nodesOf( 'kea-7810' ) ).toEqual( held );

		rerender( <Forage tree="rata" label="other" /> );
		await act( async () => {} );
		expect( nodesOf( 'kea-7810' ) ).toEqual( [] );
		expect( Core.node( 'alpine-7810:shell' ) ).toBeNull();
		expect( Core.node( 'alpine-7812:shell' ) ).not.toBeNull();
	} );

	it( 'sends nothing while the tab is hidden', async () => {
		setVisibility( 'hidden' );
		renderSources( <Perch perch="rimu" label="one" /> );
		await act( async () => {} );
		await clock.tick( KEA_MS / 1000 );

		expect( sent( 'roost' ) ).toEqual( [] );
		expect( nodesOf( 'kea-7810' ).length ).toBeGreaterThan( 0 );
	} );

	it( 'goes quiet when a visible tab hides, and asks again when it shows', async () => {
		renderSources( <Perch perch="rimu" label="one" /> );
		await screen.findByText( 'one: rimu --perch=rimu at 41m' );
		expect( sent( 'roost' ) ).toHaveLength( 1 );

		act( () => setVisibility( 'hidden' ) );
		await clock.tick( KEA_MS / 1000 );
		await clock.tick( KEA_MS / 1000 );
		expect( sent( 'roost' ) ).toHaveLength( 1 );

		act( () => setVisibility( 'visible' ) );
		await waitFor( () => expect( sent( 'roost' ) ).toHaveLength( 2 ) );
	} );

	it( 'leaves nothing behind when its args throw, and shows why', async () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		function Chime() {
			const { error } = useSource( 'kokako-7821', { bell: 'tui' } );
			return <p>{ error ? `refused: ${ error }` : 'opening' }</p>;
		}
		renderSources( <Chime /> );

		expect(
			await screen.findByText( 'refused: no bell named tui' )
		).toBeTruthy();
		expect( nodesOf( 'kokako-7821' ) ).toEqual( [] );
		expect( Core.backboneMounts ).toHaveLength( 0 );
	} );
} );

describe( 'useSource keys', () => {
	it( 'shares one source between params equal up to key order', async () => {
		function Hoot( { params } ) {
			const { model } = useSource( 'ruru-7817', params );
			return <p>{ model ? model.height : 'owed' }</p>;
		}
		renderSources(
			<>
				<Hoot params={ { calls: [ 'more', 'pork' ], night: 'deep' } } />
				<Hoot params={ { night: 'deep', calls: [ 'more', 'pork' ] } } />
			</>
		);
		expect( await screen.findAllByText( 'more at 41m' ) ).toHaveLength( 2 );
		expect( sent( 'hoot' ) ).toEqual( [ [ 'more', 'pork' ] ] );
	} );

	it( 'refuses a name nothing declares, in the reader’s own tree', () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		function Unknown() {
			useSource( 'piopio-7818', {} );
			return null;
		}
		expect( () => renderSources( <Unknown /> ) ).toThrow( /piopio-7818/ );
	} );

	it( 'answers a kind nothing builds with its error', async () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		function Swoop() {
			const { error } = useSource( 'kiwi-7816', {} );
			return <p>{ error ? `refused: ${ error }` : 'opening' }</p>;
		}
		renderSources( <Swoop /> );
		expect( await screen.findByText( /refused: .*swoop/ ) ).toBeTruthy();
	} );
} );

describe( 'useSource on a command', () => {
	it( 'asks once for two hooks on one key and shows the answer', async () => {
		renderSources(
			<>
				<Forage tree="kahikatea" label="one" />
				<Forage tree="kahikatea" label="two" />
			</>
		);
		expect(
			await screen.findByText( 'two: kahikatea at 41m' )
		).toBeTruthy();
		expect( screen.getByText( 'one: kahikatea at 41m' ) ).toBeTruthy();
		expect( sent( 'forage' ) ).toEqual( [ [ 'kahikatea' ] ] );
		expect(
			wire.batches.flat().find( ( m ) => 'forage' === m[ VALUE ]?.name )[
				TO
			]
		).toBe( 'tern-7812' );
	} );

	it( 'sends nothing while the tab is hidden, and asks once it shows', async () => {
		setVisibility( 'hidden' );
		renderSources( <Forage tree="miro" label="one" /> );
		await act( async () => {} );
		await clock.tick( 5 );
		expect( sent( 'forage' ) ).toEqual( [] );

		act( () => setVisibility( 'visible' ) );
		expect( await screen.findByText( 'one: miro at 41m' ) ).toBeTruthy();
		expect( sent( 'forage' ) ).toEqual( [ [ 'miro' ] ] );
	} );

	it( 'removes its nodes and its group’s Tap on the last unmount', async () => {
		const { rerender } = renderSources(
			<>
				<Forage tree="kahikatea" label="one" />
				<Perch perch="rimu" label="other" />
			</>
		);
		await screen.findByText( 'one: kahikatea at 41m' );
		expect( nodesOf( 'kaka-7812' ).length ).toBeGreaterThan( 0 );

		rerender( <Perch perch="rimu" label="other" /> );
		await act( async () => {} );

		expect( nodesOf( 'kaka-7812' ) ).toEqual( [] );
		expect( Core.node( 'alpine-7812:shell' ) ).toBeNull();
	} );
} );

describe( 'useSource on a stream', () => {
	it( 'attaches one view per key', async () => {
		renderSources(
			<>
				<Tail log="moa" />
				<Tail log="moa" />
				<Tail log="huia" />
			</>
		);
		await act( async () => {} );

		expect( viewsOn( 'moa.p3' ) ).toHaveLength( 1 );
		expect( viewsOn( 'huia.p3' ) ).toHaveLength( 1 );
		expect( viewsOn( 'moa.p3' )[ 0 ] ).not.toBe(
			viewsOn( 'huia.p3' )[ 0 ]
		);
	} );

	it( 'parks its view while the tab hides, keeping its claim', async () => {
		renderSources( <Tail log="moa" /> );
		await act( async () => {} );
		const [ view ] = viewsOn( 'moa.p3' );
		expect( view ).toMatch( /^weka-7811:\d+:stream$/ );

		act( () => setVisibility( 'hidden' ) );

		expect( viewsOn( 'moa.p3' ) ).toEqual( [] );
		expect( Core.node( '_stream' ).parked ).toEqual( [
			{ stamp: 'moa.p3', target: view },
		] );
	} );

	it( 'detaches its view and forgets its subscription on the last unmount', async () => {
		const { rerender } = renderSources(
			<>
				<Tail log="moa" />
				<Perch perch="rimu" label="other" />
			</>
		);
		await act( async () => {} );
		const link = Core.node( '_stream' );
		const [ view ] = viewsOn( 'moa.p3' );
		const detach = jest.spyOn( link, 'detachView' );
		const forget = jest.spyOn( link, 'forget' );

		rerender( <Perch perch="rimu" label="other" /> );
		await act( async () => {} );

		expect( detach ).toHaveBeenCalledWith( 'moa.p3', view );
		expect( forget ).toHaveBeenCalledWith( [ 'moa.p3' ] );
		expect( viewsOn( 'moa.p3' ) ).toEqual( [] );
		expect( nodesOf( 'weka-7811' ) ).toEqual( [] );
	} );

	it( 'hands its readers its view node and the controls that reach it', async () => {
		let stream;
		function Controls() {
			stream = useSource( 'hihi-7831', { log: 'kereru' } ).stream;
			return null;
		}
		renderSources( <Controls /> );
		await act( async () => {} );
		const view = stream.node();
		expect( view ).toBe( Core.node( view.name ) );
		expect( view.name ).toMatch( /^hihi-7831:\d+:view$/ );

		act( () => stream.setFilter( 'kereru-7831' ) );
		act( () => stream.clear() );
		act( () => stream.setPaused( true ) );

		expect( view.filled.map( ( m ) => m[ VALUE ].action ) ).toEqual( [
			'filter',
			'clear',
			'pause',
		] );
		expect( view.filled[ 0 ][ VALUE ].term ).toBe( 'kereru-7831' );
		expect( view.filled[ 2 ][ VALUE ].paused ).toBe( true );
	} );

	it( 'answers a source that cannot open with its error, leaving the others running', async () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		function Broken() {
			const { error } = useSource( 'takahe-7813', { log: 'kokako.p1' } );
			return <p>{ error ? `refused: ${ error }` : 'opening' }</p>;
		}
		renderSources(
			<>
				<Broken />
				<Perch perch="rimu" label="one" />
			</>
		);
		expect( await screen.findByText( /refused: .*drift/ ) ).toBeTruthy();
		expect(
			await screen.findByText( 'one: rimu --perch=rimu at 41m' )
		).toBeTruthy();

		await clock.tick( KEA_MS / 1000 );

		expect( sent( 'roost' ) ).toHaveLength( 2 );
	} );
} );
