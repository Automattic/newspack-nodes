/**
 * Tests for the force graph's engine: when a layout runs, paints and rests, run
 * on real d3 with fake timers and a clock that makes each frame one tick.
 *
 * d3-timer binds the frame scheduler as it loads, so the fake timers come
 * first and the modules are required after them. The d3 and untangle modules
 * are the real ones, wrapped to show the simulation and the timer and to count,
 * or leave out, the untangling.
 */

let mockSimulation;
let mockTimer;
let mockUntangles = true;
let mockSettles = null;
let mockTurns = 0;

jest.mock( 'd3', () => {
	const actual = jest.requireActual( 'd3' );
	const { watchTimer } = require( './watchTimer' );
	return {
		...actual,
		forceSimulation: ( ...args ) =>
			( mockSimulation = actual.forceSimulation( ...args ) ),
		timer: ( ...args ) =>
			( mockTimer = watchTimer( actual.timer( ...args ) ) ),
	};
} );

jest.mock( '../untangle', () => {
	const actual = jest.requireActual( '../untangle' );
	return {
		...actual,
		createUntangler: ( model ) => {
			const untangle = actual.createUntangler( model );
			return (
				untangle &&
				( () => {
					mockTurns++;
					const settled = mockUntangles ? untangle() : true;
					return mockSettles ?? settled;
				} )
			);
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

/** Ticks of a full layout that untangle, and the ones of them that trade. */
const UNTANGLE_TICKS = 680;
const TRADING_TICKS = 170;

/** Milliseconds of ticks in a frame that is not painted. */
const SLICE_MS = 12;

/** Ticks from alpha 0.5 to a stop. */
const LAYOUT_TICKS = 826;

/** Ticks of a full layout that are painted, the last that untangles first. */
const PAINTED_TICKS = LAYOUT_TICKS - UNTANGLE_TICKS + 1;

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

// What `performance.now` answers, which d3 reads: it never goes back.
let clock = 1000;

/**
 * Make each read of the clock move it on. By a slice, the default, a frame is
 * one tick.
 *
 * @param {number} step Milliseconds.
 */
const stepClock = ( step = SLICE_MS ) => {
	jest.spyOn( performance, 'now' ).mockImplementation(
		() => ( clock += step )
	);
};

/** Each engine's timer. */
const timers = new Map();
const make = ( { live = false, ...options } = {} ) => {
	const engine = createEngine( { ...SIZE, onTick: () => {}, ...options } );
	engine.setLive( live );
	timers.set( engine, mockTimer );
	return engine;
};

// Whether an engine has frames to come.
const isRunning = ( engine ) => timers.get( engine ).runs;

const frames = ( count ) => {
	for ( let i = 0; i < count; i++ ) {
		jest.advanceTimersToNextFrame();
	}
};

/**
 * Run the frames of a stretch of time, which they alone take.
 *
 * @param {number} ms      Milliseconds.
 * @param {number} [frame] Milliseconds from one frame to the next.
 */
const pass = ( ms, frame = 20 ) => {
	stepClock( 0 );
	for ( const end = clock + ms; clock < end;  ) {
		clock += frame;
		frames( 1 );
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
	while ( isRunning( engine ) && count < TOO_MANY ) {
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

// A graph whose untangling has just ended.
const afterUntangling = ( graph = small(), options = {} ) => {
	const engine = make( options );
	engine.setGraph( graph, 'k7' );
	frames( UNTANGLE_TICKS );
	return engine;
};

const leaf = ( engine, id ) => engine.model().byId.get( id );
const spots = ( engine ) =>
	engine.model().leaves.map( ( { id, x, y } ) => [ id, x, y ] );
// The nodes a group holds, at any depth, and where each stands.
const spotsOf = ( engine, id ) =>
	engine
		.model()
		.branches.find( ( branch ) => id === branch.group.id )
		.leafNodes.map( ( one ) => ( { ...one } ) );
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

// Hulls part and hold their labels; labels may meet, as in the visualizer.
const expectClear = ( model ) => {
	expect( overlappingHulls( model ) ).toEqual( [] );
	expect( labelsOutsideHulls( model ) ).toEqual( [] );
};

const expectFinite = ( engine ) =>
	engine.model().leaves.forEach( ( { x, y } ) => {
		expect( Number.isFinite( x ) ).toBe( true );
		expect( Number.isFinite( y ) ).toBe( true );
	} );

beforeEach( () => {
	stepClock();
	mockUntangles = true;
	mockSettles = null;
	mockTurns = 0;
} );

afterEach( () => {
	timers.forEach( ( _timer, engine ) => engine.destroy() );
	timers.clear();
	jest.restoreAllMocks();
} );

describe( 'the forces', () => {
	it( 'centre the layout with d3’s forceCenter, pull each node weakly toward the canvas centre, and repel no farther than its larger side, after a resize too', () => {
		const engine = settled();
		const gravityX = mockSimulation.force( 'gravityX' );
		const gravityY = mockSimulation.force( 'gravityY' );
		const charge = mockSimulation.force( 'charge' );
		expect( mockSimulation.force( 'collide' ) ).toBeUndefined();
		const center = mockSimulation.force( 'center' );
		const toward = () => [ gravityX.x()(), gravityY.y()() ];
		expect( toward() ).toEqual( [ 656.5, 388.5 ] );
		expect( [ center.x(), center.y() ] ).toEqual( [ 656.5, 388.5 ] );
		const a = leaf( engine, 'a' );
		expect( [
			gravityX.strength()( a ),
			gravityY.strength()( a ),
		] ).toEqual( [ 0.002, 0.002 ] );
		expect( charge.distanceMax() ).toBe( 1313 );
		engine.setSize( { width: 901, height: 1555 } );
		expect( toward() ).toEqual( [ 450.5, 777.5 ] );
		expect( [ center.x(), center.y() ] ).toEqual( [ 450.5, 777.5 ] );
		expect( charge.distanceMax() ).toBe( 1555 );
	} );

	it( 'keep the layout’s mean within a pixel of the canvas centre while kept warm, as forceCenter does', () => {
		const engine = make( { live: true } );
		engine.setKeepWarm( true );
		engine.setGraph( small(), 'k7' );
		const mean = () => {
			const { leaves } = engine.model();
			return [ 'x', 'y' ].map(
				( axis ) =>
					leaves.reduce( ( sum, one ) => sum + one[ axis ], 0 ) /
					leaves.length
			);
		};
		for ( let i = 0; i < 12; i++ ) {
			poll( engine );
			frames( POLL_FRAMES );
			const [ x, y ] = mean();
			expect( Math.hypot( x - 656.5, y - 388.5 ) ).toBeLessThan( 1 );
		}
	} );
} );

describe( 'the copied forces', () => {
	it( 'approximate the charge at theta 0.93, and pull a live line 30 pixels between its ends by 1 over its less joined end', () => {
		const engine = settled(
			withNode(
				{ ...small(), links: [ ...small().links, link( 'a', 'z' ) ] },
				node( 'z' )
			),
			{ live: true }
		);
		expect( mockSimulation.force( 'charge' ).theta() ).toBe( 0.93 );
		const pull = mockSimulation.force( 'link' );
		const pulls = engine.model().pulls;
		const degree = ( id ) =>
			pulls.filter( ( { source, target } ) =>
				[ source.id, target.id ].includes( id )
			).length;
		pulls.forEach( ( one ) => {
			expect( pull.distance()( one ) ).toBe(
				30 + one.source.radius + one.target.radius
			);
			expect( pull.strength()( one ) ).toBeCloseTo(
				1 / Math.min( degree( one.source.id ), degree( one.target.id ) )
			);
		} );
	} );
} );

describe( 'a full layout', () => {
	it( 'untangles on, reheated, while its untangler has not settled, three times at most', () => {
		mockSettles = false;
		const engine = make();
		engine.setGraph( small(), 'k7' );
		settle( engine );
		// Each untangling more runs alpha 0.1 to 0.003, trading every fourth tick.
		expect( mockTurns ).toBe( TRADING_TICKS + 3 * 116 );
	} );

	it( 'untangles no more once its untangler settles', () => {
		mockSettles = false;
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 1 );
		mockSettles = true;
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'runs on the first graph with nodes, and stops', () => {
		const engine = make();
		expect( isRunning( engine ) ).toBe( false );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		expect( isRunning( engine ) ).toBe( false );

		engine.setGraph( small(), 'k7' );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( settle( engine ) ).toBe( LAYOUT_TICKS );

		const still = spots( engine );
		frames( 50 );
		expect( spots( engine ) ).toEqual( still );
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'runs again on a changed key', () => {
		const engine = settled();
		mockTurns = 0;

		engine.setGraph( small(), 'k8' );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
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
		expect( isRunning( engine ) ).toBe( true );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
		expect( spots( engine ) ).toEqual( first );
	} );

	it( 'is where a graph that changed key while empty starts', () => {
		const engine = settled();
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k8' );
		expect( isRunning( engine ) ).toBe( false );
		mockTurns = 0;

		engine.setGraph( small(), 'k8' );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'is where a graph that emptied starts again, under one key', () => {
		const engine = settled();
		engine.drag( 'a', 2222, 1777 );
		engine.drop();
		settle( engine );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		mockTurns = 0;

		engine.setGraph( small(), 'k7' );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( spots( engine ) ).toEqual( placed( small() ) );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
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

	it( 'pulls a line 250 pixels while not live, and 30 between its ends once live', () => {
		const engine = settled();
		const [ first ] = engine.model().pulls;
		expect( mockSimulation.force( 'link' ).distance()( first ) ).toBe(
			250
		);
		engine.setLive( true );
		expect( mockSimulation.force( 'link' ).distance()( first ) ).toBe(
			30 + first.source.radius + first.target.radius
		);
	} );

	it( 'ends with a pulled pair the link distance apart or more', () => {
		const engine = settled();
		const { pulls } = engine.model();
		const [ { source, target } ] = pulls;
		const distance = 250;
		expect( mockSimulation.force( 'link' ).distance()( pulls[ 0 ] ) ).toBe(
			distance
		);
		expect( mockSimulation.force( 'link' ).strength()( pulls[ 0 ] ) ).toBe(
			1
		);
		expect(
			Math.hypot( source.x - target.x, source.y - target.y )
		).toBeGreaterThan( distance - 10 );
	} );

	it( 'pulls a link as hard as it asks', () => {
		const engine = settled( {
			...small(),
			links: [
				link( 'a', 'b', { strength: 0.23 } ),
				link( 'b', 'c', { strength: undefined } ),
			],
		} );
		expect(
			engine
				.model()
				.pulls.map( mockSimulation.force( 'link' ).strength() )
		).toEqual( [ 0.23, 1 ] );
	} );

	it( 'ends with a pair of its own distance that far apart', () => {
		const engine = settled( {
			...small(),
			links: [
				link( 'a', 'b', { distance: 131 } ),
				link( 'b', 'c', { distance: undefined } ),
			],
		} );
		const apart = ( one, two ) =>
			Math.hypot(
				leaf( engine, one ).x - leaf( engine, two ).x,
				leaf( engine, one ).y - leaf( engine, two ).y
			);
		const edges = 250;
		expect(
			engine
				.model()
				.pulls.map( mockSimulation.force( 'link' ).distance() )
		).toEqual( [ 131, edges ] );
		expect( Math.abs( apart( 'a', 'b' ) - 131 ) ).toBeLessThan( 30 );
		expect( apart( 'b', 'c' ) ).toBeGreaterThan( edges - 10 );
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
		expect( isRunning( engine ) ).toBe( false );
		engine.drag( 'd', before + 1, leaf( engine, 'd' ).y );
		engine.drop();
		settle( engine );
		expect( leaf( engine, 'd' ).x - before ).toBeGreaterThan( 300 );
	} );
} );

describe( 'the untangling of a full layout', () => {
	it( 'is not painted, and every frame after it is', () => {
		const paints = [];
		const engine = make( {
			onTick: () =>
				paints.push( [ engine.ticks(), engine.runsUnpainted() ] ),
		} );
		expect( engine.runsUnpainted() ).toBe( false );
		engine.setGraph( small(), 'k7' );
		expect( engine.runsUnpainted() ).toBe( true );
		frames( UNTANGLE_TICKS - 1 );
		expect( isRunning( engine ) ).toBe( true );
		expect( engine.runsUnpainted() ).toBe( true );
		expect( paints ).toEqual( [] );

		frames( 3 );
		expect( paints ).toEqual( [
			[ 680, false ],
			[ 681, false ],
			[ 682, false ],
		] );
		expect( mockSimulation.alpha() ).toBeLessThan( 0.003 );
	} );

	it( 'is told as it begins and as it ends, in time for its frame', () => {
		const told = [];
		const engine = make( {
			onUnpainted: ( unpainted ) => told.push( unpainted ),
			onTick: () => told.push( 'tick' ),
		} );
		engine.setGraph( small(), 'k7' );
		expect( told ).toEqual( [ true ] );
		frames( 9 );
		engine.reset();
		engine.setHeld( true );
		engine.setHeld( false );
		expect( told ).toEqual( [ true ] );
		frames( UNTANGLE_TICKS + 1 );
		expect( told ).toEqual( [ true, false, 'tick', 'tick' ] );
	} );

	it.each( [
		[ 'a pause', ( engine ) => engine.setPaused( true ) ],
		[ 'a hidden canvas', ( engine ) => engine.setHidden( true ) ],
		[ 'a drag', ( engine ) => engine.drag( 'a', 71, 72 ) ],
		[
			'an emptied graph',
			( engine ) =>
				engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' ),
		],
	] )( 'is told to have ended by %s', ( _name, act ) => {
		const onUnpainted = jest.fn();
		const engine = make( { onUnpainted } );
		engine.setGraph( small(), 'k7' );
		frames( 9 );
		act( engine );
		expect( onUnpainted.mock.calls ).toEqual( [ [ true ], [ false ] ] );
	} );

	it( 'runs in slices of twelve milliseconds, and paints a tick a frame', () => {
		stepClock( 0 );
		const engine = make();
		engine.setGraph( small(), 'k7' );
		const { tick } = mockSimulation;
		jest.spyOn( mockSimulation, 'tick' ).mockImplementation( () => {
			clock += 5;
			return tick();
		} );
		const perFrame = times( 2, () => {
			const before = engine.ticks();
			frames( 1 );
			return engine.ticks() - before;
		} );
		expect( perFrame ).toEqual( [ 3, 3 ] );

		frames( 224 );
		expect( engine.ticks() ).toBe( 678 );
		frames( 1 );
		expect( engine.ticks() ).toBe( 680 );
		frames( 1 );
		expect( engine.ticks() ).toBe( 681 );
	} );

	it( 'trades on every fourth tick, the first among them', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		const turns = times( 9, () => {
			frames( 1 );
			return mockTurns;
		} );
		expect( turns ).toEqual( [ 1, 1, 1, 1, 2, 2, 2, 2, 3 ] );
	} );

	it( 'cools by its own decay, at its own friction, whatever polls ask', () => {
		const polled = make( { live: true } );
		polled.setGraph( twoGroups(), 'k7' );
		for ( let i = 0; i < 4; i++ ) {
			poll( polled, () => 0 );
			expect( mockSimulation.alphaTarget() ).toBe( 0 );
			expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
			frames( 170 );
		}
		const alpha = mockSimulation.alpha();
		const at = spots( polled );

		const unpolled = afterUntangling( twoGroups(), { live: true } );
		expect( mockSimulation.alpha() ).toBe( alpha );
		expect( spots( unpolled ) ).toEqual( at );
	} );

	it( 'takes the charge of a poll at once, its energy at the end', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		frames( 41 );
		times( 4, () => poll( engine, () => 73 ) );
		const strength = mockSimulation.force( 'charge' ).strength();
		expect( strength( leaf( engine, 'c' ) ) ).toBe( chargeOf( 73 ) );
		frames( UNTANGLE_TICKS - 42 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );

		frames( 1 );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.35 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.65 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.3 );
	} );

	it( 'freezes a layout its tenth steady poll lets go, as d3_visualizer.html does, so a drop moves the rest only as a whole', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		frames( UNTANGLE_TICKS );
		// The first poll begins the count; ten steady ones follow.
		times( 11, () => poll( engine ) );
		expect( mockSimulation.velocityDecay() ).toBe( 1 );
		settle( engine );
		// Where each of the rest stands from b: the shape forceCenter keeps.
		const shape = () => {
			const b = leaf( engine, 'b' );
			return [ 'c', 'd' ].map( ( id ) => [
				leaf( engine, id ).x - b.x,
				leaf( engine, id ).y - b.y,
			] );
		};
		const still = shape();
		engine.drag( 'a', 37, 41 );
		engine.drop();
		settle( engine );
		shape().forEach( ( [ x, y ], i ) => {
			expect( x ).toBeCloseTo( still[ i ][ 0 ], 6 );
			expect( y ).toBeCloseTo( still[ i ][ 1 ], 6 );
		} );
	} );

	it( 'stops ticking a layout it freezes, and a drop on it ticks nothing', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		frames( UNTANGLE_TICKS );
		times( 11, () => poll( engine ) );
		frames( 1 );
		expect( isRunning( engine ) ).toBe( false );
		const ticks = engine.ticks();
		engine.drag( 'a', 37, 41 );
		engine.drop();
		frames( 30 );
		expect( isRunning( engine ) ).toBe( false );
		expect( engine.ticks() ).toBe( ticks );
		expect( [ leaf( engine, 'a' ).x, leaf( engine, 'a' ).y ] ).toEqual( [
			37, 41,
		] );
	} );

	it( 'freezes a layout its tenth steady poll lets go as its untangling ends, ticking no more', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		times( 10, () => poll( engine ) );
		frames( 3 );
		poll( engine );
		frames( UNTANGLE_TICKS - 3 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 1 );
		expect( settle( engine ) ).toBe( 0 );
	} );

	it( 'takes none of the time a poll’s energy holds', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		poll( engine );
		frames( UNTANGLE_TICKS );
		pass( 9960 );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		pass( 60 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
	} );

	it( 'begun again drops what polls asked of the one before', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		poll( engine );
		frames( 200 );
		engine.reset();
		frames( UNTANGLE_TICKS - 1 );
		expect( engine.runsUnpainted() ).toBe( true );
		frames( 1 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it.each( [
		[
			'a drag',
			( engine ) => engine.drag( 'a', 71, 72 ),
			( engine ) => engine.drop(),
		],
		[
			'a reheat',
			( engine ) =>
				engine.setGraph( withNode( small(), node( 'e' ) ), 'k7' ),
			() => {},
		],
	] )( 'is ended by %s, and paints from then on', ( _name, act, then ) => {
		const onTick = jest.fn();
		const engine = make( { onTick, live: true } );
		engine.setGraph( small(), 'k7' );
		frames( 41 );
		times( 3, () => poll( engine ) );
		act( engine );
		then( engine );
		expect( engine.runsUnpainted() ).toBe( false );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.6 );
		mockTurns = 0;
		frames( 5 );
		expect( onTick ).toHaveBeenCalledTimes( 5 );
		expect( engine.ticks() ).toBe( 46 );
		expect( mockTurns ).toBe( 0 );
	} );

	it.each( [
		[ 'a reset', ( engine ) => engine.reset() ],
		[ 'a new key', ( engine ) => engine.setGraph( small(), 'k8' ) ],
	] )( 'begun by %s under a drag runs once it drops', ( _name, act ) => {
		const onTick = jest.fn();
		const engine = settled( small(), { onTick, live: true } );
		engine.drag( 'a', 71, 72 );
		onTick.mockClear();
		mockTurns = 0;
		act( engine );
		times( 3, () => poll( engine ) );
		engine.drag( 'a', 2222, 1777 );
		engine.drag( 'b', 2333, 1888 );
		const held = spots( engine );
		expect( held[ 0 ] ).toEqual( [ 'a', 2222, 1777 ] );
		frames( 10 );
		expect( spots( engine ) ).toEqual( held );

		engine.drop();
		expect( engine.runsUnpainted() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		frames( UNTANGLE_TICKS - 1 );
		expect( onTick ).not.toHaveBeenCalled();
		frames( 1 );
		expect( onTick ).toHaveBeenCalledTimes( 1 );
		expect( mockTurns ).toBe( TRADING_TICKS );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
	} );

	it( 'begun under a drag is ended by the drag after it', () => {
		const engine = settled();
		engine.drag( 'a', 71, 72 );
		engine.reset();
		engine.drop();
		frames( 41 );
		engine.drag( 'b', 73, 74 );
		expect( engine.runsUnpainted() ).toBe( false );
	} );

	it( 'begun under a drag waits for area too', () => {
		const engine = settled();
		engine.drag( 'a', 71, 72 );
		engine.setSize( { width: 0, height: 777 } );
		engine.reset();
		engine.drop();
		expect( isRunning( engine ) ).toBe( false );
		mockTurns = 0;
		engine.setSize( { width: 1515, height: 999 } );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'is over from the drag on, before the drop', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		frames( 41 );
		times( 3, () => poll( engine ) );
		engine.drag( 'a', 71, 72 );
		expect( engine.runsUnpainted() ).toBe( false );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
	} );

	it( 'goes on through a poll and a change of class', () => {
		const onTick = jest.fn();
		const engine = make( { onTick, live: true } );
		engine.setGraph( small(), 'k7' );
		frames( 41 );
		poll( engine );
		engine.setGraph(
			{
				...small(),
				nodes: small().nodes.map( ( one ) => ( {
					...one,
					className: 'is-amber',
				} ) ),
			},
			'k7'
		);
		frames( UNTANGLE_TICKS - 42 );
		expect( onTick ).not.toHaveBeenCalled();
	} );

	describe( 'is not had by a graph', () => {
		it( 'with nothing movable, which paints from the first tick', () => {
			const graph = { ...small(), links: [] };
			const onTick = jest.fn();
			const engine = make( { onTick, live: true } );
			engine.setGraph( graph, 'k7' );
			expect( isRunning( engine ) ).toBe( true );
			expect( engine.runsUnpainted() ).toBe( false );
			poll( engine );
			poll( engine );
			expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
			expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.55 );
			frames( 2 );
			expect( engine.ticks() ).toBe( 2 );
			expect( onTick ).toHaveBeenCalledTimes( 2 );
		} );

		it( 'that loses what was movable', () => {
			const onTick = jest.fn();
			const engine = make( { onTick, live: true } );
			const graph = {
				...small(),
				links: [ link( 'a', 'b' ) ],
			};
			engine.setGraph( graph, 'k7' );
			frames( 41 );
			poll( engine );
			engine.setGraph( without( graph, 'b' ), 'k7' );
			expect( engine.runsUnpainted() ).toBe( false );
			expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
			frames( 4 );
			expect( onTick ).toHaveBeenCalledTimes( 4 );
		} );
	} );

	it( 'lets nothing jump on a painted frame', () => {
		const at = () =>
			new Map(
				engine
					.model()
					.leaves.map( ( { id, x, y } ) => [ id, [ x, y ] ] )
			);
		let last = null;
		let farthest = 0;
		const engine = make( {
			live: true,
			onTick: () => {
				const now = at();
				for ( const [ id, [ x, y ] ] of last ?? [] ) {
					const [ nowX, nowY ] = now.get( id );
					farthest = Math.max(
						farthest,
						Math.hypot( nowX - x, nowY - y )
					);
				}
				last = now;
			},
		} );
		engine.setGraph( classGraph(), 'k7' );
		for ( let i = 0; i < 8; i++ ) {
			poll( engine );
			frames( POLL_FRAMES );
		}
		expect( mockTurns ).toBe( TRADING_TICKS );
		expect( farthest ).toBeGreaterThan( 0 );
		expect( farthest ).toBeLessThan( 30 );
	} );
} );

describe( 'on the class graph fixture', () => {
	it( 'the layout ends clear', () => {
		const engine = settled( classGraph() );
		expect( isRunning( engine ) ).toBe( false );
		expectClear( engine.model() );
		const untangled = countCrossings( engine.model().spans );

		mockUntangles = false;
		const tangled = countCrossings( settled( classGraph() ).model().spans );
		expect( untangled * 3 ).toBeLessThan( tangled );
	} );

	it( 'lays out a graph without groups', () => {
		const engine = settled( ungrouped( classGraph() ) );
		expect( isRunning( engine ) ).toBe( false );
		expect( engine.model().branches ).toEqual( [] );
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
		expect( isRunning( engine ) ).toBe( false );
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
		expect( mockTurns ).toBe( TRADING_TICKS );
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
		expect( isRunning( engine ) ).toBe( false );
		poll( engine );
		expect( isRunning( engine ) ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'pulls its lines to the length its new size asks', () => {
		const engine = settled( small(), { live: true } );
		const pull = mockSimulation.force( 'link' );
		const read = jest.spyOn( pull, 'distance' );
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( read ).toHaveBeenCalledWith( expect.any( Function ) );
		const [ first ] = engine.model().pulls;
		expect( pull.distance()( first ) ).toBe(
			30 + first.source.radius + first.target.radius
		);
	} );

	it( 'thaws a frozen layout to make room, keeping the energy kept warm', () => {
		const engine = settled( small(), { live: true } );
		times( 11, () => poll( engine ) );
		expect( mockSimulation.velocityDecay() ).toBe( 1 );
		engine.setKeepWarm( true );
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
	} );

	it( 'keeps the energy a poll holds when it makes room while warm', () => {
		const engine = settled( small(), { live: true } );
		engine.setKeepWarm( true );
		poll( engine );
		const held = mockSimulation.alphaTarget();
		expect( held ).toBeGreaterThan( 0 );
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( mockSimulation.alphaTarget() ).toBe( held );
	} );

	it( 'reheats when it overlaps, ends clear and keeps the steps', () => {
		const engine = settled( small(), { live: true } );
		times( 11, () => poll( engine ) );
		settle( engine );
		mockTurns = 0;
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( overlappingLabels( engine.model() ) ).not.toEqual( [] );
		expect( isRunning( engine ) ).toBe( true );
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
		expect( isRunning( engine ) ).toBe( true );
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
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'leaves an opening layout its untangling when it overlaps', () => {
		const engine = make();
		engine.setGraph( small(), 'k7' );
		frames( 41 );
		engine.setGraph( grown( small(), 'b', { size: 433 } ), 'k7' );
		expect( leaf( engine, 'b' ).halfW ).toBe( 433 );
		expect( overlappingLabels( engine.model() ) ).not.toEqual( [] );
		frames( UNTANGLE_TICKS - 42 );
		expect( engine.runsUnpainted() ).toBe( true );
		frames( 1 );
		expect( engine.runsUnpainted() ).toBe( false );
		expect( engine.ticks() ).toBe( UNTANGLE_TICKS );
	} );

	it( 'reheats beside a removal when it overlaps', () => {
		const engine = settled();
		const graph = without( small(), 'd' );
		engine.setGraph( grown( graph, 'b', { size: 433 } ), 'k7' );
		expect( isRunning( engine ) ).toBe( true );
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
		expect( Math.abs( e.x - c.x ) ).toBeCloseTo( e.halfW + c.halfW, 6 );

		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		settle( engine );
		expect( mockTurns ).toBe( 0 );
	} );

	it( 'moves nothing when a node leaves and comes back', () => {
		const engine = settled();
		const before = spots( engine );

		engine.setGraph( without( small(), 'b' ), 'k7' );
		expect( isRunning( engine ) ).toBe( false );
		frames( 5 );
		engine.setGraph( without( small(), 'd' ), 'k7' );
		expect( isRunning( engine ) ).toBe( false );
		frames( 5 );
		engine.setGraph( small(), 'k7' );
		expect( isRunning( engine ) ).toBe( false );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'moves nothing when any node of nested hulls leaves and returns', () => {
		const engine = settled( twoGroups() );
		const before = spots( engine );
		for ( const { id } of twoGroups().nodes ) {
			engine.setGraph( without( twoGroups(), id ), 'k7' );
			engine.setGraph( twoGroups(), 'k7' );
			expect( isRunning( engine ) ).toBe( false );
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
		for ( const { id, x, y } of spotsOf( engine, 'g' ) ) {
			engine.drag( id, x + 2 * ( h.x - was.x ), y + 2 * ( h.y - was.y ) );
		}
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
		expect( isRunning( engine ) ).toBe( true );
	} );

	it( 'reheats for a link that changes as a node leaves', () => {
		const engine = settled();
		const graph = without( small(), 'd' );
		engine.setGraph(
			{ ...graph, links: [ ...graph.links, link( 'a', 'c' ) ] },
			'k7'
		);
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
	} );

	it( 'forgets a node that left before a reset', () => {
		const engine = settled();
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.reset();
		settle( engine );
		engine.setGraph( small(), 'k7' );
		expect( isRunning( engine ) ).toBe( true );
	} );

	it( 'forgets a node that left under another key', () => {
		const engine = settled();
		engine.setGraph( without( small(), 'b' ), 'k7' );
		engine.setGraph( without( small(), 'b' ), 'k8' );
		settle( engine );
		engine.setGraph( small(), 'k8' );
		expect( isRunning( engine ) ).toBe( true );
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
			'a changed distance',
			( graph ) => ( {
				...graph,
				links: [
					link( 'a', 'b', { distance: 91 } ),
					...graph.links.slice( 1 ),
				],
			} ),
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
		expect( isRunning( engine ) ).toBe( true );
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
			expect( isRunning( engine ) ).toBe( true );
			settle( engine );
			expectClear( engine.model() );
		}
	);

	it( 'draws a pair together when their distance shrinks', () => {
		const [ ab, bc ] = small().links;
		const engine = settled( {
			...small(),
			links: [ { ...ab, distance: 400 }, bc ],
		} );
		const apart = () =>
			Math.hypot(
				leaf( engine, 'a' ).x - leaf( engine, 'b' ).x,
				leaf( engine, 'a' ).y - leaf( engine, 'b' ).y
			);
		const before = apart();
		engine.setGraph(
			{
				...small(),
				links: [ link( 'a', 'b', { distance: 91 } ), bc ],
			},
			'k7'
		);
		settle( engine );
		expect( apart() ).toBeLessThan( before - 100 );
		expectClear( engine.model() );
	} );

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
		expect( isRunning( engine ) ).toBe( false );
		engine.setGraph( { nodes, links: [], groups }, 'k7' );
		expect( isRunning( engine ) ).toBe( false );
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
		expect( mockTurns ).toBe( TRADING_TICKS );
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
		expect( mockTurns ).toBe( 6 );
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
		expect( isRunning( engine ) ).toBe( false );
	} );
} );

describe( 'a docked node', () => {
	const docked = ( dock = true ) =>
		withNode( small(), node( 'lone', { dock } ) );

	it( 'carries no charge, and repels nothing', () => {
		const engine = settled( docked() );
		const strength = mockSimulation.force( 'charge' ).strength();
		expect( strength( leaf( engine, 'lone' ) ) ).toBe( 0 );
	} );

	it( 'stays in its row when dragged', () => {
		const engine = settled( docked() );
		const row = [ leaf( engine, 'lone' ).x, leaf( engine, 'lone' ).y ];
		engine.drag( 'lone', 2222, 1777 );
		engine.drop();
		settle( engine );
		expect( [
			leaf( engine, 'lone' ).x,
			leaf( engine, 'lone' ).y,
		] ).toEqual( row );
	} );

	it( 'is free once its host no longer docks it', () => {
		const engine = settled( docked() );
		engine.setGraph( docked( false ), 'k7' );
		expect( [
			leaf( engine, 'lone' ).fx,
			leaf( engine, 'lone' ).fy,
		] ).toEqual( [ undefined, undefined ] );
	} );

	it( 'settles under every other node', () => {
		const engine = settled(
			withNode( small(), node( 'lone', { dock: true } ) )
		);
		const lone = leaf( engine, 'lone' );
		const lowest = Math.max(
			...engine
				.model()
				.leaves.filter( ( one ) => one !== lone )
				.map( ( { y, halfH } ) => y + halfH )
		);
		expect( lone.y - lone.halfH ).toBeGreaterThan( lowest );
	} );
} );

describe( 'a center node', () => {
	const MIDDLE = [ 656.5, 388.5 ];
	const centered = ( graph ) =>
		withNode( graph, node( 'hub', { center: true } ) );
	const at = ( engine, id = 'hub' ) => {
		const { x, y } = leaf( engine, id );
		return [ x, y ];
	};

	it( 'is at the middle from the first on, and the rest part around it', () => {
		const engine = make();
		engine.setGraph( centered( twoGroups() ), 'k7' );
		expect( at( engine ) ).toEqual( MIDDLE );
		while ( isRunning( engine ) ) {
			frames( 1 );
			expect( at( engine ) ).toEqual( MIDDLE );
		}
		expect( engine.ticks() ).toBe( LAYOUT_TICKS );
		expectClear( engine.model() );
	} );

	it( 'is there in a live graph kept warm', () => {
		const engine = make( { live: true } );
		engine.setKeepWarm( true );
		engine.setGraph( centered( twoGroups() ), 'k7' );
		for ( let i = 0; i < 8; i++ ) {
			poll( engine );
			frames( POLL_FRAMES );
		}
		expect( mockSimulation.alpha() ).toBeGreaterThan( 0.2 );
		expect( at( engine ) ).toEqual( MIDDLE );
	} );

	it( 'is pinned there, and a node joined to nothing does not drift off while kept warm', () => {
		const engine = make( { live: true } );
		engine.setKeepWarm( true );
		engine.setGraph(
			withNode(
				small(),
				node( 'hub', { center: true } ),
				link( 'hub', 'a' ),
				link( 'hub', 'b' ),
				link( 'hub', 'c' )
			),
			'k7'
		);
		const gap = () =>
			Math.hypot(
				...at( engine, 'd' ).map( ( v, i ) => v - MIDDLE[ i ] )
			);
		const gaps = [];
		for ( let i = 0; i < 80; i++ ) {
			poll( engine );
			frames( POLL_FRAMES );
			expect( at( engine ) ).toEqual( MIDDLE );
			expect( [
				leaf( engine, 'hub' ).fx,
				leaf( engine, 'hub' ).fy,
			] ).toEqual( MIDDLE );
			gaps.push( gap() );
		}
		expect( Math.abs( gaps[ 79 ] - gaps[ 59 ] ) ).toBeLessThan( 1 );
	} );

	it( 'thaws a frozen layout for a node added beside it', () => {
		const engine = settled( small(), { live: true } );
		times( 11, () => poll( engine ) );
		expect( mockSimulation.velocityDecay() ).toBe( 1 );
		engine.setGraph(
			withNode( small(), node( 'e' ), link( 'e', 'a' ) ),
			'k7'
		);
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
	} );

	it( 'goes back to the middle after a drag drops on a frozen layout', () => {
		const engine = make( { live: true } );
		engine.setGraph( centered( small() ), 'k7' );
		frames( UNTANGLE_TICKS );
		times( 11, () => poll( engine ) );
		settle( engine );
		expect( mockSimulation.velocityDecay() ).toBe( 1 );
		engine.drag( 'hub', 2222, 1777 );
		engine.drop();
		frames( 2 );
		expect( at( engine ) ).toEqual( MIDDLE );
	} );

	it( 'is there under reduced motion', () => {
		const engine = settled( centered( small() ), { reducedMotion: true } );
		expect( at( engine ) ).toEqual( MIDDLE );
		expectClear( engine.model() );
	} );

	it( 'joins a settled graph there, and the rest make room', () => {
		const engine = settled();
		const before = spots( engine );
		mockTurns = 0;

		engine.setGraph( centered( small() ), 'k7' );
		expect( at( engine ) ).toEqual( MIDDLE );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		settle( engine );
		expect( at( engine ) ).toEqual( MIDDLE );
		expect( spots( engine ).slice( 0, 4 ) ).not.toEqual( before );
		expect( mockTurns ).toBe( 0 );
		expectClear( engine.model() );
	} );

	it( 'moves nothing when it leaves and comes back', () => {
		const engine = settled( centered( small() ) );
		const before = spots( engine );
		engine.setGraph( small(), 'k7' );
		engine.setGraph( centered( small() ), 'k7' );
		expect( isRunning( engine ) ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'comes back to the middle of a canvas resized meanwhile', () => {
		const engine = settled( centered( small() ) );
		engine.setGraph( small(), 'k7' );
		engine.setSize( { width: 1515, height: 999 } );
		engine.setGraph( centered( small() ), 'k7' );
		expect( at( engine ) ).toEqual( [ 757.5, 499.5 ] );
	} );

	it( 'follows a resize of a settled layout, and the rest make room', () => {
		const engine = settled( centered( twoGroups() ) );
		mockTurns = 0;
		engine.setSize( { width: 901, height: 555 } );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		frames( 1 );
		expect( at( engine ) ).toEqual( [ 450.5, 277.5 ] );
		settle( engine );
		expect( mockTurns ).toBe( 0 );
		expect( at( engine ) ).toEqual( [ 450.5, 277.5 ] );
		expectClear( engine.model() );

		const before = spots( engine );
		engine.setGraph( without( centered( twoGroups() ), 'n11' ), 'k7' );
		expect( at( engine ) ).toEqual( [ 450.5, 277.5 ] );
		expect( isRunning( engine ) ).toBe( false );
		engine.setGraph( centered( twoGroups() ), 'k7' );
		expect( spots( engine ) ).toEqual( before );
	} );

	it.each( [
		[ 'width', { width: 901, height: 777 }, [ 450.5, 388.5 ] ],
		[ 'height', { width: 1313, height: 555 }, [ 656.5, 277.5 ] ],
	] )( 'follows a change of %s alone', ( _name, size, middle ) => {
		const engine = settled( centered( small() ) );
		engine.setSize( size );
		expect( isRunning( engine ) ).toBe( true );
		frames( 1 );
		expect( at( engine ) ).toEqual( middle );
	} );

	it( 'is left still by the size the canvas has', () => {
		const engine = settled( centered( small() ) );
		engine.setSize( { width: 0, height: 777 } );
		engine.setSize( { ...SIZE } );
		expect( isRunning( engine ) ).toBe( false );
	} );

	it( 'follows a resize as the graph untangles, which goes on', () => {
		const engine = make();
		engine.setGraph( centered( small() ), 'k7' );
		frames( 7 );
		const alpha = mockSimulation.alpha();
		engine.setSize( { width: 1515, height: 999 } );
		expect( engine.runsUnpainted() ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( alpha );
		frames( 1 );
		expect( at( engine ) ).toEqual( [ 757.5, 499.5 ] );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
	} );

	it( 'waits for a canvas with area', () => {
		const engine = make( { width: 0, height: 0 } );
		engine.setGraph( centered( small() ), 'k7' );
		engine.setSize( { width: 1515, height: 999 } );
		expect( at( engine ) ).toEqual( [ 757.5, 499.5 ] );
		settle( engine );
		expect( at( engine ) ).toEqual( [ 757.5, 499.5 ] );
	} );

	it( 'follows a drag, and goes back as it ends', () => {
		const engine = settled( centered( small() ) );
		engine.drag( 'hub', 2222, 1777 );
		frames( 3 );
		expect( at( engine ) ).toEqual( [ 2222, 1777 ] );
		engine.drop();
		frames( 1 );
		expect( at( engine ) ).toEqual( MIDDLE );
		settle( engine );
		expectClear( engine.model() );
	} );

	it.each( [
		[
			'a new node',
			( engine ) =>
				engine.setGraph(
					withNode( centered( small() ), node( 'e' ) ),
					'k7'
				),
			MIDDLE,
		],
		[
			'a removal',
			( engine ) =>
				engine.setGraph( without( centered( small() ), 'd' ), 'k7' ),
			MIDDLE,
		],
		[
			'a resize',
			( engine ) => engine.setSize( { width: 1515, height: 999 } ),
			[ 757.5, 499.5 ],
		],
	] )( 'stays in hand through %s', ( _name, act, middle ) => {
		const engine = settled( centered( small() ) );
		engine.drag( 'hub', 2222, 1777 );
		act( engine );
		expect( at( engine ) ).toEqual( [ 2222, 1777 ] );
		engine.drag( 'hub', 2233, 1788 );
		expect( at( engine ) ).toEqual( [ 2233, 1788 ] );
		engine.drop();
		frames( 1 );
		expect( at( engine ) ).toEqual( middle );
	} );

	it( 'is placed with the rest by a reset under a drag', () => {
		const engine = settled( centered( small() ) );
		engine.drag( 'hub', 2222, 1777 );
		engine.reset();
		const [ x, y ] = at( engine );
		expect( x ).not.toBe( MIDDLE[ 0 ] );
		expect( y ).not.toBe( MIDDLE[ 1 ] );
		engine.drop();
		frames( 1 );
		expect( at( engine ) ).toEqual( MIDDLE );
	} );

	it( 'is let go once the host centers it no longer', () => {
		const engine = settled( centered( small() ) );
		engine.setGraph( withNode( small(), node( 'hub' ) ), 'k7' );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		engine.drag( 'hub', 2222, 1777 );
		engine.drop();
		frames( 1 );
		// The layout recentres as a whole; the middle no longer holds it.
		expect( at( engine )[ 0 ] ).toBeGreaterThan( MIDDLE[ 0 ] + 1000 );

		settle( engine );
		engine.setGraph( centered( small() ), 'k7' );
		expect( at( engine ) ).toEqual( MIDDLE );
		expect( isRunning( engine ) ).toBe( true );
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
		expect( isRunning( engine ) ).toBe( false );
		expect( mockTurns ).toBe( 8 );
	} );

	it( 'pins nothing afterwards', () => {
		const engine = settled();
		engine.drag( 'a', 4222, 3777 );
		engine.drop();
		expect( isRunning( engine ) ).toBe( true );
		settle( engine );
		expect( leaf( engine, 'a' ).x ).toBeLessThan( 4000 );
	} );

	it( 'of many nodes moves each, and no others', () => {
		const engine = make();
		engine.setGraph( classGraph(), 'k7' );
		frames( 7 );
		const expected = new Map(
			spots( engine ).map( ( [ id, x, y ] ) => [ id, [ x, y ] ] )
		);
		for ( const { id, x, y } of spotsOf( engine, 'beta' ) ) {
			engine.drag( id, x + 41, y - 29 );
			expected.set( id, [ x + 41, y - 29 ] );
		}
		expect(
			new Map(
				spots( engine ).map( ( [ id, x, y ] ) => [ id, [ x, y ] ] )
			)
		).toEqual( expected );
		engine.drop();
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		mockTurns = 0;
		settle( engine );
		expect( mockTurns ).toBe( 0 );
		expectClear( engine.model() );
	} );

	it( 'of what the graph does not hold does nothing', () => {
		const engine = settled( twoGroups() );
		const before = spots( engine );
		engine.drag( 'gone', 5, 6 );
		engine.drag( 'group:g', 5, 6 );
		engine.drop();
		expect( isRunning( engine ) ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
	} );

	it( 'is not a drop by itself', () => {
		const engine = settled();
		engine.drop();
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( fixed ) ).toBe( false );
		expect( charges( fixed ) ).toEqual( [
			CHARGE,
			CHARGE,
			CHARGE,
			CHARGE,
		] );
	} );

	it( 'charge a leaf as its node asks while the layout is not live', () => {
		const [ a, ...rest ] = small().nodes;
		const own = { ...small(), nodes: [ { ...a, charge: -4100 }, ...rest ] };
		expect( charges( settled( own ) ) ).toEqual( [
			-4100,
			CHARGE,
			CHARGE,
			CHARGE,
		] );

		const live = settled( own, { live: true } );
		poll( live, ( i ) => 10 ** i - 1 );
		expect( charges( live ) ).toEqual( [ 0, 9, 99, 999 ].map( chargeOf ) );
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

	it( 'raise the energy of an untangled layout', () => {
		const engine = afterUntangling( small(), { live: true } );
		frames( 11 );
		const cooled = mockSimulation.alpha();
		expect( cooled ).toBeLessThan( 0.003 );

		poll( engine );
		expect( isRunning( engine ) ).toBe( true );
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
		expect( mockTurns ).toBe( TRADING_TICKS );
		expect( isRunning( engine ) ).toBe( true );
	} );

	it( 'step down, let go on the tenth steady poll and then only charge', () => {
		const engine = afterUntangling( small(), { live: true } );
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
			[ 0, 1 ],
		] );
		expect( isRunning( engine ) ).toBe( true );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		settle( engine );

		const still = spots( engine );
		poll( engine, () => 61 );
		expect( charges( engine )[ 2 ] ).toBe( chargeOf( 61 ) );
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( engine ) ).toBe( true );
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
		expect( isRunning( engine ) ).toBe( true );
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
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		engine.reset();
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		frames( UNTANGLE_TICKS );
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
		frames( UNTANGLE_TICKS );
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
		expect( isRunning( engine ) ).toBe( false );

		engine.setKeepWarm( true );
		expect( isRunning( engine ) ).toBe( false );
		const still = spots( engine );
		times( 3, () => poll( engine ) );
		expect( isRunning( engine ) ).toBe( true );
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

	it( 'hold the energy for ten seconds, and then let it lapse', () => {
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		poll( engine );
		pass( 4000 );
		poll( engine );
		pass( 9960 );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
		expect( mockSimulation.velocityDecay() ).toBeCloseTo( 0.6 );
		pass( 60 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
		expect( mockSimulation.velocityDecay() ).toBe( 0.5 );
		expect( isRunning( engine ) ).toBe( true );
		settle( engine );
		expect( isRunning( engine ) ).toBe( false );
		expectClear( engine.model() );

		poll( engine );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.35 );
		times( 6, () => poll( engine ) );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.1 );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it.each( [ 8, 20, 50 ] )(
		'hold it for twice the gap of the last two, at a frame in %d ms',
		( frame ) => {
			const engine = afterUntangling( small(), { live: true } );
			poll( engine );
			pass( 3000, frame );
			poll( engine );
			pass( 7000, frame );
			poll( engine );
			pass( 13900, frame );
			expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.4 );
			pass( 200, frame );
			expect( mockSimulation.alphaTarget() ).toBe( 0 );
		}
	);

	it( 'keep a warm layout from cooling between slow polls', () => {
		const engine = afterUntangling( small(), { live: true } );
		engine.setKeepWarm( true );
		poll( engine );
		pass( 8000 );
		poll( engine );
		times( 3, () => {
			pass( 15900 );
			expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
			poll( engine );
		} );
	} );

	it( 'are counted in the gap though the layout was let go', () => {
		const engine = afterUntangling( small(), { live: true } );
		times( 11, () => poll( engine ) );
		settle( engine );
		pass( 60000, 1000 );
		poll( engine );
		expect( isRunning( engine ) ).toBe( false );
		pass( 2000 );
		engine.setGraph( without( small(), 'd' ), 'k7' );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		pass( 10060 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'begin their gaps anew when the graph is live again', () => {
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		engine.setLive( false );
		pass( 60000, 1000 );
		engine.setLive( true );
		poll( engine );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		pass( 10060 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'are not held longer by a drag, a resize or a class', () => {
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		pass( 6000 );
		engine.drag( 'a', 71, 72 );
		engine.drop();
		engine.setSize( { width: 1414, height: 888 } );
		engine.setGraph( withNode( small(), node( 'e' ) ), 'k7' );
		pass( 3900 );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		pass( 200 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'lapse once, and not at all in a layout they do not drive', () => {
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		const alphaTarget = jest.spyOn( mockSimulation, 'alphaTarget' );
		pass( 24000 );
		expect( isRunning( engine ) ).toBe( true );
		expect( alphaTarget.mock.calls ).toEqual( [ [ 0 ] ] );

		const undriven = make();
		undriven.setGraph( { ...small(), links: [] }, 'k7' );
		const asked = jest.spyOn( mockSimulation, 'alphaTarget' );
		pass( 16000 );
		expect( isRunning( undriven ) ).toBe( true );
		expect( asked ).not.toHaveBeenCalled();
	} );

	it( 'lapse while kept warm too', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		times( 4, () => poll( engine ) );
		engine.setKeepWarm( true );
		poll( engine );
		settle( engine );
		expect( isRunning( engine ) ).toBe( false );
		poll( engine );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.35 );
	} );

	it( 'do not stir an empty graph', () => {
		const engine = make( { live: true } );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		poll( engine );
		expect( isRunning( engine ) ).toBe( false );
	} );
} );

describe.each( [
	[ 'paused', 'setPaused', false ],
	[ 'hidden', 'setHidden', false ],
	[ 'held by a gesture', 'setHeld', true ],
] )( 'while %s', ( _name, method, isUnpainted ) => {
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
		expect( isRunning( engine ) ).toBe( false );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );

		poll( engine );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
	} );

	it( 'the time is not counted in what a poll holds, or in a gap', () => {
		const engine = afterUntangling( small(), { live: true } );
		poll( engine );
		pass( 3000 );
		engine[ method ]( true );
		pass( 30000, 1000 );
		engine[ method ]( true );
		pass( 30000, 1000 );
		engine[ method ]( false );
		pass( 6900 );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		engine[ method ]( true );
		pass( 60000, 1000 );
		engine[ method ]( false );
		poll( engine );
		pass( 19700 );
		expect( mockSimulation.alphaTarget() ).toBeCloseTo( 0.45 );
		pass( 200 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'nor is it in what is held as the untangling ends then', () => {
		const engine = make( { live: true } );
		engine.setGraph( small(), 'k7' );
		poll( engine );
		frames( 9 );
		engine[ method ]( true );
		pass( 60000, 1000 );
		engine.drag( 'a', 71, 72 );
		engine.drop();
		engine[ method ]( false );
		pass( 9960 );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		pass( 60 );
		expect( mockSimulation.alphaTarget() ).toBe( 0 );
	} );

	it( 'an unfinished layout waits, and goes on when it ends', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine.setGraph( small(), 'k7' );
		frames( 17 );
		expect( engine.runsUnpainted() ).toBe( true );
		engine[ method ]( true );
		const before = spots( engine );
		frames( 20 );
		expect( spots( engine ) ).toEqual( before );
		expect( isRunning( engine ) ).toBe( false );
		expect( engine.runsUnpainted() ).toBe( isUnpainted );

		engine[ method ]( false );
		expect( isRunning( engine ) ).toBe( true );
		expect( engine.runsUnpainted() ).toBe( true );
		frames( UNTANGLE_TICKS - 18 );
		expect( onTick ).not.toHaveBeenCalled();
		frames( 1 );
		expect( onTick ).toHaveBeenCalledTimes( 1 );
		expect( engine.runsUnpainted() ).toBe( false );
		settle( engine );
		expect( isRunning( engine ) ).toBe( false );
		expect( mockTurns ).toBe( TRADING_TICKS );
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
		expect( isRunning( engine ) ).toBe( false );
		engine[ method ]( false );
		expect( isRunning( engine ) ).toBe( true );
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
		expect( isRunning( engine ) ).toBe( false );
		expect( onTick ).not.toHaveBeenCalled();
		expectFinite( engine );

		engine.setSize( SIZE );
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.5 );
		expect( spots( engine ) ).toEqual( start );
		frames( 1 );
		poll( engine );
		frames( UNTANGLE_TICKS );
		expect( mockSimulation.alphaTarget() ).toBe( 0.5 );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
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
		expect( isRunning( engine ) ).toBe( false );
		expect( spots( engine ) ).toEqual( before );
		engine.setSize( { width: 1414, height: 888 } );
		expect( isRunning( engine ) ).toBe( true );
		settle( engine );
		expect( mockTurns ).toBe( TRADING_TICKS );
		engine.setSize( { width: 1515, height: 999 } );
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( engine ) ).toBe( true );
		expect( mockSimulation.alpha() ).toBe( 0.1 );
		expect( spots( engine ) ).toEqual( before );
		frames( 1 );
		expect( spots( engine ) ).not.toEqual( before );
		settle( engine );
		expect( mockTurns ).toBe( 0 );

		engine.setLive( false );
		expect( charges( engine ) ).toEqual( Array( 4 ).fill( CHARGE ) );
		expect( isRunning( engine ) ).toBe( true );
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
			expect( mockTurns ).toBe( TRADING_TICKS );
		}
	);

	it( 'moves the leaves by their new charge, an idle one weaker than the still one', () => {
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
		expect( isRunning( engine ) ).toBe( false );
	} );

	it( 'leaves an opening layout waiting for area still', () => {
		const engine = make( { width: 0, height: 0 } );
		engine.setGraph( small(), 'k7' );
		engine.setLive( true );
		expect( isRunning( engine ) ).toBe( false );
		engine.setSize( { width: 1515, height: 999 } );
		expect( isRunning( engine ) ).toBe( true );
		expect( charges( engine )[ 1 ] ).toBe( chargeOf( 0 ) );
	} );
} );

describe( 'reduced motion', () => {
	it( 'lays out in slices and paints once, at the end', () => {
		stepClock( 5 );
		const onTick = jest.fn( () =>
			expect( isRunning( engine ) ).toBe( false )
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
		const { tick } = mockSimulation;
		const ticks = jest
			.spyOn( mockSimulation, 'tick' )
			.mockImplementation( () => {
				clock += 5;
				return tick();
			} );
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
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( engine ) ).toBe( false );
		expectFinite( engine );
	} );

	it( 'answers an empty model before the first graph', () => {
		const engine = make();
		expect( engine.model().leaves ).toEqual( [] );
		engine.reset();
		expect( isRunning( engine ) ).toBe( false );
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
		expect( isRunning( engine ) ).toBe( false );
		engine.drop();
		expect( isRunning( engine ) ).toBe( true );
	} );

	it( 'leaves a still layout still until it ends', () => {
		const engine = settled();
		engine.drag( 'a', 71, 72 );
		expect( isRunning( engine ) ).toBe( false );
		engine.drop();
		expect( isRunning( engine ) ).toBe( true );
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
		frames( UNTANGLE_TICKS + 2 );
		engine.setGraph( { nodes: [], links: [], groups: [] }, 'k7' );
		expect( isRunning( engine ) ).toBe( false );
		frames( 3 );
		expect( onTick ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'fires once a frame past the untangling, the last one still', () => {
		const ran = [];
		const engine = make( {
			onTick: () => ran.push( isRunning( engine ) ),
		} );
		engine.setGraph( small(), 'k7' );
		settle( engine );
		frames( 20 );
		expect( ran ).toHaveLength( PAINTED_TICKS );
		expect( ran[ PAINTED_TICKS - 2 ] ).toBe( true );
		expect( ran[ PAINTED_TICKS - 1 ] ).toBe( false );
	} );
} );

describe( 'destroy', () => {
	it( 'stops the timer', () => {
		const onTick = jest.fn();
		const engine = make( { onTick } );
		engine.setGraph( small(), 'k7' );
		frames( UNTANGLE_TICKS + 7 );
		expect( isRunning( engine ) ).toBe( true );
		engine.destroy();
		expect( isRunning( engine ) ).toBe( false );
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
