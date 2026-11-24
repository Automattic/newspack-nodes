/**
 * GraphView with two canvases: which one shows, what outlives the switch, and
 * that a selection means the same on both. The canvases, the Inspector, the
 * frame, the Palette and the layout hook are the real ones; the canvases are
 * wrapped to read what GraphView hands each.
 *
 * d3-timer binds the frame scheduler as it loads, so the fake timers come
 * first and the modules are required after them.
 */

/** The props GraphView last handed each canvas. */
let mockHanded;

jest.mock( '../ForceCanvas', () => {
	const Canvas = jest.requireActual( '../ForceCanvas' ).default;
	return {
		__esModule: true,
		default: ( props ) => {
			mockHanded.force = props;
			return <Canvas { ...props } />;
		},
	};
} );

jest.mock( '../SchematicCanvas', () => {
	const Canvas = jest.requireActual( '../SchematicCanvas' ).default;
	return {
		__esModule: true,
		default: ( props ) => {
			mockHanded.schematic = props;
			return <Canvas { ...props } />;
		},
	};
} );

jest.useFakeTimers();

const { act, fireEvent, render } = require( '@testing-library/react' );
const { useState } = require( '@wordpress/element' );
const {
	installViewport,
} = require( '../../../shared/test-utils/viewportWidth' );
const { default: CanvasFrame } = require( '../CanvasFrame' );
const { default: GraphView } = require( '../GraphView' );
const { CatalogProvider } = require( '../../CatalogContext' );
const { ChromeProvider } = require( '../../ChromeContext' );
const { LayoutProvider } = require( '../../LayoutContext' );
const { useCanvasLayout } = require( '../../hooks/useCanvasLayout' );
const { FORCE_POLLER } = require( '../../hooks/useForceRows' );
const { SIDECAR_POLLER } = require( '../../hooks/useSidecarRows' );
const {
	FORCE_CANVAS_STORAGE_KEY,
	FORCE_SINKS_STORAGE_KEY,
	FORCE_WARM_STORAGE_KEY,
} = require( '../../themes' );
const { Core } = require( '../../../runtime/core' );
const {
	MetadataNode,
	parseMetadata,
} = require( '../../../runtime/metadata-node' );
const {
	newMessage,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} = require( '../../../runtime/message' );
const names = require( '../../../runtime/reserved-node-names.json' );

const FORCE = '.topology-force-canvas';
const SCHEMATIC = '.topology-canvas-svg';
const BLOCK = 'newspack-nodes-force-graph';
const CI = names.COMMAND_INTERPRETER;
const SCOPE = 'quay.p3|view|quay';
const LAYOUT_KEY = 'newspack-nodes:test:quay';

// The vat owns a feed, which owns a valve; the press fills the vat.
const FEED = { name: 'vat-33:feed', class: 'Feed' };
const VALVE = { name: 'vat-33:feed:valve', class: 'Valve' };
const ROWS = {
	[ CI ]: { class: 'CommandInterpreter' },
	'press-61': { class: 'Press', sink: CI, target: 'vat-33', counter: 4 },
	'vat-33': {
		class: 'Vat',
		sink: CI,
		target: 'tap-7',
		counter: 9,
		sidecars: [ FEED ],
	},
	'tap-7': { class: 'Tap', sink: CI, counter: 2 },
	'vat-33:feed': {
		class: 'Feed',
		owner: 'vat-33',
		counter: 5,
		sidecars: [ VALVE ],
	},
	'vat-33:feed:valve': {
		class: 'Valve',
		owner: 'vat-33:feed',
		counter: 6,
	},
};
const CANVAS_ROWS = Object.fromEntries(
	Object.entries( ROWS ).filter( ( [ , row ] ) => ! row.owner )
);
const LIVE = parseMetadata( CANVAS_ROWS );
const DRAFT = {
	nodes: [
		{ id: 'press-61', class: 'Press', args: [ '7' ] },
		{ id: 'vat-33', class: 'Vat', origin: [ 'dock' ] },
		{ id: 'tap-7', class: 'Tap' },
	],
	edges: [
		{ from: 'press-61', to: 'vat-33' },
		{ from: 'press-61', to: 'tap-7' },
	],
};
const DOCK = {
	hulls: [ { include: 'dock', depth: 1, nodeIds: [ 'vat-33', 'tap-7' ] } ],
	includeTree: { dock: {} },
	includes: [ 'dock' ],
};

/** The names of what the canvases told the layout. */
let layoutCalls;

/**
 * A host as the console is one: it owns the layout, and echoes the selection.
 *
 * @param {Object} props GraphView's, over the host's own.
 * @return {?import('react').ReactElement} GraphView, once the layout is ready.
 */
function Host( props ) {
	const [ selection, setSelection ] = useState( null );
	const layout = useCanvasLayout( {
		storageKey: LAYOUT_KEY,
		graph: props.graph,
		ready: true,
	} );
	const told =
		( name ) =>
		( ...args ) => {
			layoutCalls.push( name );
			layout[ name ]( ...args );
		};
	if ( 0 === Object.keys( layout.positions ).length ) {
		return null;
	}
	return (
		<ChromeProvider>
			<LayoutProvider
				positionOverrides={ layout.positions }
				onPositionChange={ told( 'onPositionChange' ) }
				viewport={ layout.viewport }
				onViewportChange={ told( 'onViewportChange' ) }
			>
				<CatalogProvider
					classes={ [ { shell_name: 'Echo', category: 'Generic' } ] }
				>
					<GraphView
						frame={ CanvasFrame }
						resetKey={ SCOPE }
						viewportDelta={ layout.viewportDelta }
						onSelectionChange={ setSelection }
						selection={ selection }
						{ ...props }
					/>
				</CatalogProvider>
			</LayoutProvider>
		</ChromeProvider>
	);
}

/**
 * Mount the host, and let the layout settle.
 *
 * @param {Object} [props] GraphView's props over LIVE.
 * @return {Object} Readers of what is drawn, and a way to re-render.
 */
const mount = ( props = {} ) => {
	const { container, rerender, unmount } = render(
		<Host graph={ LIVE } { ...props } />
	);
	act( () => jest.advanceTimersByTime( 300 ) );
	const find = ( selector ) => container.querySelector( selector );
	return {
		find,
		all: ( selector ) => [ ...container.querySelectorAll( selector ) ],
		svg: () => find( FORCE ) ?? find( SCHEMATIC ),
		panel: () => find( '.topology-inspector' ),
		title: () => find( '.topology-insp__title' )?.textContent,
		update: ( next ) =>
			rerender( <Host graph={ LIVE } { ...props } { ...next } /> ),
		unmount,
	};
};

const toggle = ( view, label ) =>
	view
		.all( '.topology-inspector-dock [aria-pressed]' )
		.find( ( button ) => label === button.textContent );
const press = ( view, label ) => fireEvent.click( toggle( view, label ) );
const toggles = ( view ) =>
	view
		.all( '.topology-inspector-dock [aria-pressed]' )
		.map( ( button ) => [
			button.textContent,
			button.getAttribute( 'aria-pressed' ),
		] );
const chips = ( view ) =>
	view
		.all( '.topology-canvas__layout-chip' )
		.map( ( chip ) => chip.textContent.slice( 2 ).trim() );
const stored = () =>
	[
		FORCE_CANVAS_STORAGE_KEY,
		FORCE_SINKS_STORAGE_KEY,
		FORCE_WARM_STORAGE_KEY,
	].map( ( key ) => window.localStorage.getItem( key ) );
const store = ( ...keys ) =>
	keys.forEach( ( key ) => window.localStorage.setItem( key, '1' ) );

/**
 * Answer a poller as the Router hands it a reply.
 *
 * @param {string}   name  The poller.
 * @param {string[]} [ids] The rows it answers; all of them when not given.
 */
const answer = ( name, ids = Object.keys( ROWS ) ) => {
	const reply = newMessage();
	reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	reply[ TO ] = encodeURIComponent( Core.node( name ).subject );
	reply[ VALUE ] = {
		payload: Object.fromEntries( ids.map( ( id ) => [ id, ROWS[ id ] ] ) ),
	};
	act( () => Core.node( name ).fill( reply ) );
};

/**
 * Land a poll reply as the snapshot of `_metadata`.
 *
 * @param {Object} graph The graph it answers.
 */
const landPoll = ( graph ) =>
	act( () => Core.node( names.METADATA ).setField( 'snapshot', graph ) );

const mouse = ( type, target, at = { clientX: 400, clientY: 300 } ) =>
	act( () => {
		target.dispatchEvent(
			new window.MouseEvent( type, {
				view: window,
				bubbles: true,
				cancelable: true,
				...at,
			} )
		);
	} );

/**
 * Press an element of the force canvas.
 *
 * @param {Element} el The element.
 */
const pressForce = ( el ) => {
	mouse( 'mousedown', el );
	mouse( 'mouseup', window );
	mouse( 'click', el );
	act( () => jest.advanceTimersByTime( 1 ) );
};

/** How each canvas takes a press of each of its parts. */
const CANVASES = {
	force: {
		keys: [ FORCE_CANVAS_STORAGE_KEY ],
		empty: ( view ) => pressForce( view.svg() ),
		node: ( view, id ) =>
			pressForce( view.find( `${ FORCE } [data-id="${ id }"]` ) ),
		edge: ( view, from, to ) =>
			pressForce(
				view
					.all( `.${ BLOCK }__link` )
					.find(
						( el ) =>
							`target:${ from }/${ to }` === el.__data__.link.id
					)
			),
		hull: ( view, include ) =>
			pressForce(
				view
					.all( `.${ BLOCK }__hull` )
					.find( ( el ) => include === el.__data__.group.id )
			),
		sidecar: ( view, owner, name ) => {
			answer( FORCE_POLLER );
			pressForce( view.find( `${ FORCE } [data-id="${ name }"]` ) );
		},
	},
	schematic: {
		keys: [],
		empty: ( view ) => {
			fireEvent.pointerDown( view.svg(), { button: 0 } );
			fireEvent.pointerUp( view.svg(), { button: 0 } );
		},
		node: ( view, id ) =>
			fireEvent.click(
				view
					.all( '.topology-node' )
					.find( ( el ) => el.textContent.includes( id ) )
			),
		edge: ( view, from, to ) => {
			const at = DRAFT.edges.findIndex(
				( edge ) => from === edge.from && to === edge.to
			);
			fireEvent.mouseDown( view.all( '.topology-edge-hit' )[ at ] );
		},
		hull: ( view ) => {
			const hull = view.find( '.topology-hull' );
			fireEvent.pointerDown( hull, { button: 0 } );
			fireEvent.pointerUp( hull, { button: 0 } );
		},
		sidecar: ( view, owner, name ) => {
			fireEvent.click( view.find( `[data-owner="${ owner }"]` ) );
			answer( SIDECAR_POLLER, [ owner, name ] );
			fireEvent.click(
				view
					.all( '.topology-sidecars__card' )
					.find( ( el ) =>
						el.getAttribute( 'aria-label' ).startsWith( name )
					)
			);
		},
	},
};

let viewport;

beforeAll( () => {
	// jsdom has no PointerEvent; the schematic reads its button.
	window.PointerEvent ??= class extends window.MouseEvent {};
	const svg = window.SVGSVGElement.prototype;
	svg.createSVGPoint = () => {
		const point = { x: 0, y: 0 };
		point.matrixTransform = () => ( { x: point.x, y: point.y } );
		return point;
	};
	svg.getScreenCTM = () => ( { inverse: () => ( {} ) } );
	window.Element.prototype.setPointerCapture = () => {};
	window.Element.prototype.releasePointerCapture = () => {};
	window.Element.prototype.hasPointerCapture = () => false;
} );

beforeEach( () => {
	viewport = installViewport( false );
	window.localStorage.clear();
	mockHanded = {};
	layoutCalls = [];
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
	Core.registerNode( '_cwd', {
		name: '_cwd',
		fill: () => {},
	} );
	new MetadataNode().name = names.METADATA;
} );

afterEach( () => {
	viewport.restore();
	delete window.SVGElement.prototype.clientWidth;
	delete window.SVGElement.prototype.clientHeight;
	delete document.elementFromPoint;
} );

describe( 'the flags', () => {
	it( 'have the keys the station and the overlay share', () => {
		expect( [
			FORCE_CANVAS_STORAGE_KEY,
			FORCE_SINKS_STORAGE_KEY,
			FORCE_WARM_STORAGE_KEY,
		] ).toEqual( [
			'newspack-nodes:force-canvas',
			'newspack-nodes:force-sinks',
			'newspack-nodes:force-warm',
		] );
	} );

	it( 'are off at first: the schematic, one toggle, and nothing stored', () => {
		const view = mount();
		expect( view.find( SCHEMATIC ) ).not.toBeNull();
		expect( view.find( FORCE ) ).toBeNull();
		expect( toggles( view ) ).toEqual( [ [ 'Force canvas', 'false' ] ] );
		expect( stored() ).toEqual( [ null, null, null ] );
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
	} );

	it( 'swap the canvas, and back', () => {
		const view = mount();
		press( view, 'Force canvas' );
		expect( view.find( FORCE ) ).not.toBeNull();
		expect( view.find( SCHEMATIC ) ).toBeNull();
		expect( toggles( view ) ).toEqual( [
			[ 'Force canvas', 'true' ],
			[ 'Show sinks', 'false' ],
			[ 'Keep warm', 'false' ],
		] );
		press( view, 'Force canvas' );
		expect( view.find( SCHEMATIC ) ).not.toBeNull();
		expect( view.find( FORCE ) ).toBeNull();
		expect( stored() ).toEqual( [ '0', null, null ] );
	} );

	it( 'outlive the mount, each under its own key', () => {
		const view = mount();
		press( view, 'Force canvas' );
		press( view, 'Show sinks' );
		expect( stored() ).toEqual( [ '1', '1', null ] );
		view.unmount();
		const again = mount();
		expect( again.find( FORCE ) ).not.toBeNull();
		expect( toggles( again ) ).toEqual( [
			[ 'Force canvas', 'true' ],
			[ 'Show sinks', 'true' ],
			[ 'Keep warm', 'false' ],
		] );
		press( again, 'Show sinks' );
		press( again, 'Keep warm' );
		expect( stored() ).toEqual( [ '1', '0', '1' ] );
	} );

	it( 'reach the canvas: sinks', () => {
		store( FORCE_CANVAS_STORAGE_KEY, FORCE_SINKS_STORAGE_KEY );
		const view = mount();
		landPoll( LIVE );
		answer( FORCE_POLLER );
		const drawn = () => view.find( `${ FORCE } [data-id="${ CI }"]` );
		expect( drawn() ).not.toBeNull();
		press( view, 'Show sinks' );
		expect( drawn() ).toBeNull();
	} );

	it( 'reach the canvas: warmth, which k on it toggles too', () => {
		store( FORCE_CANVAS_STORAGE_KEY, FORCE_WARM_STORAGE_KEY );
		const view = mount();
		expect( mockHanded.force.keepWarm ).toBe( true );
		expect( toggles( view )[ 2 ] ).toEqual( [ 'Keep warm', 'true' ] );
		act( () => view.svg().focus() );
		fireEvent.keyDown( view.svg(), { key: 'k' } );
		expect( mockHanded.force.keepWarm ).toBe( false );
		expect( toggles( view )[ 2 ] ).toEqual( [ 'Keep warm', 'false' ] );
		expect( stored() ).toEqual( [ '1', null, '0' ] );
		press( view, 'Keep warm' );
		expect( mockHanded.force.keepWarm ).toBe( true );
	} );
} );

describe( 'the toggles', () => {
	it.each( [ true, false ] )(
		'stand over the no-node panel, in edit mode %s, and over no hull',
		( editMode ) => {
			store( FORCE_CANVAS_STORAGE_KEY );
			const view = mount( {
				...DOCK,
				editMode,
				graph: editMode ? DRAFT : LIVE,
			} );
			expect(
				view
					.panel()
					.firstElementChild.contains(
						toggle( view, 'Force canvas' )
					)
			).toBe( true );
			CANVASES.force.hull( view, 'dock' );
			expect( view.title() ).toBe( 'dock' );
			expect( toggles( view ) ).toEqual( [] );
		}
	);
} );

describe( 'the layout chips', () => {
	const frameProps = {
		topology: 'quay',
		editMode: true,
		onSaveLayout: () => {},
		onResetLayout: () => {},
		onResetGraph: () => {},
	};

	it( 'that act on the schematic hide with it; Reset graph stays', () => {
		const view = mount( { frameProps } );
		expect( chips( view ) ).toEqual( [
			'Save layout',
			'Reset layout',
			'Reset graph',
		] );
		press( view, 'Force canvas' );
		expect( chips( view ) ).toEqual( [ 'Reset graph' ] );
		press( view, 'Force canvas' );
		expect( chips( view ) ).toHaveLength( 3 );
	} );

	it( 'leave the rest of the frame as it was', () => {
		store( FORCE_CANVAS_STORAGE_KEY );
		const view = mount( { frameProps } );
		expect( view.find( '.topology-canvas__meta' ).textContent ).toBe(
			'quay'
		);
	} );
} );

describe( 'the schematic’s layout', () => {
	const swipe = ( view ) =>
		fireEvent.wheel( view.svg(), { deltaX: 37, deltaY: 21 } );
	const picture = ( view ) => [
		view.svg().getAttribute( 'viewBox' ),
		...view
			.all( '.topology-node' )
			.map( ( el ) => el.getAttribute( 'transform' ) ),
	];

	it( 'is neither moved nor written while the force canvas shows', () => {
		const view = mount();
		const fitted = picture( view );
		swipe( view );
		act( () => jest.advanceTimersByTime( 1000 ) );
		const before = picture( view );
		const saved = window.localStorage.getItem( LAYOUT_KEY );
		expect( before ).not.toEqual( fitted );
		expect( layoutCalls ).toContain( 'onViewportChange' );

		layoutCalls = [];
		press( view, 'Force canvas' );
		swipe( view );
		const tap = view.find( `${ FORCE } [data-id="tap-7"]` );
		const at = tap.getAttribute( 'transform' );
		mouse( 'mousedown', tap );
		mouse( 'mousemove', window, { clientX: 520, clientY: 390 } );
		mouse( 'mouseup', window, { clientX: 520, clientY: 390 } );
		expect( tap.getAttribute( 'transform' ) ).not.toBe( at );
		act( () => jest.advanceTimersByTime( 1000 ) );
		expect( layoutCalls ).toEqual( [] );
		expect( window.localStorage.getItem( LAYOUT_KEY ) ).toBe( saved );

		press( view, 'Force canvas' );
		act( () => jest.advanceTimersByTime( 1000 ) );
		expect( picture( view ) ).toEqual( before );
		expect( window.localStorage.getItem( LAYOUT_KEY ) ).toBe( saved );
	} );

	it( 'in the default fit is the same after the switch and back', () => {
		const view = mount();
		act( () => jest.advanceTimersByTime( 1000 ) );
		const before = picture( view );
		const saved = window.localStorage.getItem( LAYOUT_KEY );
		expect( JSON.parse( saved ).viewportDelta ).toEqual( {
			dcx: 0,
			dcy: 0,
			zoom: 1,
		} );

		layoutCalls = [];
		press( view, 'Force canvas' );
		act( () => jest.advanceTimersByTime( 1000 ) );
		expect( layoutCalls ).toEqual( [] );
		expect( window.localStorage.getItem( LAYOUT_KEY ) ).toBe( saved );

		press( view, 'Force canvas' );
		expect( picture( view ) ).toEqual( before );
		expect( window.localStorage.getItem( LAYOUT_KEY ) ).toBe( saved );
		act( () => jest.advanceTimersByTime( 1000 ) );
		expect( picture( view ) ).toEqual( before );
		expect( window.localStorage.getItem( LAYOUT_KEY ) ).toBe( saved );
	} );

	it( 'is told that its host is not interactive', () => {
		mount( { interactive: false } );
		expect( mockHanded.schematic.interactive ).toBe( false );
	} );

	it( 'takes a drop from the Palette, and the force canvas takes none', () => {
		const onDropNode = jest.fn();
		const view = mount( { showPalette: true, onDropNode } );
		document.elementFromPoint = () => view.svg();
		const drop = () => {
			const tile = view.find( '[data-shell-name="Echo"]' );
			fireEvent.pointerDown( tile, { button: 0 } );
			fireEvent.pointerUp( tile, { button: 0 } );
		};
		drop();
		expect( onDropNode ).toHaveBeenCalledTimes( 1 );
		press( view, 'Force canvas' );
		drop();
		expect( onDropNode ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'what the schematic leaves behind', () => {
	it( 'is no open grid, when a key turns the force canvas on', () => {
		const view = mount();
		fireEvent.click( view.find( '[data-owner="vat-33"]' ) );
		expect( view.all( '.topology-sidecars__card' ) ).toHaveLength( 1 );
		// As Enter on the button does: a click, and no press before it.
		press( view, 'Force canvas' );
		expect( Core.node( SIDECAR_POLLER ) ).toBeNull();
		press( view, 'Force canvas' );
		expect( view.all( '.topology-sidecars__card' ) ).toHaveLength( 0 );
	} );

	it( 'is no hover, whose pointer left with the canvas', () => {
		const view = mount();
		act( () => mockHanded.schematic.onHover( 'tap-7' ) );
		expect( mockHanded.schematic.hoveredId ).toBe( 'tap-7' );
		press( view, 'Force canvas' );
		expect( mockHanded.force.hoveredId ).toBeNull();
	} );
} );

describe( 'the force canvas', () => {
	beforeEach( () => store( FORCE_CANVAS_STORAGE_KEY ) );

	it( 'asks about sidecars once the live graph has answered', () => {
		mount();
		expect( mockHanded.force.seeded ).toBe( true );
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
		landPoll( LIVE );
		expect( mockHanded.force.seeded ).toBe( false );
		expect( Core.node( FORCE_POLLER ) ).not.toBeNull();
	} );

	it( 'is handed the rates the Inspector reads, and each poll of them', () => {
		const view = mount();
		landPoll( LIVE );
		const { rateVersion } = mockHanded.force;
		act( () => jest.advanceTimersByTime( 2000 ) );
		landPoll(
			parseMetadata( {
				...CANVAS_ROWS,
				'tap-7': { ...ROWS[ 'tap-7' ], counter: 2 + 50 },
			} )
		);
		expect( mockHanded.force.rateVersion ).toBeGreaterThan( rateVersion );
		expect( mockHanded.force.rateRef.current.get( 'tap-7' ).rate ).toBe(
			25
		);
		expect(
			view
				.find( `${ FORCE } [data-id="tap-7"]` )
				.classList.contains( 'is-live' )
		).toBe( true );
	} );

	it( 'is handed drift, hulls, the tree and the scope', () => {
		const driftIds = new Set( [ 'tap-7' ] );
		mount( { ...DOCK, driftIds } );
		expect( mockHanded.force ).toMatchObject( {
			parsed: LIVE,
			driftIds,
			hulls: DOCK.hulls,
			tree: DOCK.includeTree,
			resetKey: SCOPE,
			editMode: false,
		} );
	} );

	it( 'is handed one list of hulls, and one tree, by a host without any', () => {
		const view = mount();
		const { hulls, tree } = mockHanded.force;
		view.update( { debugLevel: 2 } );
		expect( mockHanded.force.hulls ).toBe( hulls );
		expect( mockHanded.force.tree ).toBe( tree );
	} );

	it( 'is the canvas GraphView holds, and the schematic after it', () => {
		const view = mount();
		const { svgRef } = mockHanded.force;
		expect( svgRef.current ).toBe( view.find( FORCE ) );
		press( view, 'Force canvas' );
		expect( mockHanded.schematic.svgRef ).toBe( svgRef );
		expect( svgRef.current ).toBe( view.find( SCHEMATIC ) );
	} );

	it( 'hands back its hover', () => {
		const view = mount();
		const tap = view.find( `${ FORCE } [data-id="tap-7"]` );
		fireEvent(
			tap,
			new window.MouseEvent( 'pointerover', { bubbles: true } )
		);
		expect( mockHanded.force.hoveredId ).toBe( 'tap-7' );
	} );
} );

describe( 'a sidecar picked on the force canvas', () => {
	beforeEach( () => store( FORCE_CANVAS_STORAGE_KEY ) );

	it.each( [ 'vat-33:feed', 'vat-33:feed:valve' ] )(
		'%s selects the root of its chain and shows itself',
		( name ) => {
			const onSelectionChange = jest.fn();
			const view = mount( { onSelectionChange } );
			landPoll( LIVE );
			CANVASES.force.sidecar( view, 'vat-33', name );
			expect( onSelectionChange.mock.calls ).toEqual( [ [ 'vat-33' ] ] );
			expect( mockHanded.force ).toMatchObject( {
				selectedId: 'vat-33',
				sidecar: name,
			} );
			answer( SIDECAR_POLLER, [ name ] );
			expect( view.title() ).toBe( name );
			expect( view.find( '.topology-insp__type' ).textContent ).toMatch(
				new RegExp( ROWS[ name ].class )
			);
		}
	);

	it( 'goes with its selection, by a press of its patron', () => {
		const view = mount();
		landPoll( LIVE );
		CANVASES.force.sidecar( view, 'vat-33', 'vat-33:feed' );
		CANVASES.force.node( view, 'vat-33' );
		expect( mockHanded.force.sidecar ).toBeNull();
		expect( view.title() ).toBe( 'vat-33' );
	} );

	it( 'goes with its selection, by Escape on the canvas', () => {
		const view = mount();
		landPoll( LIVE );
		CANVASES.force.sidecar( view, 'vat-33', 'vat-33:feed' );
		act( () => view.svg().focus() );
		fireEvent.keyDown( view.svg(), { key: 'Escape' } );
		expect( mockHanded.force ).toMatchObject( {
			selectedId: null,
			sidecar: null,
		} );
		expect( toggle( view, 'Force canvas' ) ).toBeDefined();
	} );

	it.each( [ 'Delete', 'Backspace' ] )( 'is not removed by %s', ( key ) => {
		const onRemoveNode = jest.fn();
		const view = mount( { onRemoveNode } );
		landPoll( LIVE );
		CANVASES.force.sidecar( view, 'vat-33', 'vat-33:feed' );
		fireEvent.keyDown( view.svg(), { key } );
		expect( onRemoveNode ).not.toHaveBeenCalled();
	} );
} );

describe.each( Object.keys( CANVASES ) )( 'on the %s canvas', ( name ) => {
	const canvas = CANVASES[ name ];
	const draft = { ...DOCK, editMode: true, graph: DRAFT };
	const removals = () => ( {
		onRemoveNode: jest.fn(),
		onRemoveEdge: jest.fn(),
		onRemoveInclude: jest.fn(),
	} );
	const ran = ( on ) =>
		Object.entries( on ).flatMap( ( [ which, fn ] ) =>
			fn.mock.calls.map( ( args ) => [ which, ...args ] )
		);

	beforeEach( () => store( ...canvas.keys ) );

	it.each( [
		[ 'node', [ 'press-61' ], [ 'onRemoveNode', 'press-61' ] ],
		[
			'edge',
			[ 'press-61', 'tap-7' ],
			[ 'onRemoveEdge', 'press-61', 'tap-7' ],
		],
		[ 'hull', [ 'dock' ], [ 'onRemoveInclude', 'dock' ] ],
	] )( 'Delete in a draft removes the selected %s', ( kind, at, call ) => {
		const on = removals();
		const view = mount( { ...draft, ...on } );
		canvas[ kind ]( view, ...at );
		expect( view.svg().querySelectorAll( '.is-selected' ) ).toHaveLength(
			1
		);
		fireEvent.keyDown( view.svg(), { key: 'Delete' } );
		expect( ran( on ) ).toEqual( [ call ] );
	} );

	it.each( [
		[ 'node', [ 'press-61' ] ],
		[ 'edge', [ 'press-61', 'tap-7' ] ],
		[ 'hull', [ 'dock' ] ],
	] )( 'a press of the canvas lets go of the selected %s', ( kind, at ) => {
		const onSelectionChange = jest.fn();
		const view = mount( {
			...draft,
			onSelectionChange,
			selection: undefined,
		} );
		canvas[ kind ]( view, ...at );
		onSelectionChange.mockClear();
		canvas.empty( view );
		expect( onSelectionChange.mock.calls ).toEqual( [ [ null ] ] );
		expect( mockHanded[ name ] ).toMatchObject( {
			selectedId: null,
			selectedEdge: null,
			selectedHull: null,
		} );
	} );

	it( 'a picked sidecar tells the consumer listening now', () => {
		const first = jest.fn();
		const onSelectionChange = jest.fn();
		const view = mount( { onSelectionChange: first } );
		landPoll( LIVE );
		view.update( { onSelectionChange } );
		canvas.sidecar( view, 'vat-33', 'vat-33:feed' );
		expect( first ).not.toHaveBeenCalled();
		expect( onSelectionChange.mock.calls ).toEqual( [ [ 'vat-33' ] ] );
	} );

	it( 'Delete in a draft leaves a borrowed node', () => {
		const on = removals();
		const view = mount( { ...draft, ...on } );
		canvas.node( view, 'vat-33' );
		expect( view.panel().textContent ).toContain( 'vat-33' );
		fireEvent.keyDown( view.svg(), { key: 'Delete' } );
		expect( ran( on ) ).toEqual( [] );
	} );

	it( 'the Inspector renames the selected node of a draft', () => {
		const onRenameNode = jest.fn( () => true );
		const view = mount( { ...draft, onRenameNode } );
		canvas.node( view, 'press-61' );
		const field = view
			.all( '.topology-inspector input' )
			.find( ( input ) => 'press-61' === input.value );
		fireEvent.change( field, { target: { value: 'press-62' } } );
		fireEvent.blur( field );
		expect( onRenameNode.mock.calls ).toEqual( [
			[ 'press-61', 'press-62' ],
		] );
	} );
} );

describe( 'the Inspector', () => {
	const draft = { ...DOCK, editMode: true, graph: DRAFT };

	/**
	 * What the Inspector renders for a selection on one canvas.
	 *
	 * @param {string}                                 on    The canvas.
	 * @param {Object}                                 props GraphView's props.
	 * @param {(canvas: Object, view: Object) => void} pick  Selects on the mounted canvas.
	 * @return {string} Its panel's markup.
	 */
	const panelOn = ( on, props, pick ) => {
		window.localStorage.clear();
		store( ...CANVASES[ on ].keys );
		const view = mount( props );
		landPoll( LIVE );
		pick( CANVASES[ on ], view );
		const markup = view.panel().outerHTML;
		view.unmount();
		return markup;
	};

	it.each( [
		[ 'a node', 'vat-33', {}, 'node', [ 'vat-33' ] ],
		[ 'a hull', 'dock', DOCK, 'hull', [ 'dock' ] ],
		[ 'a node of a draft', 'press-61', draft, 'node', [ 'press-61' ] ],
		[ 'a borrowed node', 'vat-33', draft, 'node', [ 'vat-33' ] ],
		[ 'a hull of a draft', 'dock', draft, 'hull', [ 'dock' ] ],
		[
			'a sidecar',
			'vat-33:feed',
			{},
			'sidecar',
			[ 'vat-33', 'vat-33:feed' ],
		],
	] )( 'shows %s the same on both', ( _, text, props, kind, at ) => {
		const pick = ( canvas, view ) => {
			canvas[ kind ]( view, ...at );
			if ( 'sidecar' === kind ) {
				answer( SIDECAR_POLLER, at );
			}
		};
		const onForce = panelOn( 'force', props, pick );
		expect( onForce ).toContain( text );
		expect( onForce ).toBe( panelOn( 'schematic', props, pick ) );
	} );
} );
