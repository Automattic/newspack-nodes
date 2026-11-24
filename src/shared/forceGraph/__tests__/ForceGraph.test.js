/**
 * Tests for the force graph's component: what it draws, what a press, a key
 * and a gesture do, and when it lays out, fits and paints. d3 and the engine
 * are the real ones, the engine wrapped to show it.
 *
 * d3-timer binds the frame scheduler as it loads, so the fake timers come
 * first and the modules are required after them.
 */

let mockEngine;

jest.mock( '../engine', () => {
	const actual = jest.requireActual( '../engine' );
	return {
		...actual,
		createEngine: ( options ) =>
			( mockEngine = actual.createEngine( options ) ),
	};
} );

jest.useFakeTimers();

const { act, render } = require( '@testing-library/react' );
const { createRef } = require( '@wordpress/element' );
const { polygonCentroid, polygonContains, zoomTransform } = require( 'd3' );
const { installSvgBox } = require( '../../test-utils/svgBox' );
const { installViewport } = require( '../../test-utils/viewportWidth' );
const { ZOOM_STEP } = require( '../../utils/wheelGesture' );
const { ForceGraph } = require( '..' );
const { hullPoints } = require( '../hulls' );
const path = require( 'path' );
const postcss = require( 'postcss' );
const sass = require( 'sass' );
const read = require( '../../../build-kit/css-reader.cjs' );

const SHEET = path.resolve( __dirname, '../ForceGraph.scss' );

const BLOCK = 'newspack-nodes-force-graph';

/** Where the canvas stands in the window, which a pointer is read against. */
const LEFT = 31;
const TOP = 17;

/** Milliseconds that end a run of moves. */
const GAP = 150;

/** Frames an opening layout stops within, unless a poll holds its energy. */
const OPENING = 900;

/** Frames no layout here needs. */
const TOO_MANY = 4000;

/**
 * The component's stylesheet, without what jsdom does not read: `:has( > … )`.
 *
 * @return {Object} The parsed sheet.
 */
const readableSheet = () => {
	const sheet = postcss.parse( sass.compile( SHEET ).css );
	sheet.walkRules( /:has\(/, ( rule ) => rule.remove() );
	return sheet;
};

let box;
let svgBox;
let observers;
let viewport;

const graph = () => ( {
	nodes: [
		{ id: 'n1', label: 'First', group: 'out' },
		{ id: 'n2', label: 'A <b>second</b> one', group: 'out/in' },
		{ id: 'n3', label: 'Third', group: 'out/in', className: 'is-odd' },
		{
			id: 'n4',
			label: 'Fourth',
			size: 21,
			detail: '4,242',
			title: 'Fourth\n4,242 objects',
		},
	],
	links: [
		{ id: 'l1', source: 'n1', target: 'n2', directed: true, title: 'owns' },
		{ id: 'l2', source: 'n2', target: 'n3', className: 'is-dotted' },
		{ id: 'l3', source: 'n3', target: 'n4' },
		{ id: 'gone', source: 'n1', target: 'nobody' },
	],
	groups: [
		{ id: 'out', label: 'Outer' },
		{ id: 'out/in', label: 'Inner', parent: 'out', className: 'is-teal' },
	],
} );

const setBox = ( width, height ) => {
	box = { width, height };
	svgBox.setSize( width, height );
};

const frames = ( count ) =>
	act( () => {
		for ( let i = 0; i < count; i++ ) {
			jest.advanceTimersToNextFrame();
		}
	} );

const wait = ( ms ) => act( () => jest.advanceTimersByTime( ms ) );

const settle = () => {
	let count = 0;
	while ( mockEngine.running() && count++ < TOO_MANY ) {
		frames( 1 );
	}
	expect( mockEngine.running() ).toBe( false );
};

/**
 * Mount the component, with the fixture and a key, and run no frame.
 *
 * @param {Object} [props] Props over those of the fixture.
 * @return {Object} The svg, a way to re-render it, and its unmount.
 */
const open = ( props = {} ) => {
	let held = {
		...graph(),
		layoutKey: 'k7',
		ariaLabel: 'Orchard map',
		...props,
	};
	const view = render( <ForceGraph { ...held } /> );
	return {
		svg: view.container.querySelector( 'svg' ),
		unmount: view.unmount,
		update: ( next ) => {
			held = { ...held, ...next };
			view.rerender( <ForceGraph { ...held } /> );
		},
	};
};

// Mount it and run one frame, the first of its layout that is painted.
const mount = ( props ) => {
	const mounted = open( props );
	frames( 1 );
	return mounted;
};

const mountSettled = ( props ) => {
	const view = mount( props );
	settle();
	return view;
};

const all = ( svg, name ) => [
	...svg.querySelectorAll( `.${ BLOCK }__${ name }` ),
];
const nodeEl = ( svg, id ) =>
	all( svg, 'node' ).find( ( el ) => id === el.dataset.id );
const linkEl = ( svg, i ) => all( svg, 'link' )[ i ];
const hullEl = ( svg, i ) => all( svg, 'hull' )[ i ];
const textOf = ( el, name ) =>
	el.querySelector( `.${ BLOCK }__${ name }` )?.textContent;

const leaf = ( id ) => mockEngine.model().byId.get( id );
const spots = () =>
	mockEngine.model().leaves.map( ( { id, x, y } ) => [ id, x, y ] );
const at = ( el ) =>
	el
		.getAttribute( 'transform' )
		.match( /-?[\d.]+(?:e-?\d+)?/g )
		.map( Number );
const view = ( svg ) => {
	const { x, y, k } = zoomTransform( svg );
	return { x, y, k };
};

const expectNear = ( one, two ) =>
	one.forEach( ( value, i ) => expect( value ).toBeCloseTo( two[ i ], 6 ) );

/** The view that shows every label with 50 to spare, over 0.9 of the box. */
const fitted = () => {
	const { leaves } = mockEngine.model();
	const side = ( pick, sign, half ) =>
		leaves.map( ( one ) => one[ pick ] + sign * one[ half ] );
	const minX = Math.min( ...side( 'x', -1, 'halfW' ) ) - 50;
	const maxX = Math.max( ...side( 'x', 1, 'halfW' ) ) + 50;
	const minY = Math.min( ...side( 'y', -1, 'halfH' ) ) - 50;
	const maxY = Math.max( ...side( 'y', 1, 'halfH' ) ) + 50;
	const k =
		0.9 *
		Math.min( box.width / ( maxX - minX ), box.height / ( maxY - minY ) );
	return {
		x: box.width / 2 - ( ( minX + maxX ) / 2 ) * k,
		y: box.height / 2 - ( ( minY + maxY ) / 2 ) * k,
		k,
	};
};

const expectFitted = ( svg ) => {
	const { x, y, k } = fitted();
	const shown = view( svg );
	expectNear( [ shown.x, shown.y, shown.k ], [ x, y, k ] );
	expect( all( svg, 'view' )[ 0 ].getAttribute( 'transform' ) ).toBe(
		zoomTransform( svg ).toString()
	);
};

const mouse = ( type, target, x, y, init = {} ) =>
	act( () => {
		target.dispatchEvent(
			new window.MouseEvent( type, {
				view: window,
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				...init,
			} )
		);
	} );

const down = ( el, x = 400, y = 300, init = {} ) =>
	mouse( 'mousedown', el, x, y, init );
const move = ( x, y ) => mouse( 'mousemove', window, x, y );
const up = ( x, y ) => mouse( 'mouseup', window, x, y );

/**
 * Press an element and let go `by` pixels away.
 *
 * @param {Element}          el   What is pressed.
 * @param {[number, number]} [by] Pixels from press to release.
 */
const press = ( el, by = [ 0, 0 ] ) => {
	const [ x, y ] = [ 400 + by[ 0 ], 300 + by[ 1 ] ];
	down( el );
	if ( by[ 0 ] || by[ 1 ] ) {
		move( x, y );
	}
	up( x, y );
	mouse( 'click', el, x, y );
	wait( 1 );
};

// jsdom has no PointerEvent, and nothing read here is its alone.
const pointer = ( type, el, init = {} ) =>
	act( () => {
		el.dispatchEvent(
			new window.MouseEvent( type, { bubbles: true, ...init } )
		);
	} );

/**
 * Change one touch. d3 reads touches only of a screen that has some.
 *
 * @param {string}           type     The event's type.
 * @param {Element}          el       What the finger went down on.
 * @param {number}           id       The finger.
 * @param {[number, number]} point    Where it is.
 * @param {Object[]}         [others] The fingers that stay down.
 * @return {Object} The touch.
 */
const touch = ( type, el, id, [ clientX, clientY ], others = [] ) => {
	const one = { identifier: id, target: el, clientX, clientY };
	const isDown = [ 'touchstart', 'touchmove' ].includes( type );
	const e = new window.Event( type, { bubbles: true, cancelable: true } );
	Object.assign( e, {
		changedTouches: [ one ],
		touches: isDown ? [ ...others, one ] : others,
	} );
	act( () => {
		el.dispatchEvent( e );
	} );
	return one;
};

const touchScreen = () =>
	Object.defineProperty( window.navigator, 'maxTouchPoints', {
		configurable: true,
		value: 5,
	} );

// The point of the window over a node.
const over = ( svg, id ) => {
	const [ x, y ] = zoomTransform( svg ).apply( [
		leaf( id ).x,
		leaf( id ).y,
	] );
	return [ x + LEFT, y + TOP ];
};

// What each read of `performance.now`, which d3 reads, moves it on by, and has.
let perRead = 0;
let added = 0;

/** Make a frame that is not painted a slice of two or three ticks. */
const slicing = () => {
	perRead = 5;
};

let clock = 1000;

/**
 * Turn the wheel over the canvas.
 *
 * @param {Element} svg     The canvas.
 * @param {Object}  init    The event's fields.
 * @param {number}  [after] Milliseconds since the last one.
 * @return {WheelEvent} The event.
 */
const wheel = ( svg, init, after = 1000 ) => {
	const e = new window.WheelEvent( 'wheel', {
		bubbles: true,
		cancelable: true,
		clientX: 531,
		clientY: 217,
		...init,
	} );
	clock += after;
	Object.defineProperty( e, 'timeStamp', { value: clock } );
	act( () => {
		svg.dispatchEvent( e );
	} );
	return e;
};

const gesture = ( svg, type, scale ) => {
	const e = new window.Event( type, { bubbles: true, cancelable: true } );
	Object.assign( e, { scale, clientX: 531, clientY: 217 } );
	act( () => {
		svg.dispatchEvent( e );
	} );
	return e;
};

const key = ( name, init = {}, target = document.body ) => {
	const e = new window.KeyboardEvent( 'keydown', {
		key: name,
		bubbles: true,
		cancelable: true,
		...init,
	} );
	act( () => {
		target.dispatchEvent( e );
	} );
	return e;
};

const focus = ( svg ) => act( () => svg.focus() );

// The point of the canvas under (531, 217), in the graph's own units.
const underPointer = ( svg ) =>
	zoomTransform( svg ).invert( [ 531 - LEFT, 217 - TOP ] );

beforeEach( () => {
	perRead = 0;
	const now = performance.now.bind( performance );
	jest.spyOn( performance, 'now' ).mockImplementation(
		() => now() + ( added += perRead )
	);
	svgBox = installSvgBox( 0, 0, { left: LEFT, top: TOP } );
	setBox( 1313, 777 );
	observers = [];
	viewport = installViewport( false );
	global.ResizeObserver = class {
		constructor( callback ) {
			this.callback = callback;
		}
		observe( el ) {
			observers.push( this );
			this.el = el;
		}
		disconnect() {
			observers = observers.filter( ( one ) => one !== this );
		}
	};
} );

afterEach( () => {
	viewport.restore();
	svgBox.restore();
	jest.restoreAllMocks();
	delete global.ResizeObserver;
	delete window.navigator.maxTouchPoints;
} );

const resize = ( width, height ) => {
	setBox( width, height );
	act( () =>
		observers.forEach( ( { callback } ) =>
			callback( [ { contentRect: box } ] )
		)
	);
};

describe( 'what it draws', () => {
	it( 'is one focusable, named svg, with the host’s class', () => {
		const { svg, update } = mount( { className: 'orchard' } );
		expect( svg.getAttribute( 'tabindex' ) ).toBe( '0' );
		expect( svg.getAttribute( 'role' ) ).toBe( 'application' );
		expect( svg.getAttribute( 'aria-label' ) ).toBe( 'Orchard map' );
		expect( [ ...svg.classList ] ).toEqual( [ BLOCK, 'orchard' ] );
		update( { className: undefined } );
		expect( [ ...svg.classList ] ).toEqual( [ BLOCK ] );
	} );

	it( 'hands its svg to a host that asks, until it unmounts', () => {
		const svgRef = createRef();
		const { svg, update, unmount } = mount( { svgRef } );
		expect( svgRef.current ).toBe( svg );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		const another = createRef();
		update( { svgRef: another } );
		expect( svgRef.current ).toBeNull();
		expect( another.current ).toBe( svg );
		unmount();
		expect( another.current ).toBeNull();
	} );

	it( 'draws a node, a line and a hull for each, and no dangling line', () => {
		const { svg } = mount();
		expect( all( svg, 'node' ).map( ( el ) => el.dataset.id ) ).toEqual( [
			'n1',
			'n2',
			'n3',
			'n4',
		] );
		expect( all( svg, 'link' ) ).toHaveLength( 3 );
		expect( all( svg, 'hull' ) ).toHaveLength( 2 );
	} );

	it( 'draws without groups', () => {
		const { nodes, links } = graph();
		const bare = nodes.map( ( { group: _group, ...rest } ) => rest );
		const { svg } = mount( { nodes: bare, links, groups: undefined } );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		expect( all( svg, 'hull' ) ).toHaveLength( 0 );
	} );

	it( 'draws hulls outermost first, under lines, under nodes', () => {
		const { svg } = mount();
		expect(
			all( svg, 'hull-label' ).map( ( el ) => el.textContent )
		).toEqual( [ 'Outer', 'Inner' ] );
		const order = [
			hullEl( svg, 1 ),
			linkEl( svg, 0 ),
			nodeEl( svg, 'n1' ),
		];
		const painted = [ ...svg.querySelectorAll( 'path, g' ) ].filter(
			( el ) => order.includes( el )
		);
		expect( painted ).toEqual( order );
	} );

	it( 'draws a label in a rect of its width, as text', () => {
		const { svg } = mount();
		const el = nodeEl( svg, 'n2' );
		const rect = el.querySelector( 'rect' );
		const { halfW, halfH } = leaf( 'n2' );
		expect( Number( rect.getAttribute( 'width' ) ) ).toBe( 2 * halfW );
		expect( Number( rect.getAttribute( 'height' ) ) ).toBe( 2 * halfH );
		expect( Number( rect.getAttribute( 'x' ) ) ).toBe( -halfW );
		expect( Number( rect.getAttribute( 'y' ) ) ).toBe( -halfH );
		expect( textOf( el, 'label' ) ).toBe( 'A <b>second</b> one' );
		expect( el.querySelector( 'b' ) ).toBeNull();
		expect( el.querySelector( 'circle' ) ).toBeNull();
		expect( el.querySelector( 'title' ) ).toBeNull();
	} );

	it( 'draws a sized node as a circle, its label above, its detail in it', () => {
		const { svg } = mount();
		const el = nodeEl( svg, 'n4' );
		expect( el.querySelector( 'circle' ).getAttribute( 'r' ) ).toBe( '21' );
		expect( el.querySelector( 'rect' ) ).toBeNull();
		expect( textOf( el, 'label' ) ).toBe( 'Fourth' );
		expect( textOf( el, 'detail' ) ).toBe( '4,242' );
		expect(
			Number(
				el.querySelector( `.${ BLOCK }__label` ).getAttribute( 'y' )
			)
		).toBeLessThan( -21 );
		expect( el.querySelector( 'title' ).textContent ).toBe(
			'Fourth\n4,242 objects'
		);
		expect( el.classList.contains( 'is-sized' ) ).toBe( true );
		expect( nodeEl( svg, 'n1' ).classList.contains( 'is-sized' ) ).toBe(
			false
		);
	} );

	it( 'draws a detail in a circle alone, and only one it has', () => {
		const { nodes } = graph();
		nodes[ 0 ].detail = 'unseen';
		delete nodes[ 3 ].detail;
		const { svg } = mount( { nodes } );
		expect( all( svg, 'detail' ) ).toHaveLength( 0 );
	} );

	it( 'redraws a node that gains and loses a size, its text on top', () => {
		const { svg, update } = mountSettled();
		const { nodes } = graph();
		const swapped = nodes.map( ( { size, detail, title, ...rest } ) =>
			'n1' === rest.id
				? { ...rest, size: 33, detail: '7', title: 'One' }
				: rest
		);
		update( { nodes: swapped } );
		const grown = nodeEl( svg, 'n1' );
		expect( grown.querySelector( 'circle' ).getAttribute( 'r' ) ).toBe(
			'33'
		);
		expect( grown.querySelector( 'rect' ) ).toBeNull();
		expect( grown.firstChild.tagName ).toBe( 'circle' );
		const shrunk = nodeEl( svg, 'n4' );
		expect( shrunk.querySelector( 'circle' ) ).toBeNull();
		expect( shrunk.querySelector( 'title' ) ).toBeNull();
		expect( textOf( shrunk, 'detail' ) ).toBeUndefined();
		expect( shrunk.firstChild.tagName ).toBe( 'rect' );
		expect( textOf( shrunk, 'label' ) ).toBe( 'Fourth' );
	} );

	it( 'gives a directed line alone an arrowhead, its own in each graph', () => {
		const markers = [ mount().svg, mount().svg ].map( ( svg ) => {
			const [ , id ] = linkEl( svg, 0 )
				.getAttribute( 'marker-end' )
				.match( /^url\(#(.+)\)$/ );
			expect( linkEl( svg, 1 ).hasAttribute( 'marker-end' ) ).toBe(
				false
			);
			const marker = svg.querySelector( 'marker' );
			expect( marker.id ).toBe( id );
			return id;
		} );
		expect( markers[ 0 ] ).not.toBe( markers[ 1 ] );
	} );

	it( 'gives a line its title', () => {
		const { svg } = mount();
		expect( linkEl( svg, 0 ).querySelector( 'title' ).textContent ).toBe(
			'owns'
		);
		expect( linkEl( svg, 1 ).querySelector( 'title' ) ).toBeNull();
	} );

	it.each( [
		[ {}, 1 ],
		[ { weight: 9 }, 3 ],
		[ { weight: 4 }, 1 + 2 * Math.log10( 5 ) ],
		[ { rate: 0 }, 1 ],
		[ { rate: 9 }, 3 ],
		[ { rate: 4 }, 1 + 2 * Math.log10( 5 ) ],
		[ { weight: 4, rate: 0 }, 1 + 2 * Math.log10( 5 ) ],
		[ { weight: 4, rate: 9 }, 3 ],
		[ { weight: 9, rate: 4 }, 3 ],
	] )( 'draws a line of %j %f wide', ( extra, width ) => {
		const { links } = graph();
		const { svg } = mount( { links: [ { ...links[ 1 ], ...extra } ] } );
		expect(
			Number( linkEl( svg, 0 ).getAttribute( 'stroke-width' ) )
		).toBeCloseTo( width, 9 );
	} );

	it.each( [
		[ {}, null, false ],
		[ { rate: 0 }, '0.25', false ],
		[ { rate: 0.01 }, '0.9', true ],
		[ { rate: 77 }, '0.9', true ],
	] )( 'draws a line of %j at opacity %s', ( extra, opacity, live ) => {
		const { links } = graph();
		const { svg } = mount( { links: [ { ...links[ 1 ], ...extra } ] } );
		expect( linkEl( svg, 0 ).getAttribute( 'opacity' ) ).toBe( opacity );
		expect( [ ...linkEl( svg, 0 ).classList ] ).toEqual( [
			`${ BLOCK }__link`,
			'is-dotted',
			...( live ? [ 'is-live' ] : [] ),
		] );
	} );

	it.each( [
		[ undefined, false ],
		[ 0, false ],
		[ 0.5, true ],
	] )( 'marks a node of rate %s live: %s', ( rate, live ) => {
		const { nodes } = graph();
		nodes[ 2 ].rate = rate;
		const { svg } = mount( { nodes } );
		expect( [ ...nodeEl( svg, 'n3' ).classList ] ).toEqual( [
			`${ BLOCK }__node`,
			'is-odd',
			...( live ? [ 'is-live' ] : [] ),
		] );
	} );

	it( 'marks what is selected and hovered, and follows the host', () => {
		const { svg, update } = mountSettled( {
			selectedId: 'n2',
			hoveredId: 'n3',
			selectedLink: 'l2',
			selectedGroup: 'out/in',
		} );
		const marked = ( name ) =>
			[ ...svg.querySelectorAll( `.${ name }` ) ].map(
				( el ) => el.dataset.id ?? el.getAttribute( 'class' )
			);
		expect( marked( 'is-selected' ) ).toEqual( [
			`${ BLOCK }__hull is-teal is-selected`,
			`${ BLOCK }__link is-dotted is-selected`,
			'n2',
		] );
		expect( marked( 'is-hovered' ) ).toEqual( [ 'n3' ] );
		expect( hullEl( svg, 1 ).classList.contains( 'is-selected' ) ).toBe(
			true
		);
		update( {
			selectedId: 'n4',
			hoveredId: null,
			selectedLink: null,
			selectedGroup: null,
		} );
		expect( marked( 'is-selected' ) ).toEqual( [ 'n4' ] );
		expect( marked( 'is-hovered' ) ).toEqual( [] );
		update( { hoveredId: 'n1' } );
		expect( marked( 'is-hovered' ) ).toEqual( [ 'n1' ] );
		update( { ...graph() } );
		expect( marked( 'is-selected' ) ).toEqual( [ 'n4' ] );
	} );

	it( 'marks what was selected before it was drawn', () => {
		const { svg, update } = mountSettled( {
			selectedId: 'n9',
			selectedLink: 'l9',
			selectedGroup: 'late',
		} );
		const { nodes, links, groups } = graph();
		update( {
			nodes: [ ...nodes, { id: 'n9', label: 'Ninth', group: 'late' } ],
			links: [ ...links, { id: 'l9', source: 'n9', target: 'n1' } ],
			groups: [ ...groups, { id: 'late', label: 'Late' } ],
		} );
		expect( [ ...svg.querySelectorAll( '.is-selected' ) ] ).toHaveLength(
			3
		);
	} );

	it( 'ends a line at the edge of its target', () => {
		const { svg } = mountSettled();
		const ends = ( i ) =>
			linkEl( svg, i )
				.getAttribute( 'd' )
				.match( /^M(.+),(.+)L(.+),(.+)$/ )
				.slice( 1 )
				.map( Number );
		const [ x1, y1, x2, y2 ] = ends( 0 );
		const [ from, to ] = [ leaf( 'n1' ), leaf( 'n2' ) ];
		expectNear( [ x1, y1 ], [ from.x, from.y ] );
		expect(
			Math.max(
				Math.abs( x2 - to.x ) / to.halfW,
				Math.abs( y2 - to.y ) / to.halfH
			)
		).toBeCloseTo( 1, 6 );
		const [ , , cx, cy ] = ends( 2 );
		const circle = leaf( 'n4' );
		expect( Math.hypot( cx - circle.x, cy - circle.y ) ).toBeCloseTo(
			21,
			6
		);
	} );

	it( 'ends an upright line at the near side of its target’s rect', () => {
		const { svg } = mountSettled();
		Object.assign( leaf( 'n1' ), { x: 10, y: 700 } );
		Object.assign( leaf( 'n2' ), { x: 0, y: 0 } );
		press( nodeEl( svg, 'n4' ), [ 9, 0 ] );
		const [ x, y ] = linkEl( svg, 0 )
			.getAttribute( 'd' )
			.split( 'L' )[ 1 ]
			.split( ',' )
			.map( Number );
		expect( y ).toBeCloseTo( leaf( 'n2' ).halfH, 6 );
		expect( x ).toBeCloseTo( ( 10 * leaf( 'n2' ).halfH ) / 700, 6 );
	} );

	it( 'draws a line to itself, and lines between nodes at one place', () => {
		const { nodes } = graph();
		const { svg } = mountSettled( {
			nodes,
			links: [
				{ id: 'self', source: 'n1', target: 'n1' },
				{ id: 'rect', source: 'n4', target: 'n1' },
				{ id: 'circle', source: 'n1', target: 'n4' },
			],
		} );
		Object.assign( leaf( 'n4' ), { x: 123, y: 456 } );
		Object.assign( leaf( 'n1' ), { x: 123, y: 456 } );
		down( nodeEl( svg, 'n3' ) );
		move( 409, 300 );
		expect(
			all( svg, 'link' ).map( ( el ) => el.getAttribute( 'd' ) )
		).toEqual( Array( 3 ).fill( 'M123,456L123,456' ) );
		up( 409, 300 );
	} );

	it( 'draws each hull round its leaves, its label above it', () => {
		const { svg } = mountSettled();
		const hulls = all( svg, 'hull' ).map( ( el ) =>
			el
				.getAttribute( 'd' )
				.slice( 1, -1 )
				.split( 'L' )
				.map( ( point ) => point.split( ',' ).map( Number ) )
		);
		hulls[ 1 ].forEach( ( point, i ) =>
			expectNear(
				point,
				hullPoints( [ leaf( 'n2' ), leaf( 'n3' ) ] )[ i ]
			)
		);
		[ 'n1', 'n2', 'n3' ].forEach( ( id ) =>
			expect(
				polygonContains( hulls[ 0 ], [ leaf( id ).x, leaf( id ).y ] )
			).toBe( true )
		);
		const top = Math.min( ...hulls[ 0 ].map( ( [ , y ] ) => y ) );
		const label = all( svg, 'hull-label' )[ 0 ];
		expect( Number( label.getAttribute( 'y' ) ) ).toBeLessThan( top );
		const xs = hulls[ 0 ].map( ( [ x ] ) => x );
		expect( Number( label.getAttribute( 'x' ) ) ).toBeGreaterThan(
			Math.min( ...xs )
		);
		expect( Number( label.getAttribute( 'x' ) ) ).toBeLessThan(
			Math.max( ...xs )
		);
	} );

	it( 'paints each frame where the engine put the nodes', () => {
		const { svg } = mount();
		const check = () =>
			all( svg, 'node' ).forEach( ( el ) => {
				const { x, y } = leaf( el.dataset.id );
				expectNear( at( el ), [ x, y ] );
			} );
		check();
		const before = spots();
		frames( 3 );
		expect( spots() ).not.toEqual( before );
		check();
	} );

	it( 'writes positions alone on a frame of motion', () => {
		const { svg } = mount();
		const wrote = [ nodeEl( svg, 'n2' ), linkEl( svg, 1 ) ].map( ( el ) =>
			jest.spyOn( el, 'setAttribute' )
		);
		frames( 3 );
		expect(
			wrote.map( ( { mock } ) => [
				...new Set( mock.calls.map( ( [ name ] ) => name ) ),
			] )
		).toEqual( [ [ 'transform' ], [ 'd' ] ] );
	} );

	it( 'keeps a body’s element through a change before it', () => {
		const { svg, update } = mountSettled();
		const { nodes, links, groups } = graph();
		const kept = [
			nodeEl( svg, 'n3' ),
			linkEl( svg, 1 ),
			all( svg, 'hull' )[ 1 ],
		];
		update( {
			nodes: nodes.slice( 1 ).map( ( one ) => ( { ...one } ) ),
			links: links.slice( 1 ),
			groups,
		} );
		expect( nodeEl( svg, 'n3' ) ).toBe( kept[ 0 ] );
		expect( linkEl( svg, 0 ) ).toBe( kept[ 1 ] );
		expect( all( svg, 'hull' )[ 0 ] ).toBe( kept[ 2 ] );
	} );

	it( 'drops what the host dropped and adds what it added', () => {
		const { svg, update } = mountSettled();
		const { nodes, links } = graph();
		update( {
			nodes: [
				...nodes.slice( 1, 3 ),
				{ id: 'n9', label: 'Ninth', group: 'late' },
			],
			links: [ links[ 1 ], { id: 'l9', source: 'n9', target: 'n2' } ],
			groups: [ ...graph().groups, { id: 'late', label: 'Late' } ],
		} );
		expect( all( svg, 'node' ).map( ( el ) => el.dataset.id ) ).toEqual( [
			'n2',
			'n3',
			'n9',
		] );
		expect( all( svg, 'link' ) ).toHaveLength( 2 );
		expect(
			all( svg, 'hull-label' )
				.map( ( el ) => el.textContent )
				.sort()
		).toEqual( [ 'Inner', 'Late' ] );
		expectNear( at( nodeEl( svg, 'n9' ) ), [
			leaf( 'n9' ).x,
			leaf( 'n9' ).y,
		] );
	} );
} );

describe( 'a target for a press', () => {
	const onSelectLink = () => {};
	const paths = ( els ) => els.map( ( el ) => el.getAttribute( 'd' ) );
	const aims = ( svg ) =>
		all( svg, 'hit' ).map( ( el ) => el.__data__.link.id );
	const barring = ( id ) =>
		graph().links.map( ( one ) => ( {
			...one,
			pressable: id !== one.id,
		} ) );

	it( 'lies over each line that takes one, and follows it', () => {
		const { svg } = mount( {
			onSelectLink,
			links: barring( 'l2' ),
		} );
		const lies = () =>
			expect( paths( all( svg, 'hit' ) ) ).toEqual(
				paths( [ linkEl( svg, 0 ), linkEl( svg, 2 ) ] )
			);
		expect( aims( svg ) ).toEqual( [ 'l1', 'l3' ] );
		lies();
		const [ before ] = paths( all( svg, 'hit' ) );
		frames( 5 );
		expect( paths( all( svg, 'hit' ) )[ 0 ] ).not.toBe( before );
		lies();
	} );

	it( 'is not drawn without a handler', () => {
		const { svg } = mountSettled();
		expect( aims( svg ) ).toEqual( [] );
	} );

	it( 'comes and goes with the handler and with the line', () => {
		const { svg, update } = mountSettled();
		update( { onSelectLink } );
		expect( aims( svg ) ).toEqual( [ 'l1', 'l2', 'l3' ] );
		expect( paths( all( svg, 'hit' ) ) ).toEqual(
			paths( all( svg, 'link' ) )
		);
		const [ , ...rest ] = all( svg, 'hit' );
		update( { links: barring( 'l1' ) } );
		expect( aims( svg ) ).toEqual( [ 'l2', 'l3' ] );
		expect( all( svg, 'hit' ) ).toEqual( rest );
		expect( paths( all( svg, 'hit' ) ) ).toEqual(
			paths( all( svg, 'link' ) ).slice( 1 )
		);
		update( { links: graph().links.slice( 0, 1 ) } );
		expect( aims( svg ) ).toEqual( [ 'l1' ] );
		update( { onSelectLink: undefined } );
		expect( aims( svg ) ).toEqual( [] );
	} );

	it( 'lies over the line as painted, while the layout is ahead of it', () => {
		const { svg, update } = mountSettled();
		const painted = paths( all( svg, 'link' ) );
		act( () => mockEngine.drag( 'n2', 5300, 410 ) );
		update( { onSelectLink } );
		expect( paths( all( svg, 'hit' ) ) ).toEqual( painted );
	} );

	it( 'lies over hulls and lines, and under nodes', () => {
		const { svg } = mountSettled( { onSelectLink } );
		const parts = [ 'hull', 'link', 'hit', 'node' ].map(
			( part ) => all( svg, part )[ 0 ]
		);
		const painted = [ ...svg.querySelectorAll( 'path, g' ) ].filter(
			( el ) => parts.includes( el )
		);
		expect( painted ).toEqual( parts );
	} );

	it( 'selects its line, says its title, and is over no hull', () => {
		const host = { onSelectLink: jest.fn(), onHoverGroup: jest.fn() };
		const { links } = graph();
		const { svg } = mountSettled( { ...host, links } );
		const [ first, second ] = all( svg, 'hit' );
		press( second );
		press( first.querySelector( 'title' ) );
		expect( host.onSelectLink.mock.calls ).toEqual( [
			[ links[ 1 ] ],
			[ links[ 0 ] ],
		] );
		expect( first.textContent ).toBe( 'owns' );
		expect( second.querySelector( 'title' ) ).toBeNull();
		expect( first.getAttribute( 'aria-hidden' ) ).toBe( 'true' );
		const [ clientX, clientY ] = over( svg, 'n2' );
		pointer( 'pointerover', first, { clientX, clientY } );
		pointer( 'pointermove', first, { clientX, clientY } );
		expect( host.onHoverGroup ).not.toHaveBeenCalled();
	} );

	// The schematic's target is 14 units of its graph, at any zoom.
	it( 'is 14 of the graph’s own units wide, at any zoom', () => {
		const { svg } = mountSettled( { onSelectLink } );
		const sheet = readableSheet();
		const [ hit ] = all( svg, 'hit' );
		const onScreen = () => {
			const scale = all( svg, 'view' )[ 0 ]
				.getAttribute( 'transform' )
				.match( /scale\((.+)\)/ )[ 1 ];
			const effect = read.winning( hit, 'vector-effect', [ sheet ] );
			expect( effect ).toBeUndefined();
			return scale * read.winning( hit, 'stroke-width', [ sheet ] );
		};
		const { k } = view( svg );
		expect( onScreen() ).toBeCloseTo( 14 * k, 9 );
		for ( let i = 0; i < 9; i++ ) {
			wheel( svg, { deltaY: 100 } );
		}
		expect( view( svg ).k ).toBeLessThan( k / 1.5 );
		expect( onScreen() ).toBeCloseTo( 14 * view( svg ).k, 9 );
	} );
} );

describe( 'the cursor over a node', () => {
	const cursorOf = ( el ) =>
		read.winning( el, 'cursor', [ readableSheet() ] );

	it( 'says it drags, and that a press does something where one does', () => {
		const { svg, update } = mountSettled();
		const el = nodeEl( svg, 'n2' );
		expect( cursorOf( el ) ).toBe( 'grab' );
		expect( cursorOf( el ) ).toBe( cursorOf( hullEl( svg, 0 ) ) );
		update( { onSelect: () => {} } );
		expect( cursorOf( el ) ).toBe( 'pointer' );
		update( { onSelect: undefined } );
		expect( cursorOf( el ) ).toBe( 'grab' );
	} );

	it( 'is the same for a node drawn later', () => {
		const { svg, update } = mountSettled( { onSelect: () => {} } );
		update( { nodes: [ ...graph().nodes, { id: 'n9', label: 'Ninth' } ] } );
		expect( cursorOf( nodeEl( svg, 'n9' ) ) ).toBe( 'pointer' );
	} );
} );

describe( 'a full layout, while it untangles', () => {
	const painted = ( svg ) => all( svg, 'node' ).map( at );
	// Runs the frames of the untangling, each checked; the last one paints.
	const untangle = ( check ) => {
		let count = 0;
		while ( mockEngine.runsUnpainted() && count++ < TOO_MANY ) {
			check();
			frames( 1 );
		}
		return count;
	};

	beforeEach( slicing );

	it( 'is an empty canvas, then painted once and frame by frame', () => {
		const { svg } = open();
		const moved = jest.spyOn( all( svg, 'view' )[ 0 ], 'setAttribute' );
		const slices = untangle( () =>
			expect( all( svg, 'node' ) ).toHaveLength( 0 )
		);
		expect( slices ).toBeGreaterThan( 200 );
		expect( mockEngine.ticks() ).toBe( 680 );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		expectFitted( svg );
		expect(
			moved.mock.calls.filter( ( [ name ] ) => 'transform' === name )
		).toHaveLength( 1 );

		const first = painted( svg );
		expect( first ).toEqual( spots().map( ( [ , x, y ] ) => [ x, y ] ) );
		frames( 1 );
		expect( mockEngine.ticks() ).toBe( 681 );
		expect( painted( svg ) ).not.toEqual( first );
		expect( painted( svg ) ).toEqual(
			spots().map( ( [ , x, y ] ) => [ x, y ] )
		);
		expectFitted( svg );
	} );

	it.each( [
		[
			'a reset',
			( { svg } ) => {
				focus( svg );
				key( 'r' );
			},
		],
		[ 'a changed key', ( { update } ) => update( { layoutKey: 'k8' } ) ],
	] )( 'is the graph as it stood, for %s', ( _name, act_ ) => {
		const mounted = mountSettled();
		const { svg } = mounted;
		down( nodeEl( svg, 'n2' ) );
		move( 700, 300 );
		up( 700, 300 );
		settle();
		const before = painted( svg );
		const shown = view( svg );
		act_( mounted );
		const slices = untangle( () => {
			expect( painted( svg ) ).toEqual( before );
			expect( view( svg ) ).toEqual( shown );
		} );
		expect( slices ).toBeGreaterThan( 200 );
		expect( painted( svg ) ).not.toEqual( before );
		expectFitted( svg );
	} );

	it( 'keeps its view through a press, a resize and 0', () => {
		const { svg, update } = mountSettled();
		const shown = view( svg );
		update( { layoutKey: 'k8' } );
		frames( 3 );
		press( svg );
		focus( svg );
		key( '0' );
		resize( 901, 555 );
		expect( view( svg ) ).toEqual( shown );
		untangle( () => {} );
		expectFitted( svg );
	} );

	it( 'draws nothing of a poll or a hover until it ends', () => {
		const { svg, update } = open( { live: true, pollKey: 6 } );
		frames( 2 );
		update( {
			pollKey: 7,
			nodes: graph().nodes.map( ( one ) => ( { ...one, rate: 41 } ) ),
		} );
		update( { hoveredId: 'n2' } );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		untangle( () => {} );
		expect( [ ...nodeEl( svg, 'n2' ).classList ] ).toEqual( [
			`${ BLOCK }__node`,
			'is-live',
			'is-hovered',
		] );
	} );

	it( 'is drawn where the reader pauses it, and goes on from there', () => {
		const { svg } = open( { live: true, pollKey: 6 } );
		frames( 7 );
		focus( svg );
		key( ' ' );
		const held = painted( svg );
		expect( held ).toEqual( spots().map( ( [ , x, y ] ) => [ x, y ] ) );
		expectFitted( svg );
		frames( 5 );
		expect( mockEngine.ticks() ).toBeLessThan( 680 );
		key( ' ' );
		untangle( () => expect( painted( svg ) ).toEqual( held ) );
		expect( mockEngine.ticks() ).toBe( 680 );
		expectFitted( svg );
	} );

	it( 'waits under a gesture, and is not painted by it', () => {
		const { svg } = open();
		frames( 7 );
		const ticks = mockEngine.ticks();
		wheel( svg, { deltaX: 3 } );
		frames( 2 );
		expect( mockEngine.ticks() ).toBe( ticks );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		wait( GAP );
		untangle( () => expect( all( svg, 'node' ) ).toHaveLength( 0 ) );
		expect( mockEngine.ticks() ).toBe( 680 );
	} );

	it.each( [
		[ 'a swipe', ( svg ) => wheel( svg, { deltaX: 33, deltaY: 7 } ) ],
		[ 'a pinch', ( svg ) => wheel( svg, { deltaY: -9, ctrlKey: true } ) ],
		[
			'a drag',
			( svg ) => {
				down( svg );
				move( 455, 333 );
				up( 455, 333 );
			},
		],
	] )(
		'is fitted as it is painted, after %s of the blank canvas',
		( _name, turn ) => {
			const { svg } = open();
			frames( 7 );
			const before = view( svg );
			turn( svg );
			expect( view( svg ) ).not.toEqual( before );
			wait( GAP );
			untangle( () => {} );
			expectFitted( svg );
			frames( 2 );
			expectFitted( svg );
		}
	);

	it( 'is left where the reader moved it, once it was painted', () => {
		const { svg, update } = mountSettled();
		update( { layoutKey: 'k8' } );
		frames( 7 );
		wheel( svg, { deltaX: 33, deltaY: 7 } );
		const shown = view( svg );
		wait( GAP );
		untangle( () => {} );
		expect( view( svg ) ).toEqual( shown );
	} );

	it( 'waits while hidden, and shows nothing as it comes back', () => {
		const { svg } = open();
		frames( 7 );
		const ticks = mockEngine.ticks();
		resize( 0, 777 );
		frames( 5 );
		expect( mockEngine.ticks() ).toBe( ticks );
		resize( 1313, 777 );
		untangle( () => expect( all( svg, 'node' ) ).toHaveLength( 0 ) );
		expect( mockEngine.ticks() ).toBe( 680 );
		expectFitted( svg );
	} );

	it( 'is ended by a drag of what is painted, which paints', () => {
		const { svg, update } = mountSettled();
		update( { layoutKey: 'k8' } );
		frames( 7 );
		const ticks = mockEngine.ticks();
		const { k } = view( svg );
		const [ x0, y0 ] = at( nodeEl( svg, 'n2' ) );
		Object.assign( leaf( 'n2' ), { x: 5300, y: 410 } );
		down( nodeEl( svg, 'n2' ) );
		move( 500, 317 );
		expect( painted( svg ) ).toEqual(
			spots().map( ( [ , x, y ] ) => [ x, y ] )
		);
		expectNear( at( nodeEl( svg, 'n2' ) ), [ x0 + 100 / k, y0 + 17 / k ] );
		move( 500, 340 );
		expectNear( at( nodeEl( svg, 'n2' ) ), [ x0 + 100 / k, y0 + 40 / k ] );
		up( 500, 340 );
		frames( 1 );
		expect( mockEngine.ticks() ).toBe( ticks + 1 );
		expect( painted( svg ) ).toEqual(
			spots().map( ( [ , x, y ] ) => [ x, y ] )
		);
	} );

	it( 'is ended by a drag of a hull, whose nodes start as painted', () => {
		const { svg, update } = mountSettled();
		update( {
			layoutKey: 'k8',
			nodes: [
				...graph().nodes,
				{ id: 'n9', label: 'Ninth', group: 'out/in' },
			],
		} );
		frames( 7 );
		const { k } = view( svg );
		const before = [ 'n2', 'n3' ].map( ( id ) => at( nodeEl( svg, id ) ) );
		const others = [ 'n1', 'n4' ].map( ( id ) => [
			leaf( id ).x,
			leaf( id ).y,
		] );
		const fresh = [ leaf( 'n9' ).x, leaf( 'n9' ).y ];
		const by = [ 100 / k, 17 / k ];
		const moved = ( [ x, y ] ) => [ x + by[ 0 ], y + by[ 1 ] ];
		down( hullEl( svg, 1 ) );
		move( 500, 317 );
		expect( mockEngine.runsUnpainted() ).toBe( false );
		[ 'n2', 'n3' ].forEach( ( id, i ) =>
			expectNear( at( nodeEl( svg, id ) ), moved( before[ i ] ) )
		);
		expectNear( at( nodeEl( svg, 'n9' ) ), moved( fresh ) );
		[ 'n1', 'n4' ].forEach( ( id, i ) =>
			expectNear( at( nodeEl( svg, id ) ), others[ i ] )
		);
		up( 500, 317 );
	} );

	it( 'takes a press of what is painted and not of what is gone', () => {
		const onSelect = jest.fn();
		const { svg, update } = mountSettled( { onSelect } );
		update( { layoutKey: 'k8', nodes: graph().nodes.slice( 0, 3 ) } );
		frames( 3 );
		press( nodeEl( svg, 'n4' ) );
		press( nodeEl( svg, 'n2' ) );
		expect( onSelect.mock.calls ).toEqual( [ [ 'n2' ] ] );
	} );

	it( 'says which painted hull lies beneath a line', () => {
		const onHoverGroup = jest.fn();
		const { svg, update } = mountSettled( { onHoverGroup } );
		const [ clientX, clientY ] = over( svg, 'n2' );
		update( { layoutKey: 'k8' } );
		frames( 3 );
		pointer( 'pointerover', linkEl( svg, 2 ), { clientX, clientY } );
		expect( onHoverGroup.mock.calls ).toEqual( [ [ 'out/in' ] ] );
	} );
} );

describe( 'a change of data', () => {
	it( 'of text, class, title or weight does not move a node', () => {
		const { svg, update } = mountSettled();
		const before = spots();
		const shown = view( svg );
		const { nodes, links, groups } = graph();
		update( {
			nodes: nodes.map( ( one ) => ( {
				...one,
				className: 'is-new',
				title: 'New',
			} ) ),
			links: links.map( ( one ) => ( {
				...one,
				className: 'is-fresh',
				weight: 9,
			} ) ),
			groups: groups.map( ( one ) => ( {
				...one,
				label: `The ${ one.label }`,
				className: 'is-mauve',
			} ) ),
		} );
		expect( mockEngine.running() ).toBe( false );
		expect( spots() ).toEqual( before );
		expect( view( svg ) ).toEqual( shown );
		expect( nodeEl( svg, 'n1' ).classList.contains( 'is-new' ) ).toBe(
			true
		);
		expect( linkEl( svg, 0 ).classList.contains( 'is-fresh' ) ).toBe(
			true
		);
		expect( linkEl( svg, 0 ).getAttribute( 'stroke-width' ) ).toBe( '3' );
		expect( all( svg, 'hull-label' )[ 0 ].textContent ).toBe( 'The Outer' );
		expect( hullEl( svg, 0 ).getAttribute( 'class' ) ).toBe(
			`${ BLOCK }__hull is-mauve`
		);
		expect( nodeEl( svg, 'n1' ).querySelector( 'title' ).textContent ).toBe(
			'New'
		);
	} );

	it( 'of the groups alone is drawn', () => {
		const { svg, update } = mountSettled();
		const [ outer, inner ] = graph().groups;
		update( { groups: [ { ...outer, label: 'Orchard' }, inner ] } );
		expect( all( svg, 'hull-label' )[ 0 ].textContent ).toBe( 'Orchard' );
	} );

	it( 'lays out again on a changed key alone', () => {
		const { update } = mountSettled();
		update( { layoutKey: 'k7' } );
		expect( mockEngine.running() ).toBe( false );
		update( { layoutKey: 'k8' } );
		expect( mockEngine.running() ).toBe( true );
	} );

	it( 'renders anew for a selection without asking the engine again', () => {
		const { update } = mountSettled();
		const setGraph = jest.spyOn( mockEngine, 'setGraph' );
		update( { selectedId: 'n2', hoveredId: 'n1' } );
		expect( setGraph ).not.toHaveBeenCalled();
	} );
} );

describe( 'a press', () => {
	const hosts = () => ( {
		onSelect: jest.fn(),
		onSelectLink: jest.fn(),
		onSelectGroup: jest.fn(),
		onDeselect: jest.fn(),
	} );
	const calls = ( host ) =>
		Object.fromEntries(
			Object.entries( host ).flatMap( ( [ name, { mock } ] ) =>
				mock.calls.length ? [ [ name, mock.calls ] ] : []
			)
		);

	it( 'selects a node, by its shape or its text', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		press( nodeEl( svg, 'n2' ) );
		press( nodeEl( svg, 'n4' ).querySelector( 'text' ) );
		expect( calls( host ) ).toEqual( { onSelect: [ [ 'n2' ], [ 'n4' ] ] } );
	} );

	it( 'selects a hull', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		press( hullEl( svg, 1 ) );
		expect( calls( host ) ).toEqual( { onSelectGroup: [ [ 'out/in' ] ] } );
	} );

	it( 'selects a line, handing over the one the host passed', () => {
		const host = hosts();
		const props = graph();
		const { svg } = mountSettled( { ...props, ...host } );
		expect( linkEl( svg, 1 ).classList.contains( 'is-pressable' ) ).toBe(
			true
		);
		press( linkEl( svg, 1 ) );
		expect( calls( host ) ).toEqual( {
			onSelectLink: [ [ props.links[ 1 ] ] ],
		} );
		press( linkEl( svg, 0 ).querySelector( 'title' ) );
		expect( host.onSelectLink ).toHaveBeenLastCalledWith(
			props.links[ 0 ]
		);
	} );

	it( 'on a line counts as one on the canvas where the host passes no handler', () => {
		const { onSelectLink, ...host } = hosts();
		const { svg, update } = mountSettled( host );
		expect( linkEl( svg, 1 ).classList.contains( 'is-pressable' ) ).toBe(
			false
		);
		press( linkEl( svg, 1 ) );
		expect( calls( host ) ).toEqual( { onDeselect: [ [] ] } );
		update( { onSelectLink } );
		expect( linkEl( svg, 1 ).classList.contains( 'is-pressable' ) ).toBe(
			true
		);
	} );

	it( 'on a line the host bars counts as one on the canvas', () => {
		const host = hosts();
		const { links } = graph();
		const barred = links.map( ( one ) => ( {
			...one,
			pressable: 'l2' !== one.id,
		} ) );
		const { svg, update } = mountSettled( { links: barred, ...host } );
		const marks = () =>
			all( svg, 'link' ).map( ( el ) =>
				el.classList.contains( 'is-pressable' )
			);
		expect( marks() ).toEqual( [ true, false, true ] );
		press( linkEl( svg, 1 ) );
		expect( calls( host ) ).toEqual( { onDeselect: [ [] ] } );
		press( linkEl( svg, 2 ) );
		expect( host.onSelectLink.mock.calls ).toEqual( [ [ barred[ 2 ] ] ] );
		update( { links } );
		expect( marks() ).toEqual( [ true, true, true ] );
	} );

	it.each( [
		[ 'n2', { onSelectGroup: [ [ 'out/in' ] ] } ],
		[ 'n1', { onSelectGroup: [ [ 'out' ] ] } ],
		[ 'n4', { onDeselect: [ [] ] } ],
	] )(
		'on a barred line over where %s stands reaches what is beneath',
		( id, heard ) => {
			const host = hosts();
			const { links } = graph();
			links[ 0 ].pressable = false;
			const { svg } = mountSettled( { links, ...host } );
			const title = linkEl( svg, 0 ).querySelector( 'title' );
			mouse( 'click', title, ...over( svg, id ) );
			expect( calls( host ) ).toEqual( heard );
		}
	);

	it.each( [
		[ 'inside', -4, 'onSelectGroup' ],
		[ 'outside', 4, 'onDeselect' ],
	] )(
		'on a barred line just %s a hull’s edge is read there',
		( _, by, heard ) => {
			const host = hosts();
			const { links } = graph();
			links[ 0 ].pressable = false;
			const { svg } = mountSettled( { links, ...host } );
			const { leafNodes } = mockEngine.model().branches.at( -1 );
			const points = hullPoints( leafNodes );
			const right = Math.max( ...points.map( ( [ px ] ) => px ) );
			const [ , y ] = polygonCentroid( points );
			const [ x, top ] = zoomTransform( svg ).apply( [ right, y ] );
			const spot = [ x + LEFT + by, top + TOP ];
			mouse( 'click', linkEl( svg, 0 ), ...spot );
			expect( Object.keys( calls( host ) ) ).toEqual( [ heard ] );
		}
	);

	it( 'on a barred line reaches the hull where it is painted', () => {
		const host = hosts();
		const { links } = graph();
		links[ 0 ].pressable = false;
		const { svg } = mountSettled( { links, ...host } );
		const painted = over( svg, 'n2' );
		act( () =>
			leaf( 'group:out' ).leafNodes.forEach( ( { id, x, y } ) =>
				mockEngine.drag( id, x + 6100, y )
			)
		);
		mouse( 'click', linkEl( svg, 0 ), ...painted );
		expect( calls( host ) ).toEqual( { onSelectGroup: [ [ 'out/in' ] ] } );
		mouse( 'click', linkEl( svg, 0 ), ...over( svg, 'n2' ) );
		expect( calls( host ).onDeselect ).toEqual( [ [] ] );
	} );

	it( 'on a barred line does not reach a hull the model has dropped', () => {
		viewport.restore();
		viewport = installViewport( false, { reducedMotion: true } );
		const host = hosts();
		const { links, nodes } = graph();
		links[ 0 ].pressable = false;
		const { svg, update } = mountSettled( { links, ...host } );
		const painted = over( svg, 'n3' );
		update( {
			nodes: [
				...nodes.map( ( one ) => ( { ...one, group: null } ) ),
				{ id: 'n9', label: 'Ninth' },
			],
		} );
		expect( mockEngine.running() ).toBe( true );
		expect( all( svg, 'hull' ) ).toHaveLength( 2 );
		mouse( 'click', linkEl( svg, 0 ), ...painted );
		expect( calls( host ) ).toEqual( { onDeselect: [ [] ] } );
	} );

	it( 'on the canvas beside a hull does not reach it', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		mouse( 'click', svg, ...over( svg, 'n2' ) );
		expect( calls( host ) ).toEqual( { onDeselect: [ [] ] } );
	} );

	it( 'on the canvas deselects and fits', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		wheel( svg, { deltaX: 333, deltaY: 222 } );
		wait( GAP );
		expect( view( svg ) ).not.toEqual( fitted() );
		press( svg );
		expect( calls( host ) ).toEqual( { onDeselect: [ [] ] } );
		expectFitted( svg );
	} );

	it( 'goes unheard by a host that passed no callback', () => {
		const { svg } = mountSettled();
		[
			nodeEl( svg, 'n1' ),
			hullEl( svg, 0 ),
			linkEl( svg, 0 ),
			svg,
		].forEach( ( el ) => press( el ) );
		expect( mockEngine.running() ).toBe( false );
	} );

	it( 'takes the latest host’s callback', () => {
		const host = hosts();
		const { svg, update } = mountSettled();
		update( host );
		press( nodeEl( svg, 'n3' ) );
		expect( host.onSelect ).toHaveBeenCalledWith( 'n3' );
	} );

	it( 'of two pixels’ travel still selects, and does not move it', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		const before = spots();
		press( nodeEl( svg, 'n2' ), [ 0, 2 ] );
		press( hullEl( svg, 0 ), [ -2, 0 ] );
		expect( calls( host ) ).toEqual( {
			onSelect: [ [ 'n2' ] ],
			onSelectGroup: [ [ 'out' ] ],
		} );
		expect( spots() ).toEqual( before );
		expect( mockEngine.running() ).toBe( false );
	} );

	it.each( [
		[ 'node', ( svg ) => nodeEl( svg, 'n2' ) ],
		[ 'hull', ( svg ) => hullEl( svg, 1 ) ],
	] )( 'dragged past two pixels does not select the %s', ( _name, pick ) => {
		const host = hosts();
		const { svg } = mountSettled( host );
		press( pick( svg ), [ 2, 1 ] );
		expect( calls( host ) ).toEqual( {} );
		expect( mockEngine.running() ).toBe( true );
	} );

	it( 'dragged and brought back does not select', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		down( nodeEl( svg, 'n2' ) );
		move( 450, 300 );
		move( 400, 300 );
		up( 400, 300 );
		expect( calls( host ) ).toEqual( {} );
	} );

	it( 'of two pixels’ travel on the canvas, or a line, is still a press', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		press( svg, [ 0, 2 ] );
		press( linkEl( svg, 1 ), [ 2, 0 ] );
		expect( Object.keys( calls( host ) ) ).toEqual( [
			'onSelectLink',
			'onDeselect',
		] );
	} );

	it( 'dragged over the canvas pans, and does not deselect', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		const { x, y, k } = view( svg );
		press( svg, [ 63, -41 ] );
		expect( view( svg ) ).toEqual( { x: x + 63, y: y - 41, k } );
		expect( calls( host ) ).toEqual( {} );
	} );

	it( 'with the second button or Ctrl is left to the browser', () => {
		const host = hosts();
		const { svg } = mountSettled( host );
		for ( const init of [ { button: 2 }, { ctrlKey: true } ] ) {
			down( nodeEl( svg, 'n2' ), 400, 300, init );
			up( 400, 300 );
			const shown = view( svg );
			down( svg, 400, 300, init );
			move( 490, 300 );
			up( 490, 300 );
			expect( view( svg ) ).toEqual( shown );
		}
		expect( calls( host ) ).toEqual( {} );
	} );

	it( 'by touch selects, and one the browser cancels does not', () => {
		touchScreen();
		const host = hosts();
		const { svg } = mountSettled( host );
		const el = nodeEl( svg, 'n2' );
		touch( 'touchstart', el, 7, [ 400, 300 ] );
		touch( 'touchcancel', el, 7, [ 400, 300 ] );
		wait( 1000 );
		expect( calls( host ) ).toEqual( {} );
		touch( 'touchstart', el, 8, [ 400, 300 ] );
		touch( 'touchend', el, 8, [ 400, 300 ] );
		expect( calls( host ) ).toEqual( { onSelect: [ [ 'n2' ] ] } );
		wait( 1000 );
	} );

	it( 'focuses the canvas without scrolling to it', () => {
		const { svg } = mountSettled();
		const focused = jest.spyOn( svg, 'focus' );
		pointer( 'pointerdown', nodeEl( svg, 'n1' ) );
		expect( focused ).toHaveBeenCalledWith( { preventScroll: true } );
		expect( document.activeElement ).toBe( svg );
	} );

	it( 'twice does not zoom', () => {
		const { svg } = mountSettled();
		const before = view( svg );
		mouse( 'dblclick', nodeEl( svg, 'n1' ), 400, 300 );
		wait( 1000 );
		expect( view( svg ) ).toEqual( before );
	} );
} );

describe( 'a drag', () => {
	it( 'moves a node by the pointer’s travel, at the view’s scale', () => {
		const { svg } = mountSettled();
		wheel( svg, { deltaY: 100 } );
		wait( GAP );
		const { k } = view( svg );
		const { x, y } = leaf( 'n2' );
		const others = spots().filter( ( [ id ] ) => 'n2' !== id );
		down( nodeEl( svg, 'n2' ) );
		move( 437, 300 );
		move( 450, 260 );
		expectNear(
			[ leaf( 'n2' ).x, leaf( 'n2' ).y ],
			[ x + 50 / k, y - 40 / k ]
		);
		expectNear( at( nodeEl( svg, 'n2' ) ), [
			leaf( 'n2' ).x,
			leaf( 'n2' ).y,
		] );
		expect( linkEl( svg, 1 ).getAttribute( 'd' ) ).toContain(
			`M${ leaf( 'n2' ).x },${ leaf( 'n2' ).y }`
		);
		frames( 5 );
		expect( spots().filter( ( [ id ] ) => 'n2' !== id ) ).toEqual( others );
		up( 450, 260 );
		expect( mockEngine.running() ).toBe( true );
		frames( 2 );
		expect( spots().filter( ( [ id ] ) => 'n2' !== id ) ).not.toEqual(
			others
		);
	} );

	it( 'moves a hull’s nodes and no others', () => {
		const { svg } = mountSettled();
		const { k } = view( svg );
		const before = new Map(
			spots().map( ( [ id, x, y ] ) => [ id, [ x, y ] ] )
		);
		down( hullEl( svg, 1 ) );
		move( 400, 320 );
		move( 370, 320 );
		spots().forEach( ( [ id, x, y ] ) => {
			const [ x0, y0 ] = before.get( id );
			const held = [ 'n2', 'n3' ].includes( id );
			expectNear(
				[ x, y ],
				held ? [ x0 - 30 / k, y0 + 20 / k ] : [ x0, y0 ]
			);
		} );
		up( 370, 320 );
		expect( mockEngine.running() ).toBe( true );
	} );

	it( 'holds the view still, and the fit goes on after it', () => {
		const { svg } = mountSettled();
		const shown = view( svg );
		down( nodeEl( svg, 'n2' ) );
		move( 1100, 300 );
		expect( view( svg ) ).toEqual( shown );
		up( 1100, 300 );
		frames( 1 );
		expectFitted( svg );
	} );

	it( 'holds the layout from the press on, so a node stays under it', () => {
		const onSelect = jest.fn();
		const { svg } = mount( { onSelect } );
		frames( 2 );
		down( nodeEl( svg, 'n2' ) );
		const held = spots();
		frames( 4 );
		expect( spots() ).toEqual( held );
		up( 400, 300 );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
		expect( onSelect.mock.calls ).toEqual( [ [ 'n2' ] ] );
	} );

	it( 'takes one pointer at a time', () => {
		const { svg } = mountSettled();
		down( nodeEl( svg, 'n2' ) );
		const drag = jest.spyOn( mockEngine, 'drag' );
		down( nodeEl( svg, 'n3' ) );
		move( 460, 300 );
		expect( drag.mock.calls.map( ( [ id ] ) => id ) ).toEqual( [ 'n2' ] );
		const shown = view( svg );
		up( 460, 300 );
		expect( mockEngine.running() ).toBe( true );
		move( 555, 333 );
		expect( view( svg ) ).toEqual( shown );
	} );

	it.each( [
		[
			'node',
			( svg ) => nodeEl( svg, 'n2' ),
			( { nodes, links, groups } ) => ( {
				nodes: nodes.filter( ( { id } ) => 'n2' !== id ),
				links,
				groups,
			} ),
		],
		[
			'hull',
			( svg ) => hullEl( svg, 1 ),
			( { nodes, links, groups } ) => ( {
				nodes: nodes.map( ( { group: _group, ...one } ) => one ),
				links,
				groups,
			} ),
		],
	] )( 'ends when its %s is removed', ( _name, pick, without ) => {
		const onSelect = jest.fn();
		const onSelectGroup = jest.fn();
		const { svg, update } = mountSettled( { onSelect, onSelectGroup } );
		down( pick( svg ) );
		move( 480, 300 );
		const drop = jest.spyOn( mockEngine, 'drop' );
		update( without( graph() ) );
		expect( drop ).toHaveBeenCalledTimes( 1 );
		const before = spots();
		frames( 2 );
		expect( spots() ).not.toEqual( before );
		const drag = jest.spyOn( mockEngine, 'drag' );
		move( 520, 300 );
		up( 520, 300 );
		expect( drag ).not.toHaveBeenCalled();
		expect( drop ).toHaveBeenCalledTimes( 1 );
		press( nodeEl( svg, 'n3' ) );
		expect( onSelect.mock.calls ).toEqual( [ [ 'n3' ] ] );
		expect( onSelectGroup ).not.toHaveBeenCalled();
	} );

	it( 'of a hull goes on when a node outside it is removed', () => {
		const { svg, update } = mountSettled();
		const { nodes, links } = graph();
		down( hullEl( svg, 1 ) );
		move( 480, 300 );
		update( { nodes: nodes.filter( ( { id } ) => 'n4' !== id ), links } );
		const { x } = leaf( 'n2' );
		const { k } = view( svg );
		move( 520, 300 );
		expect( leaf( 'n2' ).x ).toBeCloseTo( x + 40 / k, 6 );
		up( 520, 300 );
	} );

	it( 'goes on when another node is removed', () => {
		const { svg, update } = mountSettled();
		const { nodes, links } = graph();
		down( nodeEl( svg, 'n2' ) );
		move( 480, 300 );
		update( { nodes: nodes.filter( ( { id } ) => 'n4' !== id ), links } );
		const { x } = leaf( 'n2' );
		const { k } = view( svg );
		move( 520, 300 );
		expect( leaf( 'n2' ).x ).toBeCloseTo( x + 40 / k, 6 );
		up( 520, 300 );
	} );
} );

describe( 'a touch whose element is gone', () => {
	const grown = () => {
		const { nodes } = graph();
		nodes[ 1 ].size = 37;
		return nodes;
	};

	it( 'lets go of its node, and the next touch takes one', () => {
		touchScreen();
		const onSelect = jest.fn();
		const { svg, update } = mountSettled( { onSelect } );
		const shape = nodeEl( svg, 'n2' ).querySelector( 'rect' );
		touch( 'touchstart', shape, 7, [ 400, 300 ] );
		touch( 'touchmove', shape, 7, [ 433, 300 ] );
		update( { nodes: grown() } );
		expect( shape.isConnected ).toBe( false );
		const before = spots();
		frames( 2 );
		expect( spots() ).not.toEqual( before );
		const el = nodeEl( svg, 'n3' );
		touch( 'touchstart', el, 8, [ 400, 300 ] );
		touch( 'touchend', el, 8, [ 400, 300 ] );
		expect( onSelect.mock.calls ).toEqual( [ [ 'n3' ] ] );
		wait( 1000 );
	} );

	it( 'lets go of the canvas', () => {
		touchScreen();
		const { svg, update } = mount();
		const line = linkEl( svg, 1 );
		touch( 'touchstart', line, 7, [ 400, 300 ] );
		const held = spots();
		frames( 2 );
		expect( spots() ).toEqual( held );
		update( { links: [ graph().links[ 0 ] ] } );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
		wait( 1000 );
	} );

	it.each( [
		[ 'second', ( svg ) => [ svg, linkEl( svg, 1 ) ], 0, 'touchend' ],
		[ 'first', ( svg ) => [ linkEl( svg, 1 ), svg ], 1, 'touchcancel' ],
	] )(
		'leaves a pinch to the other finger, its %s gone',
		( _name, pick, stays, ends ) => {
			touchScreen();
			const { svg, update } = mount();
			const els = pick( svg );
			const one = touch( 'touchstart', els[ 0 ], 7, [ 400, 300 ] );
			touch( 'touchstart', els[ 1 ], 8, [ 500, 300 ], [ one ] );
			update( { links: [ graph().links[ 0 ] ] } );
			const held = spots();
			frames( 2 );
			expect( spots() ).toEqual( held );
			const point = [
				[ 400, 300 ],
				[ 500, 300 ],
			][ stays ];
			touch( ends, els[ stays ], 7 + stays, point );
			frames( 2 );
			expect( spots() ).not.toEqual( held );
			wait( 1000 );

			const { x, y, k } = view( svg );
			touch( 'touchstart', svg, 9, [ 100, 100 ] );
			const next = spots();
			frames( 2 );
			expect( spots() ).toEqual( next );
			touch( 'touchmove', svg, 9, [ 140, 100 ] );
			expectNear( Object.values( view( svg ) ), [ x + 40, y, k ] );
			touch( 'touchend', svg, 9, [ 140, 100 ] );
			frames( 2 );
			expect( spots() ).not.toEqual( next );
			wait( 1000 );
		}
	);

	it( 'is forgotten by a pan with the mouse after it', () => {
		touchScreen();
		const { svg, update } = mount();
		const { links } = graph();
		touch( 'touchstart', linkEl( svg, 1 ), 7, [ 400, 300 ] );
		update( { links: [ links[ 0 ] ] } );
		wait( 1000 );
		down( svg );
		const held = spots();
		update( { links: [ ...links ] } );
		frames( 2 );
		expect( spots() ).toEqual( held );
		up( 400, 300 );
	} );

	it( 'is told from a mouse press, which goes on', () => {
		const { svg, update } = mountSettled();
		down( nodeEl( svg, 'n2' ).querySelector( 'rect' ) );
		move( 433, 300 );
		update( { nodes: grown() } );
		const { x } = leaf( 'n2' );
		const { k } = view( svg );
		move( 473, 300 );
		expect( leaf( 'n2' ).x ).toBeCloseTo( x + 40 / k, 6 );
		up( 473, 300 );
	} );
} );

describe( 'gestures at once', () => {
	it( 'keep a pressed node in place through a notch of the wheel', () => {
		const { svg } = mount();
		frames( 2 );
		down( nodeEl( svg, 'n2' ) );
		const held = spots();
		wheel( svg, { deltaY: -100 } );
		wait( 2 * GAP );
		frames( 3 );
		expect( spots() ).toEqual( held );
		up( 400, 300 );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
	} );

	it( 'keep a dragged node under the pointer through 0', () => {
		const { svg } = mountSettled();
		focus( svg );
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		down( nodeEl( svg, 'n2' ), ...over( svg, 'n2' ) );
		const [ x, y ] = over( svg, 'n2' );
		move( x + 60, y );
		const shown = view( svg );
		key( '0' );
		expect( view( svg ) ).toEqual( shown );
		move( x + 90, y - 20 );
		expectNear( over( svg, 'n2' ), [ x + 90, y - 20 ] );
		up( x + 90, y - 20 );
		expectFitted( svg );
	} );

	it( 'keep a dragged node under the pointer through the wheel', () => {
		const { svg } = mountSettled();
		const [ x, y ] = over( svg, 'n2' );
		down( nodeEl( svg, 'n2' ), x, y );
		move( x + 60, y );
		const { k } = view( svg );
		wheel( svg, { deltaY: -100, clientX: x + 60, clientY: y } );
		expect( view( svg ).k ).toBeCloseTo( k * ZOOM_STEP, 9 );
		expectNear( over( svg, 'n2' ), [ x + 60, y ] );
		wheel( svg, { deltaX: 25, deltaY: 35 } );
		move( x + 61, y );
		expectNear( over( svg, 'n2' ), [ x + 61, y ] );
		up( x + 61, y );
	} );

	it( 'leave the view to a finger that pans while another taps', () => {
		touchScreen();
		const onSelect = jest.fn();
		const { svg } = mountSettled( { onSelect } );
		const { x, y, k } = view( svg );
		const first = touch( 'touchstart', svg, 7, [ 100, 100 ] );
		const el = nodeEl( svg, 'n2' );
		touch( 'touchstart', el, 8, [ 400, 300 ], [ first ] );
		touch( 'touchend', el, 8, [ 400, 300 ], [ first ] );
		expect( onSelect.mock.calls ).toEqual( [ [ 'n2' ] ] );
		const setHeld = jest.spyOn( mockEngine, 'setHeld' );
		touch( 'touchmove', svg, 7, [ 140, 100 ] );
		expectNear( Object.values( view( svg ) ), [ x + 40, y, k ] );
		expect( setHeld ).not.toHaveBeenCalled();
		touch( 'touchend', svg, 7, [ 140, 100 ] );
		expectNear( Object.values( view( svg ) ), [ x + 40, y, k ] );
		expect( setHeld.mock.calls ).toEqual( [ [ false ] ] );
		act( () => mockEngine.reset() );
		frames( 2 );
		expectNear( Object.values( view( svg ) ), [ x + 40, y, k ] );
		wait( 1000 );
	} );

	it( 'hold the layout through a pause taken back in one', () => {
		const { svg } = mount( { live: true } );
		focus( svg );
		down( nodeEl( svg, 'n2' ) );
		key( ' ' );
		key( ' ' );
		const held = spots();
		frames( 3 );
		expect( spots() ).toEqual( held );
		up( 400, 300 );
	} );
} );

describe( 'a hover', () => {
	it( 'says which node, once, and when there is none', () => {
		const onHover = jest.fn();
		const { svg } = mountSettled( { onHover } );
		pointer( 'pointerover', nodeEl( svg, 'n2' ).querySelector( 'rect' ) );
		pointer( 'pointerover', nodeEl( svg, 'n2' ).querySelector( 'text' ) );
		pointer( 'pointerover', hullEl( svg, 0 ) );
		pointer( 'pointerover', nodeEl( svg, 'n3' ) );
		pointer( 'pointerleave', svg );
		expect( onHover.mock.calls ).toEqual( [
			[ 'n2' ],
			[ null ],
			[ 'n3' ],
			[ null ],
		] );
	} );

	it( 'says which hull, once, and when there is none', () => {
		const onHoverGroup = jest.fn();
		const { svg } = mountSettled( { onHoverGroup } );
		const [ outer, inner ] = all( svg, 'hull' );
		for ( const el of [
			outer,
			outer,
			inner,
			nodeEl( svg, 'n2' ),
			inner,
			linkEl( svg, 0 ),
			outer,
			svg,
			inner,
		] ) {
			pointer( 'pointerover', el );
		}
		pointer( 'pointerleave', svg );
		expect( onHoverGroup.mock.calls ).toEqual( [
			[ 'out' ],
			[ 'out/in' ],
			[ null ],
			[ 'out/in' ],
			[ null ],
			[ 'out' ],
			[ null ],
			[ 'out/in' ],
			[ null ],
		] );
	} );

	describe( 'of a line', () => {
		const spot = ( svg, id ) => {
			const [ clientX, clientY ] = over( svg, id );
			return { clientX, clientY };
		};
		const mounted = ( pressable ) => {
			const onHoverGroup = jest.fn();
			const { links } = graph();
			links[ 0 ].pressable = pressable;
			const { svg } = mountSettled( {
				links,
				onHoverGroup,
				onSelectLink: jest.fn(),
			} );
			return { svg, line: linkEl( svg, 0 ), heard: onHoverGroup.mock };
		};

		it( 'that takes no press is one of the hull beneath', () => {
			const { svg, line, heard } = mounted( false );
			pointer( 'pointerover', line, spot( svg, 'n2' ) );
			pointer( 'pointerover', line, spot( svg, 'n4' ) );
			expect( heard.calls ).toEqual( [ [ 'out/in' ], [ null ] ] );
		} );

		it( 'that takes no press goes on from the hull without a break', () => {
			const { svg, line, heard } = mounted( false );
			pointer( 'pointerover', hullEl( svg, 1 ) );
			pointer( 'pointerover', line, spot( svg, 'n2' ) );
			expect( heard.calls ).toEqual( [ [ 'out/in' ] ] );
		} );

		it( 'that takes no press follows the pointer over hulls’ edges', () => {
			const { svg, line, heard } = mounted( false );
			pointer( 'pointerover', line, spot( svg, 'n2' ) );
			pointer( 'pointermove', line, spot( svg, 'n2' ) );
			pointer( 'pointermove', line, spot( svg, 'n1' ) );
			pointer( 'pointermove', line, spot( svg, 'n4' ) );
			expect( heard.calls ).toEqual( [
				[ 'out/in' ],
				[ 'out' ],
				[ null ],
			] );
		} );

		it( 'that takes a press is one of no hull', () => {
			const { svg, line, heard } = mounted( true );
			pointer( 'pointerover', line, spot( svg, 'n2' ) );
			pointer( 'pointermove', line, spot( svg, 'n2' ) );
			expect( heard.calls ).toEqual( [] );
		} );
	} );

	it( 'moves with the pointer over a line alone', () => {
		const onHoverGroup = jest.fn();
		const { svg } = mountSettled( { onHoverGroup } );
		pointer( 'pointerover', hullEl( svg, 1 ) );
		pointer( 'pointermove', svg );
		pointer( 'pointermove', hullEl( svg, 0 ) );
		expect( onHoverGroup.mock.calls ).toEqual( [ [ 'out/in' ] ] );
	} );

	it( 'passes from a node to a hull and back', () => {
		const calls = [];
		const { svg } = mountSettled( {
			onHover: ( id ) => calls.push( [ 'node', id ] ),
			onHoverGroup: ( id ) => calls.push( [ 'hull', id ] ),
		} );
		pointer( 'pointerover', nodeEl( svg, 'n2' ) );
		pointer( 'pointerover', hullEl( svg, 0 ) );
		pointer( 'pointerover', nodeEl( svg, 'n2' ) );
		expect( calls ).toEqual( [
			[ 'node', 'n2' ],
			[ 'node', null ],
			[ 'hull', 'out' ],
			[ 'node', 'n2' ],
			[ 'hull', null ],
		] );
	} );

	it( 'ends when its hull is removed', () => {
		const onHoverGroup = jest.fn();
		const { svg, update } = mountSettled( { onHoverGroup } );
		pointer( 'pointerover', hullEl( svg, 1 ) );
		const { nodes } = graph();
		update( { nodes: nodes.filter( ( { id } ) => 'n4' !== id ) } );
		expect( onHoverGroup.mock.calls ).toEqual( [ [ 'out/in' ] ] );
		update( {
			nodes: nodes.map( ( one ) => ( { ...one, group: null } ) ),
		} );
		expect( onHoverGroup.mock.calls ).toEqual( [ [ 'out/in' ], [ null ] ] );
	} );

	it( 'ends when its node is removed', () => {
		const onHover = jest.fn();
		const { svg, update } = mountSettled( { onHover } );
		pointer( 'pointerover', nodeEl( svg, 'n2' ) );
		const { nodes, links } = graph();
		update( { nodes: nodes.filter( ( { id } ) => 'n4' !== id ), links } );
		expect( onHover.mock.calls ).toEqual( [ [ 'n2' ] ] );
		update( { nodes: nodes.filter( ( { id } ) => 'n2' !== id ) } );
		expect( onHover.mock.calls ).toEqual( [ [ 'n2' ], [ null ] ] );
	} );
} );

describe( 'ids that a selector could not carry', () => {
	it.each( [ 'a/b:c', 'it "is" it' ] )( 'select and move: %s', ( id ) => {
		const onSelect = jest.fn();
		const onSelectGroup = jest.fn();
		const { svg } = mountSettled( {
			nodes: [
				{ id, label: 'Odd', group: id },
				{ id: 'n8', label: 'Eighth' },
			],
			links: [ { id, source: id, target: 'n8' } ],
			groups: [ { id, label: 'Odd' } ],
			selectedId: id,
			onSelect,
			onSelectGroup,
		} );
		const el = nodeEl( svg, id );
		expect( el.classList.contains( 'is-selected' ) ).toBe( true );
		press( el );
		press( hullEl( svg, 0 ) );
		expect( onSelect ).toHaveBeenCalledWith( id );
		expect( onSelectGroup ).toHaveBeenCalledWith( id );
		const { x } = leaf( id );
		const { k } = view( svg );
		down( el );
		move( 475, 300 );
		expect( leaf( id ).x ).toBeCloseTo( x + 75 / k, 6 );
		up( 475, 300 );
	} );
} );

describe( 'the keys', () => {
	/**
	 * A settled graph with its nodes in a cross around n1.
	 *
	 * @param {Object} props    Props over those of the fixture.
	 * @param {Object} [places] Places by node id over those of the cross.
	 * @return {Object} The mounted graph.
	 */
	const cross = ( props, places = {} ) => {
		const mounted = mountSettled( props );
		const spot = {
			n1: [ 0, 0 ],
			n2: [ 300, -5 ],
			n3: [ 500, 0 ],
			n4: [ 10, -400 ],
			...places,
		};
		for ( const [ id, [ x, y ] ] of Object.entries( spot ) ) {
			Object.assign( leaf( id ), { x, y } );
		}
		mounted.update( graph() );
		focus( mounted.svg );
		return mounted;
	};

	it.each( [
		[ 'ArrowLeft', 80, 0 ],
		[ 'ArrowRight', -80, 0 ],
		[ 'ArrowUp', 0, 80 ],
		[ 'ArrowDown', 0, -80 ],
	] )( '%s pans 80 pixels with nothing selected', ( name, dx, dy ) => {
		const onSelect = jest.fn();
		const { svg } = cross( { onSelect } );
		const { x, y, k } = view( svg );
		expect( key( name ).defaultPrevented ).toBe( true );
		expectNear( Object.values( view( svg ) ), [ x + dx, y + dy, k ] );
		expect( onSelect ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ 'ArrowRight', 'n2' ],
		[ 'ArrowUp', 'n4' ],
	] )( '%s moves the selection to the nearest node', ( name, id ) => {
		const onSelect = jest.fn();
		const { svg } = cross( { onSelect, selectedId: 'n1' } );
		const shown = view( svg );
		expect( key( name ).defaultPrevented ).toBe( true );
		expect( onSelect.mock.calls ).toEqual( [ [ id ] ] );
		expect( view( svg ) ).toEqual( shown );
	} );

	it.each( [
		[ 'ArrowLeft', 'n2', [ -20, 0 ] ],
		[ 'ArrowRight', 'n2', [ 20, 0 ] ],
		[ 'ArrowUp', 'n4', [ 0, -10 ] ],
		[ 'ArrowDown', 'n4', [ 0, 10 ] ],
	] )( '%s reads the middle of a larger node: %s', ( name, id, place ) => {
		const onSelect = jest.fn();
		cross( { onSelect, selectedId: 'n1' }, { [ id ]: place } );
		key( name );
		expect( onSelect.mock.calls ).toEqual( [ [ id ] ] );
	} );

	it( 'stay at an edge with no node that way', () => {
		const onSelect = jest.fn();
		const { svg } = cross( { onSelect, selectedId: 'n1' } );
		const shown = view( svg );
		key( 'ArrowDown' );
		expect( onSelect ).not.toHaveBeenCalled();
		expect( view( svg ) ).toEqual( shown );
	} );

	describe( 'while the layout is ahead of what is painted', () => {
		beforeEach( slicing );

		it( 'an arrow moves the selection among the nodes as painted', () => {
			const onSelect = jest.fn();
			cross( { onSelect, selectedId: 'n1' } );
			key( 'r' );
			frames( 3 );
			Object.assign( leaf( 'n2' ), { x: -300, y: 7 } );
			Object.assign( leaf( 'n3' ), { x: 90, y: 0 } );
			Object.assign( leaf( 'n1' ), { x: 0, y: 0 } );
			key( 'ArrowRight' );
			expect( onSelect.mock.calls ).toEqual( [ [ 'n2' ] ] );
		} );

		it( 'an arrow passes over a painted node that is gone', () => {
			const onSelect = jest.fn();
			const { update } = cross( { onSelect, selectedId: 'n1' } );
			update( {
				layoutKey: 'k8',
				nodes: graph().nodes.filter( ( { id } ) => 'n2' !== id ),
			} );
			frames( 3 );
			key( 'ArrowRight' );
			expect( onSelect.mock.calls ).toEqual( [ [ 'n3' ] ] );
		} );

		it( 'an arrow pans an empty canvas', () => {
			const onSelect = jest.fn();
			const { svg } = open( { onSelect, selectedId: 'n1' } );
			frames( 3 );
			focus( svg );
			const { x } = view( svg );
			key( 'ArrowLeft' );
			expect( view( svg ).x ).toBe( x + 80 );
			expect( onSelect ).not.toHaveBeenCalled();
		} );
	} );

	it( 'pan when the selected node is gone', () => {
		const { nodes } = graph();
		const onSelect = jest.fn();
		const { svg, update } = cross( { onSelect, selectedId: 'n4' } );
		update( { nodes: nodes.slice( 0, 3 ) } );
		settle();
		const { x } = view( svg );
		key( 'ArrowLeft' );
		expect( view( svg ).x ).toBeCloseTo( x + 80, 6 );
		expect( onSelect ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ { selectedId: 'n2' } ],
		[ { selectedLink: 'l2' } ],
		[ { selectedGroup: 'out' } ],
	] )( 'Esc deselects: %j', ( selected ) => {
		const onDeselect = jest.fn();
		cross( { onDeselect, ...selected } );
		expect( key( 'Escape' ).defaultPrevented ).toBe( true );
		expect( onDeselect.mock.calls ).toEqual( [ [] ] );
	} );

	it( 'Esc is left to the page while nothing is selected', () => {
		const onDeselect = jest.fn();
		cross( { onDeselect } );
		expect( key( 'Escape' ).defaultPrevented ).toBe( false );
		expect( onDeselect ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ '=', ZOOM_STEP ],
		[ '+', ZOOM_STEP ],
		[ '-', 1 / ZOOM_STEP ],
		[ '_', 1 / ZOOM_STEP ],
	] )( '%s zooms about the middle', ( name, factor ) => {
		const { svg } = cross();
		const middle = [ box.width / 2, box.height / 2 ];
		const before = zoomTransform( svg );
		expect( key( name ).defaultPrevented ).toBe( true );
		const after = zoomTransform( svg );
		expect( after.k ).toBeCloseTo( before.k * factor, 9 );
		expectNear( after.invert( middle ), before.invert( middle ) );
	} );

	it( '0 fits, and the fit goes on', () => {
		const { svg } = mountSettled();
		focus( svg );
		key( '=' );
		wait( GAP );
		expect( key( '0' ).defaultPrevented ).toBe( true );
		expectFitted( svg );
		act( () => mockEngine.reset() );
		frames( 4 );
		expectFitted( svg );
	} );

	it( '0 ends a run of moves', () => {
		const { svg } = mountSettled();
		focus( svg );
		key( '=' );
		const setHeld = jest.spyOn( mockEngine, 'setHeld' );
		key( '0' );
		expectFitted( svg );
		wait( 2 * GAP );
		expect( setHeld.mock.calls ).toEqual( [ [ false ] ] );
	} );

	it( 'r lays the graph out again', () => {
		const { svg } = mountSettled();
		const before = spots();
		focus( svg );
		expect( key( 'r' ).defaultPrevented ).toBe( true );
		expect( mockEngine.running() ).toBe( true );
		expect( spots() ).not.toEqual( before );
		frames( 1 );
		expectNear( at( nodeEl( svg, 'n2' ) ), [
			leaf( 'n2' ).x,
			leaf( 'n2' ).y,
		] );
	} );

	it( 'Space pauses a live graph and resumes it', () => {
		const { svg } = mount( { live: true } );
		focus( svg );
		frames( 2 );
		expect( key( ' ' ).defaultPrevented ).toBe( true );
		const held = spots();
		frames( 5 );
		expect( spots() ).toEqual( held );
		key( ' ', { repeat: true } );
		frames( 2 );
		expect( spots() ).toEqual( held );
		key( ' ' );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
	} );

	it( 'k asks a live host to keep warm', () => {
		const onKeepWarm = jest.fn();
		const { svg } = mount( { live: true, onKeepWarm } );
		focus( svg );
		expect( key( 'k' ).defaultPrevented ).toBe( true );
		expect( onKeepWarm.mock.calls ).toEqual( [ [] ] );
	} );

	it( 'Space and k are left to the page without live', () => {
		const onKeepWarm = jest.fn();
		const { svg } = mount( { onKeepWarm } );
		focus( svg );
		expect( key( ' ' ).defaultPrevented ).toBe( false );
		expect( key( 'k' ).defaultPrevented ).toBe( false );
		const before = spots();
		frames( 2 );
		expect( spots() ).not.toEqual( before );
		expect( onKeepWarm ).not.toHaveBeenCalled();
	} );

	it( 'other than these are left to the page', () => {
		const { svg } = mountSettled();
		focus( svg );
		for ( const name of [ 'Enter', 'x', 'R', 'Tab' ] ) {
			expect( key( name ).defaultPrevented ).toBe( false );
		}
	} );

	/**
	 * What the keys of a live graph with a selection do.
	 *
	 * @param {function(Element): void} prepare  Puts focus and the pointer.
	 * @param {Object}                  [init]   The events' fields.
	 * @param {Element}                 [target] What they are pressed in.
	 * @return {string[]} The keys taken, and what was called.
	 */
	const heard = ( prepare, init, target ) => {
		const host = {
			onSelect: jest.fn(),
			onDeselect: jest.fn(),
			onKeepWarm: jest.fn(),
		};
		const { svg } = mount( { live: true, selectedId: 'n1', ...host } );
		prepare( svg );
		const shown = view( svg );
		const spies = {
			...host,
			reset: jest.spyOn( mockEngine, 'reset' ),
			setPaused: jest.spyOn( mockEngine, 'setPaused' ),
			setHeld: jest.spyOn( mockEngine, 'setHeld' ),
		};
		const taken = [ 'ArrowUp', '=', '0', 'r', ' ', 'k', 'Escape' ].filter(
			( name ) => key( name, init, target ).defaultPrevented
		);
		expect( view( svg ) ).toEqual( shown );
		return [
			...taken,
			...Object.keys( spies ).filter(
				( name ) => spies[ name ].mock.calls.length
			),
		];
	};

	it( 'all act on a focused canvas', () => {
		const onKeepWarm = jest.fn();
		const { svg } = mount( { live: true, selectedId: 'n1', onKeepWarm } );
		focus( svg );
		for ( const name of [ 'ArrowUp', '=', '0', 'r', ' ', 'k', 'Escape' ] ) {
			expect( key( name ).defaultPrevented ).toBe( true );
		}
	} );

	it( 'do nothing while the canvas is neither focused nor hovered', () => {
		expect( heard( ( svg ) => svg.blur() ) ).toEqual( [] );
	} );

	it.each( [ 'altKey', 'ctrlKey', 'metaKey' ] )(
		'do nothing with %s',
		( modifier ) => {
			expect( heard( focus, { [ modifier ]: true } ) ).toEqual( [] );
		}
	);

	it( 'do nothing from a field, hovered or not', () => {
		const input = document.body.appendChild(
			document.createElement( 'input' )
		);
		const prepare = ( svg ) => {
			focus( svg );
			pointer( 'pointerover', svg );
		};
		expect( heard( prepare, {}, input ) ).toEqual( [] );
		input.remove();
	} );

	it( 'leave one the page already took', () => {
		const { svg } = mountSettled();
		focus( svg );
		const shown = view( svg );
		const take = ( e ) => e.preventDefault();
		svg.addEventListener( 'keydown', take );
		key( '=', {}, svg );
		expect( view( svg ) ).toEqual( shown );
	} );

	it( 'pan and zoom a canvas the pointer is over', () => {
		const { svg } = mountSettled( { selectedId: 'n1' } );
		const { x, k } = view( svg );
		pointer( 'pointerover', svg );
		key( 'ArrowLeft' );
		expect( view( svg ).x ).toBeCloseTo( x + 80, 6 );
		key( '=' );
		expect( view( svg ).k ).toBeCloseTo( k * ZOOM_STEP, 9 );
		pointer( 'pointerleave', svg );
		expect( key( '=' ).defaultPrevented ).toBe( false );
	} );

	it( 'reset, fit and warm a canvas the pointer is over', () => {
		const onKeepWarm = jest.fn();
		const { svg } = mount( { live: true, onKeepWarm } );
		pointer( 'pointerover', svg );
		key( '=' );
		expect( key( '0' ).defaultPrevented ).toBe( true );
		expectFitted( svg );
		const reset = jest.spyOn( mockEngine, 'reset' );
		expect( key( 'r' ).defaultPrevented ).toBe( true );
		expect( reset ).toHaveBeenCalledTimes( 1 );
		expect( key( 'k' ).defaultPrevented ).toBe( true );
		expect( onKeepWarm.mock.calls ).toEqual( [ [] ] );
	} );

	it( 'that select and deselect want focus', () => {
		const host = { onSelect: jest.fn(), onDeselect: jest.fn() };
		const { svg } = mount( { selectedId: 'n1', ...host } );
		pointer( 'pointerover', svg );
		expect( key( 'Escape' ).defaultPrevented ).toBe( false );
		const { x } = view( svg );
		key( 'ArrowRight' );
		expect( view( svg ).x ).toBeCloseTo( x - 80, 6 );
		Object.values( host ).forEach( ( spy ) =>
			expect( spy ).not.toHaveBeenCalled()
		);
	} );

	it( 'pause a hovered canvas only while nothing holds focus', () => {
		const { svg } = mount( { live: true } );
		pointer( 'pointerover', svg );
		const button = document.body.appendChild(
			document.createElement( 'button' )
		);
		const setPaused = jest.spyOn( mockEngine, 'setPaused' );
		button.focus();
		expect( key( ' ', {}, button ).defaultPrevented ).toBe( false );
		expect( setPaused ).not.toHaveBeenCalled();
		button.remove();
		expect( document.activeElement ).toBe( document.body );
		expect( key( ' ' ).defaultPrevented ).toBe( true );
		expect( setPaused.mock.calls ).toEqual( [ [ true ] ] );
		pointer( 'pointerleave', svg );
		expect( key( ' ' ).defaultPrevented ).toBe( false );
	} );
} );

describe( 'the wheel', () => {
	it( 'pans by a swipe', () => {
		const { svg } = mountSettled();
		const { x, y, k } = view( svg );
		const e = wheel( svg, { deltaX: 37, deltaY: -53 } );
		expect( e.defaultPrevented ).toBe( true );
		expectNear( Object.values( view( svg ) ), [ x - 37, y + 53, k ] );
	} );

	it.each( [
		[ 'a notch', { deltaY: -100 }, ZOOM_STEP ],
		[ 'a notch back', { deltaY: 100 }, 1 / ZOOM_STEP ],
		[ 'a pinch', { deltaY: -3, ctrlKey: true }, ZOOM_STEP ** 0.3 ],
		[
			'Command',
			{ deltaX: 9, deltaY: -50, metaKey: true },
			ZOOM_STEP ** 0.5,
		],
	] )( 'zooms about the pointer by %s', ( _name, init, factor ) => {
		const { svg } = mountSettled();
		const before = zoomTransform( svg );
		const held = underPointer( svg );
		expect( wheel( svg, init ).defaultPrevented ).toBe( true );
		expect( view( svg ).k ).toBeCloseTo( before.k * factor, 9 );
		expectNear( underPointer( svg ), held );
	} );

	it( 'zooms no further than 0.01 and 10', () => {
		const { svg } = mountSettled();
		const run = ( deltaY ) => {
			for ( let i = 0; i < 100; i++ ) {
				wheel( svg, { deltaY } );
			}
			return view( svg ).k;
		};
		expect( run( -100 ) ).toBe( 10 );
		expect( run( 100 ) ).toBe( 0.01 );
	} );

	it( 'keeps a swipe’s verdict through its momentum', () => {
		const { svg } = mountSettled();
		const { y, k } = view( svg );
		wheel( svg, { deltaX: 3, deltaY: 20 } );
		wheel( svg, { deltaY: 20 }, 16 );
		expect( view( svg ).y ).toBeCloseTo( y - 40, 6 );
		expect( view( svg ).k ).toBe( k );
	} );

	it( 'is one gesture through a run of moves', () => {
		const { svg } = mount();
		frames( 2 );
		const setHeld = jest.spyOn( mockEngine, 'setHeld' );
		for ( let i = 0; i < 4; i++ ) {
			wheel( svg, { deltaX: 11, deltaY: 7 }, 16 );
			wait( GAP - 1 );
		}
		expect( setHeld.mock.calls ).toEqual( [ [ true ] ] );
		wheel( svg, { deltaX: 11, deltaY: 7 }, 16 );
		const held = spots();
		frames( 5 );
		expect( spots() ).toEqual( held );
		wait( GAP );
		expect( setHeld.mock.calls ).toEqual( [ [ true ], [ false ] ] );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
	} );

	it( 'overlaps a drag of the canvas, and the last of them lets go', () => {
		const { svg } = mount();
		const setHeld = jest.spyOn( mockEngine, 'setHeld' );
		wheel( svg, { deltaX: 11, deltaY: 7 } );
		down( svg );
		wait( 4 * GAP );
		expect( setHeld.mock.calls ).toEqual( [ [ true ] ] );
		move( 480, 333 );
		up( 480, 333 );
		expect( setHeld.mock.calls ).toEqual( [ [ true ], [ false ] ] );
		wait( 4 * GAP );
		expect( setHeld ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'does not resume what the reader paused', () => {
		const { svg } = mount( { live: true } );
		focus( svg );
		key( ' ' );
		wheel( svg, { deltaX: 11, deltaY: 7 } );
		wait( GAP );
		const held = spots();
		frames( 3 );
		expect( spots() ).toEqual( held );
	} );
} );

describe( 'a pinch by gesture event', () => {
	it( 'zooms about the pointer by what the scale grew', () => {
		const { svg } = mountSettled();
		const { k } = view( svg );
		const held = underPointer( svg );
		gesture( svg, 'gesturestart', 1 );
		expect( gesture( svg, 'gesturechange', 1.5 ).defaultPrevented ).toBe(
			true
		);
		expect( view( svg ).k ).toBeCloseTo( k * 1.5, 9 );
		gesture( svg, 'gesturechange', 1.2 );
		expect( view( svg ).k ).toBeCloseTo( k * 1.2, 9 );
		expectNear( underPointer( svg ), held );
		expect( gesture( svg, 'gesturestart', 1 ).defaultPrevented ).toBe(
			true
		);
		gesture( svg, 'gesturechange', 0.5 );
		expect( view( svg ).k ).toBeCloseTo( k * 0.6, 9 );
	} );

	it( 'is left to the touches of a touch screen', () => {
		touchScreen();
		const { svg } = mountSettled();
		const before = view( svg );
		for ( const type of [ 'gesturestart', 'gesturechange' ] ) {
			expect( gesture( svg, type, 1.5 ).defaultPrevented ).toBe( false );
		}
		expect( view( svg ) ).toEqual( before );
	} );
} );

describe( 'the fit', () => {
	it( 'follows the layout, frame by frame', () => {
		const { svg } = mount();
		expectFitted( svg );
		const first = view( svg );
		frames( 7 );
		expect( view( svg ) ).not.toEqual( first );
		expectFitted( svg );
		settle();
		expectFitted( svg );
	} );

	it.each( [
		[ 'six pixels, aslant', [ { deltaX: 4, deltaY: 4 } ] ],
		[ 'a zoom', [ { deltaY: -1, ctrlKey: true } ] ],
		[ 'a run of six pixels', [ { deltaX: 3 }, { deltaX: 3 } ] ],
	] )( 'ends after %s', ( _name, turns ) => {
		const { svg } = mount();
		frames( 2 );
		const before = view( svg );
		turns.forEach( ( init ) => wheel( svg, init, 16 ) );
		const moved = view( svg );
		expect( moved ).not.toEqual( before );
		wait( GAP );
		frames( 3 );
		expect( view( svg ) ).toEqual( moved );
	} );

	it( 'ends after a zoom about the view’s own origin', () => {
		const { svg } = mountSettled();
		const { x, y, k } = view( svg );
		wheel( svg, {
			deltaY: -1,
			ctrlKey: true,
			clientX: LEFT + x,
			clientY: TOP + y,
		} );
		wait( GAP );
		expect( view( svg ).k ).toBeGreaterThan( k );
	} );

	it( 'comes back after four pixels', () => {
		const { svg } = mountSettled();
		const { x } = view( svg );
		wheel( svg, { deltaX: 4 } );
		expect( view( svg ).x ).toBeCloseTo( x - 4, 6 );
		wait( GAP );
		expectFitted( svg );
	} );

	it( 'ends with a drag of the canvas, and a press of it starts it', () => {
		const { svg } = mount();
		press( svg, [ 40, 0 ] );
		const moved = view( svg );
		frames( 3 );
		expect( view( svg ) ).toEqual( moved );
		press( svg );
		frames( 3 );
		expectFitted( svg );
	} );

	it( 'never moves the view under a gesture', () => {
		const { svg, update } = mount();
		const before = view( svg );
		down( svg );
		move( 402, 300 );
		const moved = view( svg );
		expect( moved.x ).toBeCloseTo( before.x + 2, 6 );
		update( { layoutKey: 'k9' } );
		expect( view( svg ) ).toEqual( moved );
		up( 402, 300 );
	} );

	it( 'takes the tighter side of a wide, low box', () => {
		setBox( 1313, 77 );
		const { svg } = mountSettled();
		const { leaves } = mockEngine.model();
		const tall = Math.max( ...leaves.map( ( { halfH } ) => halfH ) );
		expect( view( svg ).k ).toBeLessThan( 77 / ( 2 * tall + 100 ) );
		expectFitted( svg );
	} );

	it( 'keeps within the zoom range', () => {
		setBox( 13130, 7770 );
		const { svg } = mountSettled( {
			nodes: [ { id: 'n1', label: 'Alone' } ],
			links: [],
			groups: [],
		} );
		expect( view( svg ).k ).toBe( 10 );
	} );

	it( 'leaves an empty graph where it is', () => {
		const { svg, update } = mount( {
			nodes: [],
			links: [],
			groups: [],
		} );
		press( svg );
		expect( view( svg ) ).toEqual( { x: 0, y: 0, k: 1 } );
		update( graph() );
		frames( 1 );
		expectFitted( svg );
	} );

	it( 'takes a new size, unless the reader left it', () => {
		const { svg } = mountSettled();
		resize( 901, 555 );
		expectFitted( svg );
		wheel( svg, { deltaX: 99, deltaY: 1 } );
		wait( GAP );
		const moved = view( svg );
		resize( 1111, 444 );
		expect( view( svg ) ).toEqual( moved );
	} );

	it( 'hides label text below a quarter scale', () => {
		const { svg } = mountSettled();
		const far = () =>
			all( svg, 'view' )[ 0 ].classList.contains( 'is-far' );
		const zoomTo = ( k ) => {
			while ( view( svg ).k > k * ZOOM_STEP ) {
				wheel( svg, { deltaY: 100 } );
			}
		};
		expect( far() ).toBe( false );
		zoomTo( 0.25 );
		expect( view( svg ).k ).toBeGreaterThanOrEqual( 0.25 );
		expect( far() ).toBe( false );
		wheel( svg, { deltaY: 100 } );
		expect( view( svg ).k ).toBeLessThan( 0.25 );
		expect( far() ).toBe( true );
		wheel( svg, { deltaY: -100 } );
		expect( far() ).toBe( false );
	} );
} );

describe( 'a canvas without a box', () => {
	it( 'does not start, and lays out and fits in its first one', () => {
		setBox( 0, 0 );
		const { svg } = open();
		frames( 5 );
		expect( mockEngine.ticks() ).toBe( 0 );
		expect(
			new Set( spots().flatMap( ( [ , x, y ] ) => [ x, y ] ) )
		).toEqual( new Set( [ 0 ] ) );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		resize( 905, 503 );
		expect( mockEngine.running() ).toBe( true );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		frames( 1 );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		expectFitted( svg );
		settle();
		expectFitted( svg );
	} );

	it( 'holds its layout, and fits when it is shown', () => {
		const { svg } = mount();
		frames( 3 );
		resize( 0, 0 );
		const held = spots();
		frames( 5 );
		expect( spots() ).toEqual( held );
		resize( 1313, 777 );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
		expectFitted( svg );

		settle();
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		resize( 0, 0 );
		resize( 1313, 777 );
		expectFitted( svg );
	} );

	it( 'draws what changed while it was hidden', () => {
		const { svg, update } = mountSettled();
		resize( 0, 777 );
		const { nodes } = graph();
		update( { nodes: nodes.slice( 0, 2 ) } );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		resize( 1313, 777 );
		expect( all( svg, 'node' ) ).toHaveLength( 2 );
	} );
} );

describe( 'reduced motion', () => {
	beforeEach( () => {
		viewport.restore();
		viewport = installViewport( false, { reducedMotion: true } );
	} );

	it( 'paints a layout once, when it stops', () => {
		const { svg, update } = open();
		expect( mockEngine.running() ).toBe( true );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		const painted = jest.spyOn( all( svg, 'view' )[ 0 ], 'setAttribute' );
		const unpainted = [];
		while ( mockEngine.running() ) {
			unpainted.push( all( svg, 'node' ).length );
			frames( 1 );
		}
		expect( new Set( unpainted ) ).toEqual( new Set( [ 0 ] ) );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		expectFitted( svg );
		frames( 20 );
		const moves = painted.mock.calls.filter(
			( [ name ] ) => 'transform' === name
		);
		expect( moves ).toHaveLength( 1 );

		const { nodes } = graph();
		update( { nodes: [ ...nodes, { id: 'n9', label: 'Ninth' } ] } );
		expect( all( svg, 'node' ) ).toHaveLength( 4 );
		settle();
		expect( all( svg, 'node' ) ).toHaveLength( 5 );
	} );

	it( 'paints at once a change that does not move a node', () => {
		const { svg, update } = mountSettled();
		const { nodes } = graph();
		update( {
			nodes: nodes.map( ( one ) => ( { ...one, className: 'is-new' } ) ),
		} );
		expect( nodeEl( svg, 'n1' ).classList.contains( 'is-new' ) ).toBe(
			true
		);
	} );

	it( 'shows a drag as it goes', () => {
		const { svg } = mountSettled();
		const before = at( nodeEl( svg, 'n2' ) );
		down( nodeEl( svg, 'n2' ) );
		move( 600, 300 );
		expect( at( nodeEl( svg, 'n2' ) ) ).not.toEqual( before );
		expectNear( at( nodeEl( svg, 'n2' ) ), [
			leaf( 'n2' ).x,
			leaf( 'n2' ).y,
		] );
		up( 600, 300 );
	} );

	it( 'fits a layout that is paused where it was painted', () => {
		const { svg } = mountSettled( { live: true, pollKey: 6 } );
		focus( svg );
		key( ' ' );
		down( nodeEl( svg, 'n2' ) );
		move( 410, 300 );
		up( 410, 300 );
		expect( mockEngine.running() ).toBe( false );
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		const shown = view( svg );
		key( '0' );
		expect( view( svg ) ).not.toEqual( shown );
		expectFitted( svg );
		key( ' ' );
		expect( mockEngine.running() ).toBe( true );
	} );

	it( 'draws and fits what a poll changes while it is paused', () => {
		const { svg, update } = mountSettled( { live: true, pollKey: 6 } );
		focus( svg );
		key( ' ' );
		down( nodeEl( svg, 'n2' ) );
		move( 410, 300 );
		up( 410, 300 );
		const { nodes } = graph();
		Object.assign( nodes[ 1 ], { className: 'is-amber', rate: 41 } );
		update( { pollKey: 7, nodes } );
		expect( [ ...nodeEl( svg, 'n2' ).classList ] ).toEqual( [
			`${ BLOCK }__node`,
			'is-amber',
			'is-live',
		] );
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		const shown = view( svg );
		key( '0' );
		expect( view( svg ) ).not.toEqual( shown );
		expectFitted( svg );
	} );

	it( 'draws a layout the reader pauses before it was painted', () => {
		const { svg, update } = mountSettled( { live: true, pollKey: 6 } );
		const { nodes } = graph();
		update( { nodes: [ ...nodes, { id: 'n9', label: 'Ninth' } ] } );
		expect( nodeEl( svg, 'n9' ) ).toBeUndefined();
		focus( svg );
		key( ' ' );
		expectNear( at( nodeEl( svg, 'n9' ) ), [
			leaf( 'n9' ).x,
			leaf( 'n9' ).y,
		] );
		expectFitted( svg );
		key( ' ' );
		const painted = spots();
		settle();
		expect( spots() ).not.toEqual( painted );
		expectFitted( svg );
	} );

	it( 'leaves what lands under a gesture to the layout it holds', () => {
		const { svg, update } = open();
		wheel( svg, { deltaX: 33 } );
		const { nodes } = graph();
		nodes[ 2 ].className = 'is-amber';
		update( { nodes: [ ...nodes, { id: 'n9', label: 'Ninth' } ] } );
		expect( all( svg, 'node' ) ).toHaveLength( 0 );
		wait( GAP - 1 );
		expect( mockEngine.ticks() ).toBe( 0 );
		const drawn = [];
		while ( mockEngine.running() ) {
			drawn.push( all( svg, 'node' ).length );
			frames( 1 );
		}
		expect( new Set( drawn ) ).toEqual( new Set( [ 0 ] ) );
		expect( all( svg, 'node' ) ).toHaveLength( 5 );
		expect( nodeEl( svg, 'n3' ).classList.contains( 'is-amber' ) ).toBe(
			true
		);
	} );

	it( 'draws what lands under a gesture once its layout is still', () => {
		const { svg, update } = mountSettled();
		wheel( svg, { deltaX: 33 } );
		const { nodes } = graph();
		nodes[ 2 ].className = 'is-amber';
		update( { nodes } );
		expect( nodeEl( svg, 'n3' ).classList.contains( 'is-amber' ) ).toBe(
			true
		);
	} );

	it( 'draws what lands under a gesture on a layout that is paused', () => {
		const { svg, update } = mountSettled( { live: true, pollKey: 6 } );
		focus( svg );
		key( ' ' );
		wheel( svg, { deltaX: 33 } );
		const { nodes } = graph();
		update( { nodes: [ ...nodes, { id: 'n9', label: 'Ninth' } ] } );
		expect( nodeEl( svg, 'n9' ) ).toBeDefined();
	} );

	it( 'keeps the view of what is painted between two slices', () => {
		slicing();
		const { svg } = mountSettled();
		down( nodeEl( svg, 'n2' ) );
		move( 700, 300 );
		up( 700, 300 );
		const shown = view( svg );
		const before = spots();
		frames( 1 );
		expect( mockEngine.running() ).toBe( true );
		expect( spots() ).not.toEqual( before );
		press( svg );
		expect( view( svg ) ).toEqual( shown );
		settle();
		expectFitted( svg );
	} );

	describe( 'while a change is laid out', () => {
		const hosts = () => ( {
			onSelect: jest.fn(),
			onSelectLink: jest.fn(),
			onSelectGroup: jest.fn(),
			onDeselect: jest.fn(),
			onHover: jest.fn(),
			onHoverGroup: jest.fn(),
		} );
		const without = ( id ) => ( {
			nodes: [
				...graph().nodes.filter( ( one ) => id !== one.id ),
				{ id: 'n9', label: 'Ninth' },
			],
			links: graph().links.slice( 1, 2 ),
		} );
		const called = ( host ) =>
			Object.keys( host ).filter(
				( name ) => host[ name ].mock.calls.length
			);

		it( 'a painted node that is gone takes neither press nor drag', () => {
			const host = hosts();
			const { svg, update } = mountSettled( host );
			const el = nodeEl( svg, 'n2' );
			update( without( 'n2' ) );
			expect( mockEngine.running() ).toBe( true );
			expect( el.isConnected ).toBe( true );
			pointer( 'pointerover', el );
			press( el, [ 0, 3 ] );
			press( el );
			expect( called( host ) ).toEqual( [] );
		} );

		it( 'nor does a painted hull or line that is gone', () => {
			const host = hosts();
			const { svg, update } = mountSettled( host );
			const [ , inner ] = all( svg, 'hull' );
			const line = linkEl( svg, 0 );
			update( {
				...without( 'n4' ),
				nodes: [
					{ id: 'n1', label: 'First' },
					{ id: 'n2', label: 'Second' },
					{ id: 'n3', label: 'Third' },
					{ id: 'n9', label: 'Ninth' },
				],
			} );
			pointer( 'pointerover', inner );
			press( inner, [ 0, 3 ] );
			press( inner );
			expect( host.onSelectGroup ).not.toHaveBeenCalled();
			press( line );
			expect( called( host ) ).toEqual( [] );
		} );

		it( 'a press under way when its node goes does not select', () => {
			const host = hosts();
			const { svg, update } = mountSettled( host );
			const el = nodeEl( svg, 'n2' );
			down( el );
			update( without( 'n2' ) );
			move( 400, 303 );
			up( 400, 303 );
			expect( called( host ) ).toEqual( [] );
		} );

		it( 'a press of a node or line that stays gives the newest', () => {
			const host = hosts();
			const { svg, update } = mountSettled( host );
			const next = without( 'n4' );
			update( next );
			press( nodeEl( svg, 'n2' ) );
			press( linkEl( svg, 1 ) );
			expect( host.onSelect.mock.calls ).toEqual( [ [ 'n2' ] ] );
			expect( host.onSelectLink.mock.calls ).toEqual( [
				[ next.links[ 0 ] ],
			] );
			expect( host.onSelectLink.mock.calls[ 0 ][ 0 ] ).toBe(
				next.links[ 0 ]
			);
		} );

		it( 'a drag moves the element of a node that stays', () => {
			const { svg, update } = mountSettled();
			update( without( 'n4' ) );
			const el = nodeEl( svg, 'n2' );
			const [ x, y ] = over( svg, 'n2' );
			down( el, x, y );
			move( x + 55, y );
			expect( nodeEl( svg, 'n2' ) ).toBe( el );
			expectNear( at( el ), [ leaf( 'n2' ).x, leaf( 'n2' ).y ] );
			expectNear( over( svg, 'n2' ), [ x + 55, y ] );
			expect( nodeEl( svg, 'n9' ) ).toBeDefined();
			up( x + 55, y );
		} );

		it( 'a touch whose element a drag redraws lets go', () => {
			touchScreen();
			const onSelect = jest.fn();
			const { svg, update } = mountSettled( { onSelect } );
			const shape = nodeEl( svg, 'n2' ).querySelector( 'rect' );
			const { nodes } = graph();
			nodes[ 1 ].size = 37;
			update( { nodes: [ ...nodes, { id: 'n9', label: 'Ninth' } ] } );
			touch( 'touchstart', shape, 7, [ 400, 300 ] );
			expect( shape.isConnected ).toBe( true );
			touch( 'touchmove', shape, 7, [ 433, 300 ] );
			expect( shape.isConnected ).toBe( false );
			const el = nodeEl( svg, 'n3' );
			touch( 'touchstart', el, 8, [ 400, 300 ] );
			touch( 'touchend', el, 8, [ 400, 300 ] );
			expect( onSelect.mock.calls ).toEqual( [ [ 'n3' ] ] );
			wait( 1000 );
		} );

		it( 'the view keeps to what is painted, and fits at the end', () => {
			const { svg, update } = mountSettled();
			const shown = view( svg );
			const wide = {
				id: 'n9',
				label: 'A node of so long a name that the fit would move',
			};
			update( { nodes: [ ...graph().nodes, wide ] } );
			press( svg );
			expect( view( svg ) ).toEqual( shown );
			resize( 901, 555 );
			expect( view( svg ) ).toEqual( shown );
			settle();
			expectFitted( svg );
		} );
	} );
} );

describe( 'a live graph', () => {
	const rated = ( rate ) =>
		graph().nodes.map( ( one, i ) =>
			i ? { ...one, rate: rate + i } : one
		);

	it( 'hands its rates over once a poll', () => {
		const { update } = mount( {
			live: true,
			pollKey: 'p1',
			nodes: rated( 3 ),
		} );
		frames( OPENING );
		expect( mockEngine.running() ).toBe( true );
		const setRates = jest.spyOn( mockEngine, 'setRates' );
		update( { nodes: rated( 7 ), hoveredId: 'n1' } );
		update( { links: graph().links, pollKey: 'p1' } );
		expect( setRates ).not.toHaveBeenCalled();
		update( { pollKey: 'p2', nodes: rated( 13 ) } );
		expect( setRates.mock.calls ).toEqual( [
			[
				new Map( [
					[ 'n2', 14 ],
					[ 'n3', 15 ],
					[ 'n4', 16 ],
				] ),
			],
		] );
		update( { pollKey: 'p3' } );
		expect( setRates ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'takes its first mount for a poll without a key', () => {
		mount( { live: true, nodes: rated( 3 ) } );
		frames( OPENING );
		expect( mockEngine.running() ).toBe( true );
	} );

	it( 'compares its keys by identity', () => {
		const pollKey = { at: 1 };
		const { update } = mount( { live: true, pollKey } );
		const setRates = jest.spyOn( mockEngine, 'setRates' );
		update( { pollKey, nodes: rated( 5 ) } );
		expect( setRates ).not.toHaveBeenCalled();
		update( { pollKey: { ...pollKey } } );
		expect( setRates ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'knows its nodes before their rates', () => {
		const { update } = mount( { live: true, pollKey: 1 } );
		const order = [];
		for ( const name of [ 'setGraph', 'setRates' ] ) {
			jest.spyOn( mockEngine, name ).mockImplementation( () =>
				order.push( name )
			);
		}
		update( { nodes: rated( 5 ), pollKey: 2 } );
		expect( order ).toEqual( [ 'setGraph', 'setRates' ] );
	} );

	it( 'waits to hand rates over until it is live, and then hands each poll once', () => {
		const { update } = mount( { nodes: rated( 3 ), pollKey: 1 } );
		frames( OPENING );
		expect( mockEngine.running() ).toBe( false );
		const setRates = jest.spyOn( mockEngine, 'setRates' );
		update( { nodes: rated( 5 ), pollKey: 2 } );
		expect( setRates ).not.toHaveBeenCalled();
		update( { live: true } );
		expect( setRates.mock.calls ).toEqual( [
			[
				new Map( [
					[ 'n2', 6 ],
					[ 'n3', 7 ],
					[ 'n4', 8 ],
				] ),
			],
		] );
		update( { live: false } );
		update( { live: true } );
		expect( setRates ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'keeps warm as the host says, from its first poll on', () => {
		const { update } = mount( {
			live: true,
			keepWarm: true,
			pollKey: 0,
			nodes: rated( 1 ),
		} );
		for ( let i = 1; i <= 40; i++ ) {
			update( { pollKey: i } );
			frames( 40 );
		}
		expect( mockEngine.running() ).toBe( true );
		const setKeepWarm = jest.spyOn( mockEngine, 'setKeepWarm' );
		update( { keepWarm: false } );
		expect( setKeepWarm.mock.calls ).toEqual( [ [ false ] ] );
	} );

	it( 'keeps its picture, its view and its nodes when live changes', () => {
		const { svg, update } = mountSettled( { pollKey: 4 } );
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		const was = mockEngine;
		const shown = view( svg );
		const before = spots();
		const els = all( svg, 'node' );
		for ( const live of [ true, false, true ] ) {
			update( { live } );
			expect( mockEngine ).toBe( was );
			expect( spots() ).toEqual( before );
			expect( all( svg, 'node' ) ).toEqual( els );
			expect( view( svg ) ).toEqual( shown );
		}
		expect( mockEngine.running() ).toBe( true );
		frames( 5 );
		expect( spots() ).not.toEqual( before );
		expect( view( svg ) ).toEqual( shown );
	} );

	it( 'resumes when it leaves live, and comes back unpaused', () => {
		const { svg, update } = mount( { live: true, pollKey: 4 } );
		focus( svg );
		key( ' ' );
		const held = spots();
		frames( 2 );
		expect( spots() ).toEqual( held );
		update( { live: false } );
		frames( 2 );
		const moved = spots();
		expect( moved ).not.toEqual( held );
		update( { live: true } );
		wheel( svg, { deltaX: 333, deltaY: 1 } );
		wait( GAP );
		frames( 2 );
		expect( spots() ).not.toEqual( moved );
		const setPaused = jest.spyOn( mockEngine, 'setPaused' );
		key( ' ' );
		expect( setPaused.mock.calls ).toEqual( [ [ true ] ] );
	} );

	it( 'waits for the gesture under way to resume', () => {
		const { svg, update } = mount( { live: true, pollKey: 4 } );
		focus( svg );
		key( ' ' );
		down( nodeEl( svg, 'n2' ) );
		const held = spots();
		update( { live: false } );
		frames( 2 );
		expect( spots() ).toEqual( held );
		up( 400, 300 );
		frames( 2 );
		expect( spots() ).not.toEqual( held );
	} );
} );

describe( 'the host’s handle', () => {
	it( 'resets, and is let go at unmount', () => {
		const apiRef = createRef();
		const { svg, unmount } = mountSettled( { apiRef } );
		act( () => apiRef.current.reset() );
		expect( mockEngine.running() ).toBe( true );
		const before = at( nodeEl( svg, 'n2' ) );
		expect( [ leaf( 'n2' ).x, leaf( 'n2' ).y ] ).not.toEqual( before );
		frames( 1 );
		expect( at( nodeEl( svg, 'n2' ) ) ).toEqual( [
			leaf( 'n2' ).x,
			leaf( 'n2' ).y,
		] );
		unmount();
		expect( apiRef.current ).toBeNull();
	} );
} );

describe( 'an unmount', () => {
	it( 'destroys the engine and empties the svg', () => {
		const { svg, unmount } = mount( { live: true } );
		const destroy = jest.spyOn( mockEngine, 'destroy' );
		unmount();
		expect( destroy ).toHaveBeenCalledTimes( 1 );
		expect( svg.childNodes ).toHaveLength( 0 );
		expect( observers ).toEqual( [] );
		expect( key( '=' ).defaultPrevented ).toBe( false );
	} );

	it( 'leaves a box that is measured late unread', () => {
		const { unmount } = mount();
		const [ { callback } ] = observers;
		unmount();
		const setSize = jest.spyOn( mockEngine, 'setSize' );
		setBox( 777, 333 );
		callback( [ { contentRect: box } ] );
		expect( setSize ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ 'a swipe', ( svg ) => wheel( svg, { deltaX: 44, deltaY: 1 } ) ],
		[
			'a pan',
			( svg ) => {
				down( svg );
				move( 440, 300 );
			},
		],
		[
			'a drag',
			( svg ) => {
				down( nodeEl( svg, 'n2' ) );
				move( 440, 300 );
			},
		],
	] )( 'in the middle of %s does not act afterwards', ( _name, begin ) => {
		const onSelect = jest.fn();
		const { svg, unmount } = mount( { onSelect } );
		begin( svg );
		unmount();
		const calls = [ 'setPaused', 'setHeld', 'drag', 'drop' ].map(
			( name ) => jest.spyOn( mockEngine, name )
		);
		move( 480, 300 );
		up( 480, 300 );
		wait( 10 * GAP );
		calls.forEach( ( spy ) => expect( spy ).not.toHaveBeenCalled() );
		expect( onSelect ).not.toHaveBeenCalled();
	} );
} );
