/**
 * Tests for the force graph's engine: when a layout runs and when it rests, run
 * on real d3 with fake timers, one animation frame a tick.
 *
 * d3-timer binds the frame scheduler as it loads, so the fake timers come
 * first and the modules are required after them. The d3 and untangle modules
 * are the real ones, wrapped to show the simulation and to count, or leave
 * out, the untangling.
 */

let mockSimulation;
let mockUntangles = true;
let mockTurns = 0;

jest.mock( 'd3', () => {
	const actual = jest.requireActual( 'd3' );
	return {
		...actual,
		forceSimulation: ( ...args ) =>
			( mockSimulation = actual.forceSimulation( ...args ) ),
	};
} );

jest.mock( '../untangle', () => {
	const actual = jest.requireActual( '../untangle' );
	return {
		...actual,
		createUntangler: ( model ) => {
			const untangle = actual.createUntangler( model );
			return () => {
				mockTurns++;
				if ( mockUntangles ) {
					untangle();
				}
			};
		},
	};
} );

jest.useFakeTimers();

// A script's own `Math` spares the untangler jsdom's slow global lookup.
const script = document.createElement( 'script' );
script.textContent = 'const Math = window.Math;';
document.head.append( script );

const { extent, polygonContains } = require( 'd3' );
const { createEngine } = require( '../engine' );
const { CHARGE, chargeOf } = require( '../forces' );
const { hullPoints } = require( '../hulls' );
const { countCrossings } = require( './countCrossings' );

const node = ( id, extra = {} ) => ( { id, label: id, ...extra } );
const group = ( id, parent = null ) => ( { id, parent } );
const link = ( source, target, extra = {} ) => ( { source, target, ...extra } );
const pad = ( i ) => String( i ).padStart( 2, '0' );
const times = ( count, make ) =>
	Array.from( { length: count }, ( _, i ) => make( i ) );

const SIZE = { width: 1313, height: 777 };

/** Ticks of a full layout that untangle. */
const UNTANGLE_TICKS = 680;

/** Ticks from alpha 0.5 to a stop. */
const LAYOUT_TICKS = 826;

/** Ticks no layout here needs, so a run that reaches it never stops. */
const TOO_MANY = 4000;

/** Frames between rate polls: two seconds. */
const POLL_FRAMES = 125;

/** The class graph's fixture: four nested groups and links across them. */
const classGraph = () => ( {
	nodes: [
		...times( 30, ( i ) =>
			node( `Base_${ pad( i ) }`, { group: 'alpha' } )
		),
		...times( 14, ( i ) =>
			node( `An_Administration_Page_With_A_Long_Name_${ pad( i ) }`, {
				group: 'alpha/admin',
			} )
		),
		...times( 24, ( i ) =>
			node( `Report_${ pad( i ) }`, { group: 'beta/reports' } )
		),
		...times( 40, ( i ) =>
			node( `Job_${ pad( i ) }`, { group: 'beta/jobs' } )
		),
		node( 'RuntimeException' ),
	],
	links: [
		...times( 29, ( i ) => link( `Base_${ pad( i + 1 ) }`, 'Base_00' ) ),
		...times( 14, ( i ) =>
			link(
				`An_Administration_Page_With_A_Long_Name_${ pad( i ) }`,
				'Base_01'
			)
		),
		...times( 24, ( i ) =>
			link( `Report_${ pad( i ) }`, `Base_${ pad( ( i * 7 ) % 30 ) }` )
		),
		...times( 8, ( i ) => link( `Job_${ pad( i ) }`, 'Base_00' ) ),
		...times( 6, ( i ) =>
			link( `Job_${ pad( i + 8 ) }`, 'RuntimeException' )
		),
	],
	groups: [
		group( 'alpha' ),
		group( 'alpha/admin', 'alpha' ),
		group( 'beta' ),
		group( 'beta/reports', 'beta' ),
		group( 'beta/jobs', 'beta' ),
	],
} );

const ungrouped = ( { nodes, links } ) => ( {
	nodes: nodes.map( ( { group: _group, ...rest } ) => rest ),
	links,
	groups: [],
} );

/** Two linked groups of six, one within the other. */
const twoGroups = () => ( {
	nodes: times( 12, ( i ) =>
		node( `n${ pad( i ) }`, { group: i < 6 ? 'g' : 'g/sub' } )
	),
	links: times( 12, ( i ) =>
		link( `n${ pad( i ) }`, `n${ pad( ( i * 5 + 1 ) % 12 ) }` )
	),
	groups: [ group( 'g' ), group( 'g/sub', 'g' ) ],
} );

/** A path of three, and a fourth node by itself. */
const small = () => ( {
	nodes: [ node( 'a' ), node( 'b' ), node( 'c' ), node( 'd' ) ],
	links: [ link( 'a', 'b' ), link( 'b', 'c' ) ],
	groups: [],
} );

const without = ( { nodes, links, groups }, id ) => ( {
	nodes: nodes.filter( ( one ) => id !== one.id ),
	links: links.filter(
		( { source, target } ) => id !== source && id !== target
	),
	groups,
} );

const withNode = ( { nodes, links, groups }, one, ...more ) => ( {
	nodes: [ ...nodes, one ],
	links: [ ...links, ...more ],
	groups,
} );

const engines = [];
const make = ( { live = false, ...options } = {} ) => {
	const engine = createEngine( { ...SIZE, onTick: () => {}, ...options } );
	engine.setLive( live );
	engines.push( engine );
	return engine;
};

const frames = ( count ) => {
	for ( let i = 0; i < count; i++ ) {
		jest.advanceTimersToNextFrame();
	}
};

/**
 * Run frames until the layout is still.
 *
 * @param {Object} engine The engine.
 * @return {number} Frames run.
 */
const settle = ( engine ) => {
	let count = 0;
	while ( engine.running() && count < TOO_MANY ) {
		frames( 1 );
		count++;
	}
	return count;
};

const settled = ( graph = small(), options = {}, key = 'k7' ) => {
	const engine = make( options );
	engine.setGraph( graph, key );
	settle( engine );
	return engine;
};

// Where a full layout of a graph starts.
const placed = ( graph ) => {
	const engine = make();
	engine.setPaused( true );
	engine.setGraph( graph, 'k7' );
	return spots( engine );
};

const leaf = ( engine, id ) => engine.model().byId.get( id );
const spots = ( engine ) =>
	engine.model().leaves.map( ( { id, x, y } ) => [ id, x, y ] );
const ratesOf = ( engine, rate ) =>
	new Map( engine.model().leaves.map( ( { id }, i ) => [ id, rate( i ) ] ) );
const poll = ( engine, rate = ( i ) => ( i * 13 ) % 137 ) =>
	engine.setRates( ratesOf( engine, rate ) );

const pairs = ( list, test ) =>
	list.flatMap( ( a, i ) =>
		list
			.slice( i + 1 )
			.filter( ( b ) => test( a, b ) )
			.map( ( b ) => `${ a.id } ${ b.id }` )
	);

const overlappingLabels = ( { leaves } ) =>
	pairs(
		leaves,
		( a, b ) =>
			Math.abs( a.x - b.x ) < a.halfW + b.halfW &&
			Math.abs( a.y - b.y ) < a.halfH + b.halfH
	);

// Convex polygons overlap unless an edge of either parts them.
const collide = ( a, b ) =>
	[ a, b ].every( ( polygon ) =>
		polygon.every( ( p, i ) => {
			const q = polygon[ ( i + 1 ) % polygon.length ];
			const along = ( v ) =>
				v[ 0 ] * ( q[ 1 ] - p[ 1 ] ) + v[ 1 ] * ( p[ 0 ] - q[ 0 ] );
			const [ a0, a1 ] = extent( a, along );
			const [ b0, b1 ] = extent( b, along );
			return a1 > b0 && b1 > a0;
		} )
	);

const overlappingHulls = ( { branches } ) =>
	pairs(
		branches,
		( a, b ) =>
			! a.ancestors.has( b ) &&
			! b.ancestors.has( a ) &&
			collide( hullPoints( a.leafNodes ), hullPoints( b.leafNodes ) )
	);

const labelsOutsideHulls = ( { leaves } ) =>
	leaves.filter( ( { parent, x, y, halfW, halfH } ) => {
		const hull = parent && hullPoints( parent.leafNodes );
		return (
			hull &&
			! [
				[ -1, -1 ],
				[ 1, -1 ],
				[ 1, 1 ],
				[ -1, 1 ],
			].every( ( [ dx, dy ] ) =>
				polygonContains( hull, [ x + dx * halfW, y + dy * halfH ] )
			)
		);
	} );

const expectClear = ( model ) => {
	expect( overlappingLabels( model ) ).toEqual( [] );
	expect( overlappingHulls( model ) ).toEqual( [] );
	expect( labelsOutsideHulls( model ) ).toEqual( [] );
};

const expectFinite = ( engine ) =>
	engine.model().leaves.forEach( ( { x, y } ) => {
		expect( Number.isFinite( x ) ).toBe( true );
		expect( Number.isFinite( y ) ).toBe( true );
	} );

beforeEach( () => {
	mockUntangles = true;
	mockTurns = 0;
} );

afterEach( () => {
	engines.splice( 0 ).forEach( ( engine ) => engine.destroy() );
	jest.restoreAllMocks();
} );

describe( 'a full layout', () => {
	it( 'runs on the first graph with nodes, and stops', () => {
		const engine = make();
		expect( engine.running() ).toBe( false );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		expect( engine.running() ).toBe( false );

		engine.setGraph( small(), 'k7' );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( settle( engine ) ).toBe( LAYOUT_TICKS );

		const still = spots( engine );
		frames( 50 );
		expect( spots( engine ) ).toEqual( still );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'runs again on a changed key', () => {
		const engine = settled();
		mockTurns = 0;

		engine.setGraph( small(), 'k8' );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'runs again on reset, and ends where the first one did', () => {
		const engine = settled( twoGroups() );
		const first = spots( engine );
		engine.drag( 'n07', 5000, 4000 );
		engine.drop();
		settle( engine );
		expect( spots( engine ) ).not.toEqual( first );
		mockTurns = 0;

		engine.reset();
		expect( engine.running() ).toBe( true );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
		expect( spots( engine ) ).toEqual( first );
	} );

	it( 'is where a graph that changed key while empty starts', () => {
		const engine = settled();
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k8' );
		expect( engine.running() ).toBe( false );
		mockTurns = 0;

		engine.setGraph( small(), 'k8' );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'is where a graph that emptied starts again, under one key', () => {
		const engine = settled();
		engine.drag( 'a', 2222, 1777 );
		engine.drop();
		settle( engine );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		mockTurns = 0;

		engine.setGraph( small(), 'k7' );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( spots( engine ) ).toEqual( placed( small() ) );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'registers the untangler ahead of every other force', () => {
		const engine = make();
		engine.setSize( { width: 1414, height: 888 } );
		engine.setGraph( small(), 'k7' );
		const order = [];
		const names = [
			'untangle',
			'link',
			'boxes',
			'cohesion',
			'siblings',
			'charge',
			'clamp',
		];
		names.forEach( ( name ) => {
			const force = mockSimulation.force( name );
			mockSimulation.force( name, ( alpha ) => {
				order.push( name );
				force( alpha );
			} );
		} );
		frames( 1 );
		expect( order ).toEqual( names );
	} );

	it( 'ends with a pulled pair the link distance apart or more', () => {
		const engine = settled();
		const { pulls } = engine.model();
		const [ { source, target } ] = pulls;
		expect( mockSimulation.force( 'link' ).distance()( pulls[ 0 ] ) ).toBe(
			250
		);
		expect( mockSimulation.force( 'link' ).strength()( pulls[ 0 ] ) ).toBe(
			1
		);
		expect(
			Math.hypot( source.x - target.x, source.y - target.y )
		).toBeGreaterThan( 240 );
	} );

	it( 'takes the canvas it is given', () => {
		const near = settled( small() );
		const far = make();
		far.setSize( { width: 9313, height: 8777 } );
		far.setGraph( small(), 'k7' );
		settle( far );
		expect( leaf( far, 'a' ).x - leaf( near, 'a' ).x ).toBeGreaterThan(
			3000
		);
	} );

	it( 'is drawn toward the centre of a canvas resized under it', () => {
		const engine = settled();
		const before = leaf( engine, 'd' ).x;
		engine.setSize( { width: 9313, height: 777 } );
		expect( engine.running() ).toBe( false );
		engine.drag( 'd', before + 1, leaf( engine, 'd' ).y );
		engine.drop();
		settle( engine );
		expect( leaf( engine, 'd' ).x - before ).toBeGreaterThan( 1000 );
	} );
} );

describe( 'on the class graph fixture', () => {
	it( 'the layout ends clear', () => {
		const engine = settled( classGraph() );
		expect( engine.running() ).toBe( false );
		expectClear( engine.model() );
		const untangled = countCrossings( engine.model().spans );

		mockUntangles = false;
		const tangled = countCrossings( settled( classGraph() ).model().spans );
		expect( untangled * 3 ).toBeLessThan( tangled );
	} );

	it( 'the layout ends clear without groups', () => {
		const engine = settled( ungrouped( classGraph() ) );
		expect( engine.running() ).toBe( false );
		expect( engine.model().branches ).toEqual( [] );
		expect( overlappingLabels( engine.model() ) ).toEqual( [] );
	} );
} );

describe( 'a data-only graph', () => {
	it( 'moves nothing and hands the model its new data', () => {
		const engine = settled( {
			nodes: [
				node( 'a', { group: 'g' } ),
				node( 'b', { group: 'g' } ),
				node( 'c' ),
			],
			links: [ link( 'a', 'b' ), link( 'a', 'b' ), link( 'b', 'c' ) ],
			groups: [ group( 'g' ) ],
		} );
		const before = spots( engine );
		const model = engine.model();

		const groups = [ { ...group( 'g' ), label: 'Gee' } ];
		engine.setGraph(
			{
				nodes: [
					node( 'c' ),
					node( 'b', { group: 'g', className: 'lit' } ),
					node( 'a', { group: 'g' } ),
				],
				links: [ link( 'a', 'b' ), link( 'b', 'c' ), link( 'a', 'b' ) ],
				groups,
			},
			'k7'
		);
		expect( engine.running() ).toBe( false );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );
		expect( engine.model() ).toBe( model );
		expect( leaf( engine, 'b' ).node.className ).toBe( 'lit' );
		expect( model.branches[ 0 ].group ).toBe( groups[ 0 ] );
	} );

	it( 'leaves a running layout to run', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 37 );
		const alpha = mockSimulation.alpha();
		engine.setGraph( small(), 'k7' );
		expect( mockSimulation.alpha() ).toBe( alpha );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );
} );

describe( 'a resized node', () => {
	const grown = ( graph, id, extra ) => ( {
		...graph,
		nodes: graph.nodes.map( ( one ) =>
			id === one.id ? { ...one, ...extra } : one
		),
	} );

	it( 'moves nothing while it is clear', () => {
		const engine = settled( small(), { live: true } );
		times( 11, () => poll( engine ) );
		settle( engine );
		const before = spots( engine );
		const model = engine.model();
		engine.setGraph(
			grown( small(), 'd', { label: 'x'.repeat( 11 ) } ),
			'k7'
		);
		expect( engine.model() ).toBe( model );
		expect( leaf( engine, 'd' ).halfW ).toBe( 46.5 );
		expect( engine.running() ).toBe( false );
		poll( engine );
		expect( engine.running() ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'reheats when it overlaps, ends clear and keeps the steps', () => {
		const engine = settled( small(), { live: true } );
		times( 11, () => poll( engine ) );
		settle( engine );
		mockTurns = 0;
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( overlappingLabels( engine.model() ) ).not.toEqual( [] );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		settle( engine );
		expect( mockTurns ).toBe( 0 );
		expectClear( engine.model() );
	} );

	it( 'reheats when its hull overlaps another', () => {
		const graph = {
			nodes: [ node( 'a', { group: 'g' } ), node( 'b', { group: 'h' } ) ],
			links: [ link( 'a', 'b' ) ],
			groups: [ group( 'g' ), group( 'h' ) ],
		};
		const engine = settled( graph );
		engine.setGraph( grown( graph, 'a', { size: 633 } ), 'k7' );
		expect( engine.running() ).toBe( true );
		settle( engine );
		expectClear( engine.model() );
	} );

	it( 'leaves an opening layout its untangling', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 5 );
		engine.setGraph(
			grown( small(), 'd', { label: 'x'.repeat( 10 ) } ),
			'k7'
		);
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'reheats beside a removal when it overlaps', () => {
		const engine = settled();
		const graph = without( small(), 'd' );
		engine.setGraph( grown( graph, 'b', { size: 433 } ), 'k7' );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
	} );
} );

describe( 'a changed graph', () => {
	it( 'keeps its survivors and starts a new node beside its neighbor', () => {
		const engine = settled();
		const before = spots( engine );
		mockTurns = 0;

		engine.setGraph(
			withNode( small(), node( 'e' ), link( 'e', 'c' ) ),
			'k7'
		);
		expect( spots( engine ).slice( 0, 4 ) ).toEqual( before );
		const [ e, c ] = [ leaf( engine, 'e' ), leaf( engine, 'c' ) ];
		expect( Math.abs( e.y - c.y ) ).toBeLessThan( e.halfH + c.halfH );
		expect( Math.abs( e.x - c.x ) ).toBe( e.halfW + c.halfW );

		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		settle( engine );
		expect( overlappingLabels( engine.model() ) ).toEqual( [] );
		expect( mockTurns ).toBe( 0 );
	} );

	it( 'moves nothing when a node leaves and comes back', () => {
		const engine = settled();
		const before = spots( engine );

		engine.setGraph( without( small(), 'b' ), 'k7' );
		expect( engine.running() ).toBe( false );
		frames( 5 );
		engine.setGraph( without( small(), 'd' ), 'k7' );
		expect( engine.running() ).toBe( false );
		frames( 5 );
		engine.setGraph( small(), 'k7' );
		expect( engine.running() ).toBe( false );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'moves nothing when any node of nested hulls leaves and returns', () => {
		const engine = settled( twoGroups() );
		const before = spots( engine );
		for ( const { id } of twoGroups().nodes ) {
			engine.setGraph( without( twoGroups(), id ), 'k7' );
			engine.setGraph( twoGroups(), 'k7' );
			expect( engine.running() ).toBe( false );
		}
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'reheats nothing for a removal, even as its survivors overlap', () => {
		const engine = settled();
		engine.drag( 'a', leaf( engine, 'c' ).x + 7, leaf( engine, 'c' ).y );
		engine.setGraph( without( small(), 'd' ), 'k7' );
		expect( mockSimulation.alpha() ).toBeLessThan( 0.1 );
	} );

	it( 'reheats for a return that lands on a sibling, and ends clear', () => {
		const engine = settled();
		const { x, y } = leaf( engine, 'b' );
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.drag( 'd', x + 59, y - 23 );
		engine.setGraph( small(), 'k7' );
		expect( [ leaf( engine, 'b' ).x, leaf( engine, 'b' ).y ] ).toEqual( [
			x,
			y,
		] );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		mockTurns = 0;

		engine.drop();
		settle( engine );
		expect( mockTurns ).toBe( 0 );
		expectClear( engine.model() );
	} );

	it( 'reheats for a return that stretches its hull over a sibling', () => {
		const graph = {
			nodes: [
				...times( 3, ( i ) => node( `g${ i }`, { group: 'g' } ) ),
				...times( 3, ( i ) => node( `h${ i }`, { group: 'h' } ) ),
			],
			links: [],
			groups: [ group( 'g' ), group( 'h' ) ],
		};
		const engine = settled( graph );
		const [ was, h ] = [ leaf( engine, 'g1' ), leaf( engine, 'h1' ) ];
		engine.setGraph( without( graph, 'g1' ), 'k7' );
		// The rest of `g` goes to the far side of `h`.
		engine.dragGroup( 'g', 2 * ( h.x - was.x ), 2 * ( h.y - was.y ) );
		engine.setGraph( graph, 'k7' );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		expect( overlappingHulls( engine.model() ) ).not.toEqual( [] );
		engine.drop();
		settle( engine );
		expectClear( engine.model() );
	} );

	it( 'reheats for a new node that comes with a returning one', () => {
		const engine = settled();
		const b = { ...leaf( engine, 'b' ) };
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.setGraph( withNode( small(), node( 'e' ) ), 'k7' );
		expect( leaf( engine, 'b' ).x ).toBe( b.x );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		expect( engine.running() ).toBe( true );
	} );

	it( 'reheats for a link that changes as a node leaves', () => {
		const engine = settled();
		const graph = without( small(), 'd' );
		engine.setGraph(
			{ ...graph, links: [ ...graph.links, link( 'a', 'c' ) ] },
			'k7'
		);
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
	} );

	it( 'forgets a node that left before a reset', () => {
		const engine = settled();
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.reset();
		settle( engine );
		engine.setGraph( small(), 'k7' );
		expect( engine.running() ).toBe( true );
	} );

	it( 'forgets a node that left under another key', () => {
		const engine = settled();
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.setGraph( without( small(), 'b' ), 'k8' );
		settle( engine );
		engine.setGraph( small(), 'k8' );
		expect( engine.running() ).toBe( true );
	} );

	it.each( [
		[
			'an added link',
			( graph ) => ( {
				...graph,
				links: [ ...graph.links, link( 'a', 'd' ) ],
			} ),
		],
		[
			'a parallel link',
			( graph ) => ( {
				...graph,
				links: [ ...graph.links, link( 'a', 'b' ) ],
			} ),
		],
		[
			'a removed link',
			( graph ) => ( { ...graph, links: graph.links.slice( 1 ) } ),
		],
		[
			'a node that joins a group',
			( graph ) => ( {
				...graph,
				nodes: graph.nodes.map( ( one ) =>
					'a' === one.id ? { ...one, group: 'g' } : one
				),
				groups: [ group( 'g' ) ],
			} ),
		],
	] )( 'reheats for %s', ( _name, change ) => {
		const engine = settled();
		const before = spots( engine );
		engine.setGraph( change( small() ), 'k7' );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		expect( spots( engine ) ).toEqual( before );
	} );

	it.each( [
		[ 'alone', [] ],
		[ 'beside a removal', [ node( 'd' ) ] ],
	] )(
		'reheats for a regrouped group %s, and ends clear',
		( _name, gone ) => {
			const graph = ( parent, extra = [] ) => ( {
				nodes: [
					node( 'a', { group: 'g' } ),
					node( 'b', { group: 'h' } ),
					node( 'c', { group: 'i' } ),
					...extra,
				],
				links: [],
				groups: [ group( 'g' ), group( 'h', parent ), group( 'i' ) ],
			} );
			const engine = settled( graph( 'g', gone ) );
			engine.setGraph( graph( 'i' ), 'k7' );
			expect( engine.running() ).toBe( true );
			settle( engine );
			expectClear( engine.model() );
		}
	);

	it( 'moves nothing when a removal dissolves a hull', () => {
		const nodes = [
			node( 'a', { group: 'w/a' } ),
			node( 'b', { group: 'w/b' } ),
		];
		const groups = [
			group( 'w' ),
			group( 'w/a', 'w' ),
			group( 'w/b', 'w' ),
		];
		const engine = settled( { nodes, links: [], groups } );
		const before = spots( engine );
		engine.setGraph( { nodes: nodes.slice( 1 ), links: [], groups }, 'k7' );
		expect( engine.running() ).toBe( false );
		engine.setGraph( { nodes, links: [], groups }, 'k7' );
		expect( engine.running() ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'keeps an opening layout untangling through a clear flap', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 23 );
		const alpha = mockSimulation.alpha();
		engine.setGraph( without( small(), 'd' ), 'k7' );
		engine.setGraph( small(), 'k7' );
		expect( mockSimulation.alpha() ).toBe( alpha );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'never cools, but ends the untangling, when it reheats', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 23 );
		const alpha = mockSimulation.alpha();
		expect( alpha ).toBeGreaterThan( 0.4 );
		engine.setGraph( withNode( small(), node( 'e' ) ), 'k7' );
		expect( mockSimulation.alpha() ).toBe( alpha );
		frames( 40 );
		expect( mockTurns ).toBe( 23 );
	} );

	it( 'brings a node back at rest, and its neighbors at their speed', () => {
		const engine = make();
		engine.setGraph( classGraph(), 'k7' );
		frames( 9 );
		const [ gone, kept ] = [ 'Base_04', 'Base_05' ].map( ( id ) => ( {
			...leaf( engine, id ),
		} ) );
		expect( gone.vx * kept.vx ).not.toBe( 0 );
		engine.setGraph( without( classGraph(), 'Base_04' ), 'k7' );
		engine.setGraph( classGraph(), 'k7' );
		const back = leaf( engine, 'Base_04' );
		expect( [ back.x, back.vx, back.vy ] ).toEqual( [ gone.x, 0, 0 ] );
		const { vx, vy } = leaf( engine, 'Base_05' );
		expect( [ vx, vy ] ).toEqual( [ kept.vx, kept.vy ] );
	} );

	it( 'is still at once when it empties', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 11 );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		expect( engine.running() ).toBe( false );
	} );
} );

describe( 'a drag', () => {
	it( 'holds the layout until the drop, which reheats it', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine.setGraph( small(), 'k7' );
		frames( 31 );
		onTick.mockClear();

		engine.drag( 'a', 2222, 1777 );
		const held = spots( engine );
		expect( held[ 0 ] ).toEqual( [ 'a', 2222, 1777 ] );
		frames( 10 );
		expect( spots( engine ) ).toEqual( held );
		expect( onTick ).not.toHaveBeenCalled();

		engine.drop();
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		frames( 10 );
		expect( spots( engine ) ).not.toEqual( held );
		expect( onTick ).toHaveBeenCalledTimes( 10 );
		settle( engine );
		expect( engine.running() ).toBe( false );
		expect( mockTurns ).toBe( 31 );
	} );

	it( 'pins nothing afterwards', () => {
		const engine = settled();
		engine.drag( 'a', 4222, 3777 );
		engine.drop();
		expect( engine.running() ).toBe( true );
		settle( engine );
		expect( leaf( engine, 'a' ).x ).toBeLessThan( 4000 );
	} );

	it( 'of a group moves its leaves, and no others', () => {
		const engine = make();
		engine.setGraph( classGraph(), 'k7' );
		frames( 7 );
		const before = new Map(
			spots( engine ).map( ( [ id, x, y ] ) => [ id, [ x, y ] ] )
		);
		engine.dragGroup( 'beta', 41, -29 );
		for ( const { id, x, y, ancestors } of engine.model().leaves ) {
			const [ wasX, wasY ] = before.get( id );
			const moved = [ ...ancestors ].some(
				( b ) => 'group:beta' === b.id
			);
			expect( [ x, y ] ).toEqual(
				moved ? [ wasX + 41, wasY - 29 ] : [ wasX, wasY ]
			);
		}
		engine.drop();
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		mockTurns = 0;
		settle( engine );
		expect( mockTurns ).toBe( 0 );
		expectClear( engine.model() );
	} );

	it.each( [
		[ 'a reset', ( engine ) => engine.reset() ],
		[ 'a new key', ( engine ) => engine.setGraph( small(), 'k8' ) ],
	] )( 'dropped after %s ends its untangling', ( _name, act ) => {
		const engine = settled();
		engine.drag( 'a', 2222, 1777 );
		act( engine );
		mockTurns = 0;
		engine.drop();
		settle( engine );
		expect( mockTurns ).toBe( 0 );
	} );

	it( 'of what the graph does not hold does nothing', () => {
		const engine = settled( twoGroups() );
		const before = spots( engine );
		engine.drag( 'gone', 5, 6 );
		engine.drag( 'group:g', 5, 6 );
		engine.dragGroup( 'gone', 5, 6 );
		engine.drop();
		expect( engine.running() ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'is not a drop by itself', () => {
		const engine = settled();
		engine.drop();
		expect( engine.running() ).toBe( false );
	} );

	it( 'is not let go by a poll', () => {
		const engine = settled( small(), { live: true } );
		engine.drag( 'a', 2222, 1777 );
		const held = spots( engine );
		poll( engine );
		frames( 10 );
		expect( spots( engine ) ).toEqual( held );
	} );
} );

describe( 'rates', () => {
	const charges = ( engine ) => {
		const strength = mockSimulation.force( 'charge' ).strength();
		return engine.model().leaves.map( ( one ) => strength( one ) );
	};

	it( 'charge a live leaf, and leave the rest at the fixed charge', () => {
		const engine = settled( small(), { live: true } );
		poll( engine, ( i ) => 10 ** i - 1 );
		expect( charges( engine ) ).toEqual(
			[ 0, 9, 99, 999 ].map( chargeOf )
		);

		const fixed = settled();
		poll( fixed );
		expect( fixed.running() ).toBe( false );
		expect( charges( fixed ) ).toEqual( [
			CHARGE,
			CHARGE,
			CHARGE,
			CHARGE,
		] );
	} );

	it( 'move a live layout by their charge', () => {
		const spread = ( rate ) => {
			const engine = settled( small(), { live: true } );
			poll( engine, () => rate );
			frames( 400 );
			const [ a, d ] = [ leaf( engine, 'a' ), leaf( engine, 'd' ) ];
			return Math.hypot( a.x - d.x, a.y - d.y );
		};
		expect( spread( 7000 ) ).toBeGreaterThan( spread( 0 ) + 10 );
	} );

	it( 'raise the energy of an opening layout', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		frames( 400 );
		const cooled = mockSimulation.alpha();
		expect( cooled ).toBeLessThan( 0.05 );

		poll( engine );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		frames( 150 );
		expect( mockSimulation.alpha() ).toBeGreaterThan( 0.3 );
		expect( mockSimulation.alpha() ).toBeLessThan( 0.5 );
	} );

	it( 'trade nothing after the untangling ticks', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		for ( let i = 0; i < 8; i++ ) {
			frames( POLL_FRAMES );
			poll( engine );
		}
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
		expect( engine.running() ).toBe( true );
	} );

	it( 'step down, let go on the tenth steady poll and then only charge', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		const steps = times( 10, () => {
			frames( 3 );
			engine.setGraph( small(), 'k7' );
			poll( engine );
			return [
				mockSimulation.alphaTarget(),
				mockSimulation.velocityDecay(),
			].map( ( value ) => Number( value.toFixed( 4 ) ) );
		} );
		expect( steps ).toEqual( [
			[ 0.45, 0.55 ],
			[ 0.4, 0.6 ],
			[ 0.35, 0.65 ],
			[ 0.3, 0.7 ],
			[ 0.25, 0.75 ],
			[ 0.2, 0.8 ],
			[ 0.15, 0.85 ],
			[ 0.1, 0.9 ],
			[ 0.1, 0.95 ],
			[ 0, 0.5 ],
		] );
		expect( engine.running() ).toBe( true );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		settle( engine );

		const still = spots( engine );
		poll( engine, () => 61 );
		expect( charges( engine )[ 2 ] ).toBe( chargeOf( 61 ) );
		expect( engine.running() ).toBe( false );
		frames( 30 );
		expect( spots( engine ) ).toEqual( still );
	} );

	it( 'end the class graph clear', () => {
		const engine = make( { live: true } );
		engine.setGraph( classGraph(), 'k7' );
		for ( let i = 0; i <= 10; i++ ) {
			frames( POLL_FRAMES );
			poll( engine );
		}
		settle( engine );
		expect( engine.running() ).toBe( false );
		expectClear( engine.model() );
	} );

	it( 'hold their steps while kept warm', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		poll( engine );
		engine.setKeepWarm( true );
		for ( let i = 0; i < 20; i++ ) {
			frames( POLL_FRAMES );
			poll( engine );
		}
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.55 );

		engine.setKeepWarm( false );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
	} );

	it( 'start the ten again for a changed set', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		for ( let i = 0; i <= 10; i++ ) {
			poll( engine );
		}
		settle( engine );

		engine.setGraph( without( small(), 'd' ), 'k7' );
		poll( engine );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
	} );

	it( 'leave a live layout live through a changed set', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		engine.setGraph( withNode( small(), node( 'e' ) ), 'k7' );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
	} );

	it( 'are dropped by a full layout until the next poll', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		poll( engine );
		engine.reset();
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
	} );

	it.each( [
		[ 'a reset', ( engine ) => engine.reset() ],
		[ 'a new key', ( engine ) => engine.setGraph( small(), 'k8' ) ],
	] )( 'start the ten again for %s', ( _name, act ) => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		times( 5, () => poll( engine ) );
		act( engine );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		times( 10, () => poll( engine ) );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'start again for keep warm once the layout was let go', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		times( 11, () => poll( engine ) );
		settle( engine );
		engine.setKeepWarm( false );
		poll( engine );
		expect( engine.running() ).toBe( false );

		engine.setKeepWarm( true );
		expect( engine.running() ).toBe( false );
		const still = spots( engine );
		times( 3, () => poll( engine ) );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		frames( 40 );
		expect( spots( engine ) ).not.toEqual( still );

		engine.setKeepWarm( false );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		times( 9, () => poll( engine ) );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'hold the energy for six hundred ticks, and then let it lapse', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		poll( engine );
		frames( 400 );
		poll( engine );
		frames( 599 );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.6 );
		frames( 1 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		expect( engine.running() ).toBe( true );
		settle( engine );
		expect( engine.running() ).toBe( false );
		expectClear( engine.model() );

		poll( engine );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.35 );
		times( 6, () => poll( engine ) );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.1 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'lapse while kept warm too', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		times( 4, () => poll( engine ) );
		engine.setKeepWarm( true );
		poll( engine );
		settle( engine );
		expect( engine.running() ).toBe( false );
		poll( engine );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.35 );
	} );

	it( 'do not stir an empty graph', () => {
		const engine = make( { live: true } );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		poll( engine );
		expect( engine.running() ).toBe( false );
	} );
} );

describe.each( [
	[ 'paused', 'setPaused', false ],
	[ 'hidden', 'setHidden', false ],
	[ 'held by a gesture', 'setHeld', true ],
] )( 'while %s', ( _name, method, willRun ) => {
	it( 'a poll charges the leaves and moves nothing', () => {
		const engine = settled( small(), { live: true } );
		const before = spots( engine );
		engine[ method ]( true );
		for ( let i = 0; i < 13; i++ ) {
			poll( engine, () => 88 );
			frames( 5 );
		}
		expect( spots( engine ) ).toEqual( before );
		const charge = mockSimulation.force( 'charge' ).strength();
		expect( charge( leaf( engine, 'a' ) ) ).toBe( chargeOf( 88 ) );

		engine[ method ]( false );
		expect( engine.running() ).toBe( false );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );

		poll( engine );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
	} );

	it( 'an unfinished layout waits, and goes on when it ends', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 17 );
		engine[ method ]( true );
		const before = spots( engine );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );
		expect( engine.running() ).toBe( willRun );

		engine[ method ]( false );
		expect( engine.running() ).toBe( true );
		settle( engine );
		expect( engine.running() ).toBe( false );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
	} );

	it( 'a graph, a reset and a drop wait too', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine[ method ]( true );
		engine.setGraph( small(), 'k7' );
		engine.reset();
		engine.drag( 'a', 71, 72 );
		engine.drop();
		frames( 10 );
		expect( onTick ).not.toHaveBeenCalled();
		expect( engine.running() ).toBe( willRun );
		engine[ method ]( false );
		expect( engine.running() ).toBe( true );
	} );
} );

describe.each( [
	[ 0, 0 ],
	[ 0, 777 ],
	[ 1313, 0 ],
] )( 'a canvas of %d by %d', ( width, height ) => {
	it( 'leaves the full layout pending until it has area', () => {
		const start = placed( twoGroups() );
		const onTick = jest.fn();
		const engine = make( { width, height, onTick, live: true } );
		engine.setGraph( small(), 'k7' );
		engine.setGraph( twoGroups(), 'k7' );
		times( 4, () => poll( engine ) );
		engine.drag( 'n03', 41, 43 );
		engine.drop();
		frames( 10 );
		expect( engine.running() ).toBe( false );
		expect( onTick ).not.toHaveBeenCalled();
		expectFinite( engine );

		engine.setSize( SIZE );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( spots( engine ) ).toEqual( start );
		frames( 1 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
		expectFinite( engine );
		expectClear( engine.model() );
	} );

	it( 'leaves a reset pending, and a layout under way alone', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 9 );
		engine.setSize( { width, height } );
		settle( engine );
		const before = spots( engine );
		expect( before ).toEqual( spots( settled() ) );

		mockTurns = 0;
		engine.reset();
		frames( 10 );
		expect( engine.running() ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
		engine.setSize( { width: 1414, height: 888 } );
		expect( engine.running() ).toBe( true );
		settle( engine );
		expect( mockTurns ).toBe( UNTANGLE_TICKS );
		engine.setSize( { width: 1515, height: 999 } );
		expect( engine.running() ).toBe( false );
	} );
} );

describe( 'a change of live', () => {
	const charges = ( engine ) => {
		const strength = mockSimulation.force( 'charge' ).strength();
		return engine.model().leaves.map( ( one ) => strength( one ) );
	};

	it( 'charges the leaves anew and reheats, laying nothing out', () => {
		const engine = settled();
		const before = spots( engine );
		mockTurns = 0;

		engine.setLive( true );
		expect( charges( engine ) ).toEqual( Array( 4 ).fill( chargeOf( 0 ) ) );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		expect( spots( engine ) ).toEqual( before );
		frames( 1 );
		expect( spots( engine ) ).not.toEqual( before );
		settle( engine );
		expect( mockTurns ).toBe( 0 );

		engine.setLive( false );
		expect( charges( engine ) ).toEqual( Array( 4 ).fill( CHARGE ) );
		expect( engine.running() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
	} );

	it.each( [ true, false ] )(
		'leaves an opening layout its untangling: %s',
		( live ) => {
			const engine = make( { live: ! live } );
			engine.setGraph( small(), 'k7' );
			frames( 100 );
			const alpha = mockSimulation.alpha();
			engine.setLive( live );
			expect( mockSimulation.alpha() ).toBe( alpha );
			settle( engine );
			expect( mockTurns ).toBe( UNTANGLE_TICKS );
		}
	);

	it( 'moves the leaves by their new charge', () => {
		const engine = settled();
		const apart = () => {
			const [ a, d ] = [ leaf( engine, 'a' ), leaf( engine, 'd' ) ];
			return Math.hypot( a.x - d.x, a.y - d.y );
		};
		const fixed = apart();
		engine.setLive( true );
		settle( engine );
		expect( apart() ).toBeLessThan( fixed - 1 );
	} );

	it( 'ends the energy and friction its polls held', () => {
		const engine = settled( small(), { live: true } );
		engine.setKeepWarm( true );
		poll( engine );
		engine.setKeepWarm( false );
		poll( engine );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.6 );

		engine.setLive( false );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( settle( engine ) ).toBeLessThan( TOO_MANY );
	} );

	it( 'keeps the rates of the last poll for when it is live again', () => {
		const engine = settled( small(), { live: true } );
		poll( engine, ( i ) => 10 ** i - 1 );
		engine.setLive( false );
		engine.setLive( true );
		expect( charges( engine ) ).toEqual(
			[ 0, 9, 99, 999 ].map( chargeOf )
		);
	} );

	it.each( [ true, false ] )( 'is not one to the same: %s', ( live ) => {
		const engine = settled( small(), { live } );
		engine.setLive( live );
		expect( engine.running() ).toBe( false );
	} );

	it( 'leaves an opening layout waiting for area still', () => {
		const engine = make( { width: 0, height: 0 } );
		engine.setGraph( small(), 'k7' );
		engine.setLive( true );
		expect( engine.running() ).toBe( false );
		engine.setSize( { width: 1515, height: 999 } );
		expect( engine.running() ).toBe( true );
		expect( charges( engine )[ 1 ] ).toBe( chargeOf( 0 ) );
	} );
} );

describe( 'reduced motion', () => {
	// Each read of `performance.now` moves it on by `step` ms.
	const stepClock = ( step ) => {
		let now = performance.now();
		jest.spyOn( performance, 'now' ).mockImplementation(
			() => ( now += step )
		);
	};

	it( 'lays out in slices and paints once, at the end', () => {
		stepClock( 5 );
		const onTick = jest.fn( () =>
			expect( engine.running() ).toBe( false )
		);
		const engine = make( { onTick, reducedMotion: true } );
		engine.setGraph( small(), 'k7' );
		const ticks = jest.spyOn( mockSimulation, 'tick' );
		frames( 1 );
		expect( ticks.mock.calls.length ).toBeGreaterThan( 0 );
		expect( ticks.mock.calls.length ).toBeLessThan( 6 );
		expect( onTick ).not.toHaveBeenCalled();

		const slices = settle( engine );
		expect( slices ).toBeGreaterThan( 100 );
		expect( slices ).toBeLessThan( LAYOUT_TICKS );
		frames( 30 );
		expect( onTick ).toHaveBeenCalledTimes( 1 );
		expect( ticks ).toHaveBeenCalledTimes( LAYOUT_TICKS );
	} );

	it( 'takes a slice of twelve milliseconds', () => {
		stepClock( 0 );
		const engine = make( { reducedMotion: true } );
		engine.setGraph( small(), 'k7' );
		let spent = 0;
		const { tick } = mockSimulation;
		const base = performance.now();
		const ticks = jest
			.spyOn( mockSimulation, 'tick' )
			.mockImplementation( () => {
				spent += 5;
				return tick();
			} );
		performance.now.mockImplementation( () => base + spent );
		frames( 1 );
		expect( ticks ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'ends where a painted layout ends', () => {
		const painted = settled( twoGroups() );
		const unpainted = settled( twoGroups(), { reducedMotion: true } );
		expect( spots( unpainted ) ).toEqual( spots( painted ) );
	} );

	it( 'paints once more for a reheat', () => {
		const onTick = jest.fn();
		const engine = settled( small(), { onTick, reducedMotion: true } );
		engine.drag( 'a', 2222, 1777 );
		engine.drop();
		settle( engine );
		expect( onTick ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'never moves for a rate', () => {
		const onTick = jest.fn();
		const engine = settled( small(), {
			onTick,
			live: true,
			reducedMotion: true,
		} );
		const before = spots( engine );
		poll( engine );
		expect( engine.running() ).toBe( false );
		frames( 30 );
		expect( spots( engine ) ).toEqual( before );
		expect( onTick ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'a graph with little in it', () => {
	const bare = ( count ) => ( {
		nodes: times( count, ( i ) => node( `n${ i }` ) ),
		links: [],
		groups: [],
	} );

	it.each( [
		[ 'nothing', bare( 0 ) ],
		[ 'one node', bare( 1 ) ],
		[
			'one node linked to itself',
			{
				...bare( 1 ),
				links: [ link( 'n0', 'n0' ) ],
			},
		],
		[ 'nodes without links', bare( 17 ) ],
	] )( 'ends still with finite positions: %s', ( _name, graph ) => {
		const engine = settled( graph );
		expect( engine.running() ).toBe( false );
		expectFinite( engine );
		expect( overlappingLabels( engine.model() ) ).toEqual( [] );
	} );

	it( 'answers an empty model before the first graph', () => {
		const engine = make();
		expect( engine.model().leaves ).toEqual( [] );
		engine.reset();
		expect( engine.running() ).toBe( false );
	} );
} );

describe( 'a drag, while it lasts', () => {
	it( 'holds a layout that will run when it ends', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 5 );
		engine.drag( 'a', 71, 72 );
		frames( 3 );
		expect( engine.ticks() ).toBe( 5 );
		expect( engine.running() ).toBe( true );
	} );

	it( 'leaves a still layout still until it ends', () => {
		const engine = settled();
		engine.drag( 'a', 71, 72 );
		expect( engine.running() ).toBe( false );
		engine.drop();
		expect( engine.running() ).toBe( true );
	} );
} );

describe( 'ticks', () => {
	it( 'counts every tick the layout runs, painted or not', () => {
		const engine = make();
		expect( engine.ticks() ).toBe( 0 );
		engine.setGraph( small(), 'k7' );
		frames( 13 );
		expect( engine.ticks() ).toBe( 13 );
		const unpainted = settled( small(), { reducedMotion: true } );
		expect( unpainted.ticks() ).toBe( LAYOUT_TICKS );
	} );
} );

describe( 'onTick', () => {
	it( 'is not called once the graph is emptied', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine.setGraph( small(), 'k7' );
		frames( 3 );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		expect( engine.running() ).toBe( false );
		frames( 3 );
		expect( onTick ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'fires once a frame, the last one still', () => {
		const ran = [];
		const engine = make( { onTick: () => ran.push( engine.running() ) } );
		engine.setGraph( small(), 'k7' );
		settle( engine );
		frames( 20 );
		expect( ran ).toHaveLength( LAYOUT_TICKS );
		expect( ran[ LAYOUT_TICKS - 2 ] ).toBe( true );
		expect( ran[ LAYOUT_TICKS - 1 ] ).toBe( false );
	} );
} );

describe( 'destroy', () => {
	it( 'stops the timer', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine.setGraph( small(), 'k7' );
		frames( 8 );
		expect( engine.running() ).toBe( true );
		engine.destroy();
		expect( engine.running() ).toBe( false );
		const before = spots( engine );
		frames( 8 );
		expect( onTick ).toHaveBeenCalledTimes( 8 );
		expect( spots( engine ) ).toEqual( before );
		expect( jest.getTimerCount() ).toBe( 0 );
	} );

	it( 'leaves nothing a later call can start', () => {
		const onTick = jest.fn();
		const engine = make( { onTick, live: true } );
		engine.setGraph( small(), 'k7' );
		engine.destroy();
		engine.setGraph( small(), 'k8' );
		poll( engine );
		engine.setLive( false );
		engine.reset();
		engine.setPaused( false );
		engine.setHeld( false );
		frames( 8 );
		expect( onTick ).not.toHaveBeenCalled();
	} );
} );
