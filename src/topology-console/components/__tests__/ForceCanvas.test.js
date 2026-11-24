/**
 * The force canvas: what it draws of the console's graph, what a press does,
 * when it lays out, and whose rates it paints. d3, the model and the engine
 * are the real ones, wrapped to count what reaches them.
 *
 * d3-timer binds the frame scheduler as it loads, so the fake timers come
 * first and the modules are required after them.
 */

let mockEngine;
let mockGraphs;
let mockDrawn;
let mockPlaced;

jest.mock( '../../../shared/forceGraph/engine', () => {
	const actual = jest.requireActual( '../../../shared/forceGraph/engine' );
	return {
		...actual,
		createEngine: ( options ) => {
			mockEngine = actual.createEngine( options );
			const { setGraph } = mockEngine;
			mockEngine.setGraph = ( graph, key ) => {
				mockGraphs.push( { graph, key } );
				setGraph( graph, key );
			};
			return mockEngine;
		},
	};
} );

jest.mock( '../../utils/forceGraphModel', () => {
	const actual = jest.requireActual( '../../utils/forceGraphModel' );
	return {
		...actual,
		toForceGraph: ( options ) => {
			mockDrawn++;
			return actual.toForceGraph( options );
		},
		placeHulls: ( ...args ) => {
			mockPlaced++;
			return actual.placeHulls( ...args );
		},
	};
} );

jest.useFakeTimers();

const { act, render } = require( '@testing-library/react' );
const { createRef } = require( '@wordpress/element' );
const {
	installViewport,
} = require( '../../../shared/test-utils/viewportWidth' );
const { default: ForceCanvas } = require( '../ForceCanvas' );
const { FORCE_POLLER } = require( '../../hooks/useForceRows' );
const { hullColorIndex } = require( '../../utils/hullColor' );
const { Core } = require( '../../../runtime/core' );
const {
	newMessage,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} = require( '../../../runtime/message' );

const BLOCK = 'newspack-nodes-force-graph';
const CI = '_command_interpreter';
const SCOPE = 'quay.p3|view|quay';

// The vat owns a feed, which owns a valve; the press fills the vat.
const FEED = { name: 'vat-33:feed', class: 'Feed' };
const VALVE = { name: 'vat-33:feed:valve', class: 'Valve' };
const GRAPH = {
	nodes: [
		{ id: 'press-61', class: 'Press', sink: CI },
		{ id: 'vat-33', class: 'Vat', sink: CI, sidecars: [ FEED ] },
		{ id: 'tap-7', class: 'Tap', sink: CI },
	],
	edges: [
		{ from: 'press-61', to: 'vat-33' },
		{ from: 'vat-33', to: 'tap-7' },
	],
};

/**
 * The `dump_metadata -s` reply about GRAPH.
 *
 * @param {Object} [counters] Counters by node name, 4 for one it leaves out.
 * @return {Object} The reply map.
 */
const reply = ( counters = {} ) =>
	Object.fromEntries(
		Object.entries( {
			[ CI ]: { class: 'CommandInterpreter' },
			'press-61': { class: 'Press', sink: CI, target: 'vat-33' },
			'vat-33': {
				class: 'Vat',
				sink: CI,
				target: 'tap-7',
				sidecars: [ FEED ],
			},
			'tap-7': { class: 'Tap', sink: CI },
			'vat-33:feed': {
				class: 'Feed',
				owner: 'vat-33',
				sidecars: [ VALVE ],
			},
			'vat-33:feed:valve': { class: 'Valve', owner: 'vat-33:feed' },
		} ).map( ( [ name, row ] ) => [
			name,
			{ ...row, counter: counters[ name ] ?? 4 },
		] )
	);

// A host's rate map.
const rates = ( map = {} ) => ( {
	current: new Map(
		Object.entries( map ).map( ( [ id, rate ] ) => [ id, { rate } ] )
	),
} );

let viewport;

beforeEach( () => {
	viewport = installViewport( false );
	mockGraphs = [];
	mockDrawn = 0;
	mockPlaced = 0;
	for ( const [ side, value ] of [
		[ 'Width', 1313 ],
		[ 'Height', 777 ],
	] ) {
		Object.defineProperty( window.SVGElement.prototype, `client${ side }`, {
			configurable: true,
			get: () => value,
		} );
	}
	Core.reset();
	Core.registerNode( '_cwd', { name: '_cwd', fill: () => {} } );
} );

afterEach( () => {
	viewport.restore();
	jest.restoreAllMocks();
	delete window.SVGElement.prototype.clientWidth;
	delete window.SVGElement.prototype.clientHeight;
} );

/**
 * Mount the canvas on GRAPH, live, with every callback mocked.
 *
 * @param {Object} [props] Props over those.
 * @return {Object} The svg, the props it was handed, a way to re-render it, and its unmount.
 */
const mount = ( props = {} ) => {
	let held = {
		parsed: GRAPH,
		seeded: false,
		driftIds: null,
		selectedId: null,
		sidecar: null,
		onSelect: jest.fn(),
		onPickSidecar: jest.fn(),
		onDeselect: jest.fn(),
		hoveredId: null,
		onHover: jest.fn(),
		selectedEdge: null,
		onSelectEdge: jest.fn(),
		selectedHull: null,
		onSelectHull: jest.fn(),
		hulls: [],
		tree: {},
		resetKey: SCOPE,
		editMode: false,
		showSinks: false,
		keepWarm: false,
		onKeepWarm: jest.fn(),
		rateRef: rates(),
		rateVersion: 12,
		...props,
	};
	const view = render( <ForceCanvas { ...held } /> );
	return {
		svg: view.container.querySelector( 'svg' ),
		props: held,
		unmount: view.unmount,
		update: ( next ) => {
			held = { ...held, ...next };
			view.rerender( <ForceCanvas { ...held } /> );
		},
	};
};

/**
 * Answer the poller as the Router hands it a reply.
 *
 * @param {Object} [map]   The reply map.
 * @param {string} [scope] The scope it names.
 */
const answer = ( map = reply(), scope = SCOPE ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = encodeURIComponent( scope );
	m[ VALUE ] = { payload: map };
	act( () => Core.node( FORCE_POLLER ).fill( m ) );
};

const all = ( svg, part ) => [
	...svg.querySelectorAll( `.${ BLOCK }__${ part }` ),
];
const ids = ( svg ) => all( svg, 'node' ).map( ( el ) => el.dataset.id );
const nodeEl = ( svg, id ) =>
	all( svg, 'node' ).find( ( el ) => id === el.dataset.id );
const linkOf = ( el ) => el.__data__.link;
const linkEl = ( svg, id ) =>
	all( svg, 'link' ).find( ( el ) => id === linkOf( el ).id );
const linkIds = ( svg ) => all( svg, 'link' ).map( ( el ) => linkOf( el ).id );
const hullEl = ( svg, id ) =>
	all( svg, 'hull' ).find( ( el ) => id === el.__data__.group.id );
const wears = ( el, name ) => el.classList.contains( name );
const wearing = ( svg, name ) =>
	[ ...svg.querySelectorAll( `.${ name }` ) ].map(
		( el ) => el.dataset.id ?? linkOf( el )?.id
	);

const mouse = ( type, target ) =>
	act( () => {
		target.dispatchEvent(
			new window.MouseEvent( type, {
				view: window,
				bubbles: true,
				cancelable: true,
				clientX: 400,
				clientY: 300,
			} )
		);
	} );

const press = ( el ) => {
	mouse( 'mousedown', el );
	mouse( 'mouseup', window );
	mouse( 'click', el );
	act( () => jest.advanceTimersByTime( 1 ) );
};

const callbacks = ( { props } ) =>
	[ 'onSelect', 'onPickSidecar', 'onDeselect', 'onSelectEdge' ].filter(
		( name ) => props[ name ].mock.calls.length
	);

const clone = ( value ) => JSON.parse( JSON.stringify( value ) );
const keys = () => [ ...new Set( mockGraphs.map( ( { key } ) => key ) ) ];

describe( 'what it draws', () => {
	it( 'is one named canvas of its own class, which its host holds', () => {
		const svgRef = createRef();
		const { svg } = mount( { svgRef } );
		expect( [ ...svg.classList ] ).toEqual( [
			BLOCK,
			'topology-force-canvas',
		] );
		expect( svg.getAttribute( 'aria-label' ) ).toBe( 'Topology canvas' );
		expect( svgRef.current ).toBe( svg );
	} );

	it( 'draws the graph, and no sidecar while a poll never answers', () => {
		const { svg } = mount();
		act( () => jest.advanceTimersByTime( 9000 ) );
		expect( ids( svg ) ).toEqual( [ 'press-61', 'vat-33', 'tap-7' ] );
		expect( linkIds( svg ) ).toEqual( [
			'target:press-61/vat-33',
			'target:vat-33/tap-7',
		] );
	} );

	it( 'joins the sidecars at both depths once the poll answers', () => {
		const { svg } = mount();
		answer();
		expect( wearing( svg, 'is-sidecar' ) ).toEqual( [
			'vat-33:feed',
			'vat-33:feed:valve',
		] );
		expect( wearing( svg, 'is-patron' ) ).toEqual( [
			'patron:vat-33:feed',
			'patron:vat-33:feed:valve',
		] );
		expect( ids( svg ) ).not.toContain( CI );
	} );

	it( 'draws sinks, and the interpreter, while asked to', () => {
		const { svg, update } = mount( { showSinks: true } );
		answer();
		expect( ids( svg ) ).toContain( CI );
		expect( wearing( svg, 'is-sink' ) ).toContain( `sink:tap-7/${ CI }` );
		update( { showSinks: false } );
		expect( ids( svg ) ).not.toContain( CI );
	} );

	it( 'nests the hulls as the tree does, in their own colors', () => {
		const { svg } = mount( {
			tree: { dock: { basin: {} } },
			hulls: [
				{ include: 'basin', depth: 2, nodeIds: [ 'vat-33', 'tap-7' ] },
				{
					include: 'dock',
					depth: 1,
					nodeIds: [ 'press-61', 'vat-33', 'tap-7' ],
				},
			],
		} );
		expect( all( svg, 'hull' ) ).toHaveLength( 2 );
		expect( mockGraphs.at( -1 ).graph.groups ).toEqual( [
			expect.objectContaining( { id: 'basin', parent: 'dock' } ),
			expect.objectContaining( { id: 'dock', parent: null } ),
		] );
		expect(
			wears(
				hullEl( svg, 'basin' ),
				`is-hull-${ 1 + hullColorIndex( 'basin' ) }`
			)
		).toBe( true );
	} );

	it( 'marks drift', () => {
		const { svg } = mount( { driftIds: new Set( [ 'tap-7' ] ) } );
		expect( wearing( svg, 'is-drift' ) ).toEqual( [ 'tap-7' ] );
	} );

	it.each( [
		[ 'a seed', { seeded: true } ],
		[ 'a draft', { editMode: true } ],
	] )( 'does not poll over %s', async ( _what, props ) => {
		const { svg } = mount( props );
		await act( async () => {} );
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
		expect( ids( svg ) ).toHaveLength( 3 );
	} );

	it( 'drops the sidecars when the graph becomes a draft', () => {
		const { svg, update } = mount();
		answer();
		update( { editMode: true } );
		expect( ids( svg ) ).toEqual( [ 'press-61', 'vat-33', 'tap-7' ] );
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
	} );
} );

describe( 'a selection', () => {
	it( 'takes a pressed canvas node', () => {
		const view = mount();
		press( nodeEl( view.svg, 'tap-7' ) );
		expect( view.props.onSelect.mock.calls ).toEqual( [ [ 'tap-7' ] ] );
		expect( callbacks( view ) ).toEqual( [ 'onSelect' ] );
	} );

	it.each( [ 'vat-33:feed', 'vat-33:feed:valve' ] )(
		'takes the sidecar %s with the canvas node at its root',
		( name ) => {
			const view = mount();
			answer();
			press( nodeEl( view.svg, name ) );
			expect( view.props.onPickSidecar.mock.calls ).toEqual( [
				[ 'vat-33', name ],
			] );
			expect( callbacks( view ) ).toEqual( [ 'onPickSidecar' ] );
		}
	);

	it( 'is cleared by the interpreter, whose panel is the no-node one', () => {
		const view = mount( { showSinks: true } );
		answer();
		press( nodeEl( view.svg, CI ) );
		expect( view.props.onDeselect ).toHaveBeenCalledTimes( 1 );
		expect( callbacks( view ) ).toEqual( [ 'onDeselect' ] );
	} );

	it( 'is cleared by a press on the canvas', () => {
		const view = mount();
		press( view.svg );
		expect( callbacks( view ) ).toEqual( [ 'onDeselect' ] );
	} );

	it( 'takes a pressed hull, and marks the selected one', () => {
		const { svg, props, update } = mount( {
			tree: { dock: {} },
			hulls: [
				{
					include: 'dock',
					depth: 1,
					nodeIds: [ 'vat-33', 'tap-7' ],
				},
			],
		} );
		press( hullEl( svg, 'dock' ) );
		expect( props.onSelectHull.mock.calls ).toEqual( [ [ 'dock' ] ] );
		update( { selectedHull: 'dock' } );
		expect( wears( hullEl( svg, 'dock' ), 'is-selected' ) ).toBe( true );
		expect( wears( nodeEl( svg, 'tap-7' ), 'is-lit' ) ).toBe( true );
	} );

	it( 'stays on the canvas node while its sidecar is not drawn', () => {
		const { svg, update } = mount( {
			selectedId: 'vat-33',
			sidecar: 'vat-33:feed',
		} );
		expect( wearing( svg, 'is-selected' ) ).toEqual( [ 'vat-33' ] );
		answer();
		expect( wearing( svg, 'is-selected' ) ).toEqual( [ 'vat-33:feed' ] );
		update( { sidecar: 'vat-33:lost' } );
		expect( wearing( svg, 'is-selected' ) ).toEqual( [ 'vat-33' ] );
	} );

	it( 'shows the sidecar in its node’s place', () => {
		const { svg, update } = mount( { selectedId: 'vat-33' } );
		answer();
		expect( wearing( svg, 'is-selected' ) ).toEqual( [ 'vat-33' ] );
		update( { sidecar: 'vat-33:feed:valve' } );
		expect( wearing( svg, 'is-selected' ) ).toEqual( [
			'vat-33:feed:valve',
		] );
		expect( wearing( svg, 'is-touched' ) ).toEqual( [
			'patron:vat-33:feed:valve',
		] );
	} );
} );

describe( 'a hover', () => {
	const pointer = ( type, el ) =>
		act( () => {
			el.dispatchEvent(
				new window.MouseEvent( type, { bubbles: true } )
			);
		} );

	it( 'of a node goes to the host, and dims the rest when it comes back', () => {
		const { svg, props, update } = mount();
		pointer( 'pointerover', nodeEl( svg, 'press-61' ) );
		expect( props.onHover.mock.calls ).toEqual( [ [ 'press-61' ] ] );
		update( { hoveredId: 'press-61' } );
		expect( wearing( svg, 'is-hovered' ) ).toEqual( [ 'press-61' ] );
		expect( wearing( svg, 'is-dimmed' ).sort() ).toEqual( [
			'tap-7',
			'target:vat-33/tap-7',
			'vat-33',
		] );
	} );

	it( 'of a hull lights what it holds and dims the rest', () => {
		const { svg } = mount( {
			tree: { dock: {} },
			hulls: [
				{
					include: 'dock',
					depth: 1,
					nodeIds: [ 'vat-33', 'tap-7' ],
				},
			],
		} );
		pointer( 'pointerover', hullEl( svg, 'dock' ) );
		expect( wearing( svg, 'is-lit' ).sort() ).toEqual( [
			'tap-7',
			'target:vat-33/tap-7',
			'vat-33',
		] );
		expect( wearing( svg, 'is-dimmed' ).sort() ).toEqual( [
			'press-61',
			'target:press-61/vat-33',
		] );
		pointer( 'pointerleave', svg );
		expect( wearing( svg, 'is-lit' ) ).toEqual( [] );
	} );
} );

describe( 'an edge', () => {
	// One edge of each kind, and a registration and a sink beside a connection.
	const EDGES = {
		nodes: [
			{ id: 'press-61', class: 'Press' },
			{ id: 'vat-33', class: 'Vat', sink: 'tap-7' },
			{ id: 'tap-7', class: 'Tap' },
			{ id: 'cask-5', class: 'Cask' },
		],
		edges: [
			{ from: 'press-61', to: 'vat-33', roles: [ 'connect', 'config' ] },
			{ from: 'vat-33', to: 'tap-7', registration: true, event: 'EBB' },
			{ from: 'vat-33', to: 'tap-7' },
			{ from: 'press-61', to: 'tap-7', virtual: true },
			{ from: 'press-61', to: 'cask-5', roles: [ 'config' ] },
			{ from: 'tap-7', to: 'cask-5', registration: true, event: 'EBB' },
			{ from: 'cask-5', to: 'vat-33', registration: true, event: 'EBB' },
			{ from: 'cask-5', to: 'vat-33', virtual: true },
		],
	};

	it.each( [
		[ 'target:press-61/vat-33', { from: 'press-61', to: 'vat-33' } ],
		[ 'target:vat-33/tap-7', { from: 'vat-33', to: 'tap-7' } ],
	] )( 'pressed in a draft at %s is selected', ( id, edge ) => {
		const view = mount( { parsed: EDGES, editMode: true } );
		press( linkEl( view.svg, id ) );
		expect( view.props.onSelectEdge.mock.calls ).toEqual( [ [ edge ] ] );
		expect( callbacks( view ) ).toEqual( [ 'onSelectEdge' ] );
	} );

	it.each( [
		'target:press-61/tap-7',
		'target:press-61/cask-5',
		'target:cask-5/vat-33',
		'registration:tap-7/cask-5/EBB',
		'registration:vat-33/tap-7/EBB',
		'sink:vat-33/tap-7',
	] )( 'pressed in a draft at %s lets the press through', ( id ) => {
		const view = mount( {
			parsed: EDGES,
			editMode: true,
			showSinks: true,
		} );
		const line = linkEl( view.svg, id );
		expect( wears( line, 'is-pressable' ) ).toBe( false );
		press( line );
		expect( callbacks( view ) ).toEqual( [ 'onDeselect' ] );
	} );

	it( 'takes no press on a live graph', () => {
		const view = mount( { parsed: EDGES } );
		const line = linkEl( view.svg, 'target:vat-33/tap-7' );
		expect( wears( line, 'is-pressable' ) ).toBe( false );
		press( line );
		expect( view.props.onSelectEdge ).not.toHaveBeenCalled();
	} );

	it( 'is marked while it is the selected one', () => {
		const { svg, update } = mount( {
			parsed: EDGES,
			editMode: true,
			selectedEdge: { from: 'vat-33', to: 'tap-7' },
		} );
		expect( wearing( svg, 'is-selected' ) ).toEqual( [
			'target:vat-33/tap-7',
		] );
		update( { selectedEdge: null } );
		expect( wearing( svg, 'is-selected' ) ).toEqual( [] );
	} );
} );

describe( 'a full layout', () => {
	it( 'comes once with the live graph and once with its sidecars', () => {
		const { update } = mount( { seeded: true } );
		expect( keys() ).toHaveLength( 1 );
		update( { seeded: false } );
		expect( keys() ).toHaveLength( 2 );
		answer();
		expect( keys() ).toHaveLength( 3 );
		act( () => jest.advanceTimersByTime( 2000 ) );
		answer( reply( { 'tap-7': 31 } ) );
		update( { parsed: clone( GRAPH ), rateVersion: 13 } );
		act( () => jest.advanceTimersByTime( 2000 ) );
		const { 'vat-33:feed:valve': _gone, ...fewer } = reply();
		answer( fewer );
		expect( keys() ).toHaveLength( 3 );
	} );

	it( 'comes with another scope, and with its own sidecars', () => {
		const { update } = mount();
		answer();
		const before = keys();
		update( { resetKey: 'mill.p1|view|mill' } );
		answer( reply(), 'mill.p1|view|mill' );
		const after = keys();
		expect( after.slice( 0, before.length ) ).toEqual( before );
		expect( after ).toHaveLength( before.length + 2 );
	} );

	it( 'does not come again in a draft when the snapshot goes', () => {
		const { update } = mount( { editMode: true } );
		update( { seeded: true } );
		expect( keys() ).toHaveLength( 1 );
	} );
} );

describe( 'the rates', () => {
	const answerTwice = ( counters ) => {
		answer();
		act( () => jest.advanceTimersByTime( 2000 ) );
		answer( reply( counters ) );
	};

	it( 'of canvas nodes are the host’s', () => {
		const { svg } = mount( {
			rateRef: rates( { 'press-61': 6.5, 'vat-33': 9 } ),
		} );
		expect( wearing( svg, 'is-live' ) ).toEqual( [
			'target:press-61/vat-33',
			'press-61',
			'vat-33',
		] );
		expect( wearing( svg, 'is-idle' ) ).toEqual( [ 'tap-7' ] );
		expect(
			Number(
				linkEl( svg, 'target:press-61/vat-33' ).getAttribute(
					'stroke-width'
				)
			)
		).toBeCloseTo( 1 + 2 * Math.log10( 7.5 ), 9 );
	} );

	it( 'of sidecars are its own poll’s, which do not outrank the host’s', () => {
		const { svg } = mount( {
			rateRef: rates( { 'press-61': 0, 'vat-33': 0, 'tap-7': 0 } ),
		} );
		answerTwice( { 'vat-33:feed': 4 + 50, 'press-61': 4 + 90 } );
		expect( wearing( svg, 'is-live' ) ).toEqual( [
			'patron:vat-33:feed',
			'vat-33:feed',
		] );
		expect( mockGraphs.at( -1 ).graph.nodes ).toContainEqual(
			expect.objectContaining( { id: 'vat-33:feed', rate: 25 } )
		);
	} );

	it( 'of its own poll are forgotten with the scope', () => {
		const { svg, update } = mount();
		answerTwice( { 'vat-33:feed': 4 + 50 } );
		update( { resetKey: 'mill.p1|view|mill' } );
		answer( reply( { 'vat-33:feed': 900 } ), 'mill.p1|view|mill' );
		expect( wearing( svg, 'is-live' ) ).toEqual( [] );
	} );

	it( 'are not shown in a draft', () => {
		const { svg } = mount( {
			editMode: true,
			rateRef: rates( { 'press-61': 6.5, 'vat-33': 9 } ),
		} );
		expect( wearing( svg, 'is-live' ) ).toEqual( [] );
		expect( wearing( svg, 'is-idle' ) ).toEqual( [] );
	} );

	it( 'move the layout when the host’s poll does, and at no other time', () => {
		const rateRef = rates( { 'press-61': 6.5 } );
		const { update } = mount( { rateRef } );
		const setRates = jest.spyOn( mockEngine, 'setRates' );
		answer();
		update( { hoveredId: 'tap-7' } );
		expect( setRates ).not.toHaveBeenCalled();
		rateRef.current.set( 'tap-7', { rate: 3 } );
		update( { rateVersion: 13 } );
		expect( setRates.mock.calls ).toEqual( [
			[
				new Map( [
					[ 'press-61', 6.5 ],
					[ 'tap-7', 3 ],
				] ),
			],
		] );
	} );

	it( 'do not move a draft', () => {
		const { update } = mount();
		const setLive = jest.spyOn( mockEngine, 'setLive' );
		const setRates = jest.spyOn( mockEngine, 'setRates' );
		update( { editMode: true } );
		expect( setLive.mock.calls ).toEqual( [ [ false ] ] );
		update( { rateVersion: 13 } );
		expect( setRates ).not.toHaveBeenCalled();
	} );

	it( 'keep it warm while asked to, which k toggles', () => {
		const { svg, props, update } = mount();
		const setKeepWarm = jest.spyOn( mockEngine, 'setKeepWarm' );
		update( { keepWarm: true } );
		expect( setKeepWarm.mock.calls ).toEqual( [ [ true ] ] );
		act( () => svg.focus() );
		act( () => {
			svg.dispatchEvent(
				new window.KeyboardEvent( 'keydown', {
					key: 'k',
					bubbles: true,
				} )
			);
		} );
		expect( props.onKeepWarm ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'its work', () => {
	const HULLS = {
		tree: { dock: {} },
		hulls: [
			{ include: 'dock', depth: 1, nodeIds: [ 'vat-33', 'tap-7' ] },
		],
	};

	it( 'is one mapping for a change of its inputs, and none for a render', () => {
		const { update } = mount( HULLS );
		expect( mockDrawn ).toBe( 1 );
		update( { onHover: jest.fn(), svgRef: createRef() } );
		expect( mockDrawn ).toBe( 1 );
		expect( mockGraphs ).toHaveLength( 1 );
		update( { hoveredId: 'tap-7' } );
		expect( mockDrawn ).toBe( 2 );
	} );

	it.each( [
		[ 'parsed', { nodes: GRAPH.nodes.slice( 1 ), edges: [] } ],
		[ 'hulls', [] ],
		[ 'tree', { pier: { dock: {} } } ],
		[ 'showSinks', true ],
		[ 'rateVersion', 13 ],
		[ 'selectedId', 'tap-7' ],
		[ 'sidecar', 'vat-33:feed' ],
		[ 'hoveredId', 'tap-7' ],
		[ 'selectedHull', 'dock' ],
		[ 'driftIds', new Set( [ 'tap-7' ] ) ],
		[ 'editMode', true ],
		[ 'rateRef', rates( { 'tap-7': 5 } ) ],
	] )( 'follows a changed %s', ( name, value ) => {
		const { update } = mount( HULLS );
		update( { [ name ]: value } );
		expect( mockDrawn ).toBe( 2 );
	} );

	it( 'is not repeated by the engine for a poll that changes nothing', () => {
		const { update } = mount( HULLS );
		answer();
		const before = mockGraphs.length;
		answer();
		update( {
			parsed: clone( GRAPH ),
			hulls: clone( HULLS.hulls ),
			tree: clone( HULLS.tree ),
			rateVersion: 13,
		} );
		expect( mockGraphs ).toHaveLength( before );
	} );

	it( 'leaves the hulls alone on a hover', () => {
		const { update } = mount( HULLS );
		update( { hoveredId: 'tap-7' } );
		expect( mockPlaced ).toBe( 1 );
		const [ first, second ] = mockGraphs;
		expect( second.graph.groups ).toBe( first.graph.groups );
		expect( second.graph.nodes ).not.toBe( first.graph.nodes );
	} );

	it( 'takes a hull that comes and one that moves in the tree', () => {
		const { update } = mount( HULLS );
		const hulls = [
			{ include: 'pier', depth: 1, nodeIds: [ 'press-61', 'vat-33' ] },
			{ ...HULLS.hulls[ 0 ], depth: 2 },
		];
		const groups = () => mockGraphs.at( -1 ).graph.groups;
		update( { hulls } );
		expect( groups().map( ( { id } ) => id ) ).toEqual( [
			'pier',
			'dock',
		] );
		update( { tree: { pier: { dock: {} } } } );
		expect( groups()[ 1 ].parent ).toBe( 'pier' );
	} );

	it( 'follows a line that gains a title alone, and loses it', () => {
		const { svg } = mount();
		const title = () =>
			linkEl( svg, 'patron:vat-33:feed' ).querySelector( 'title' )
				?.textContent;
		const feed = { ...reply()[ 'vat-33:feed' ], target: 'vat-33' };
		const bare = { ...reply(), 'vat-33:feed': feed };
		const registrations = { EBB: [ 'vat-33' ] };
		answer( bare );
		expect( title() ).toBeUndefined();
		answer( { ...bare, 'vat-33:feed': { ...feed, registrations } } );
		expect( title() ).toBe( 'EBB' );
		answer( bare );
		expect( title() ).toBeUndefined();
	} );
} );
