/**
 * The force graph's engine: it owns the model and the d3 simulation that
 * moves it.
 *
 * A layout moves while it cools, and while rate polls hold its energy; after
 * that it is still. The simulation's own timer never runs. One d3 timer, a
 * call an animation frame, ticks it while it is not still and nothing holds
 * it: a pause, a hidden canvas, a gesture or a drag.
 *
 * A full layout begins with its untangling, which runs unpainted because a
 * trade jumps: slices of ticks a frame, cooling by its own decay whatever
 * polls ask. What the polls asked last takes hold as it ends.
 */

import {
	forceLink,
	forceManyBody,
	forceSimulation,
	randomLcg,
	timer,
} from 'd3';
import {
	CHARGE,
	chargeOf,
	forceClamp,
	forceCohesion,
	forceSiblings,
	placeNodes,
	updateBoxes,
} from './forces';
import { carry, compare, crowds, refresh } from './follow';
import { buildModel } from './model';
import { createUntangler } from './untangle';

/** Ticks a full layout untangles for: alpha 0.5 to 0.003. */
const UNTANGLE_TICKS = 680;

/** Ticks of the untangling from one that trades to the next. */
const UNTANGLE_EVERY = 4;

/** Alpha of a full layout and of a drop, and the energy of a first poll. */
const ALPHA = 0.5;

/** Alpha a changed graph reheats to. */
const REHEAT_ALPHA = 0.1;

/** Share of its distance to its target that alpha covers each tick. */
const ALPHA_DECAY = 0.0075;

/** Share of its speed a leaf loses each tick: the friction. */
const VELOCITY_DECAY = 0.5;

/** Pixels a link without a distance of its own pulls its ends to. */
const LINK_DISTANCE = 250;

/** Share of its error a link corrects each tick, per alpha. */
const LINK_STRENGTH = 1;

/** Steady polls that let a live layout go. */
const STEADY_POLLS = 10;

/** Energy a steady poll takes, and friction it adds. */
const POLL_STEP = 0.05;

/** Ticks past the untangling a poll's energy holds without another poll. */
const HOLD_TICKS = 600;

/** Least energy a poll sets before the layout is let go. */
const MIN_ENERGY = 0.1;

/** Seed of the jiggle that parts bodies at one x or y, so a reset repeats. */
const SEED = 1;

/** Milliseconds of ticks in a frame that is not painted. */
const SLICE_MS = 12;

/** @typedef {import('./model').Model} Model */

/**
 * @typedef {Object} HostGraph
 * @property {import('./model').HostNode[]}  nodes  Host nodes.
 * @property {import('./model').HostLink[]}  links  Host links.
 * @property {import('./model').HostGroup[]} groups Host groups.
 */

/**
 * @typedef {Object} Engine
 * @property {function(HostGraph, (string|undefined)): void}   setGraph      Take the host's graph.
 * @property {function(Map<string, number>): void}             setRates      Take a poll's rates by node id; a node it leaves out has none.
 * @property {function(): void}                                reset         Lay the graph out from scratch.
 * @property {function(string, number, number): void}          drag          Put a node at a point and hold the layout.
 * @property {function(): void}                                drop          End a drag and reheat.
 * @property {function({width: number, height: number}): void} setSize       Take the canvas's size.
 * @property {function(boolean): void}                         setPaused     Hold the layout, or let it go on.
 * @property {function(boolean): void}                         setHeld       Hold the layout for a gesture, or let it go on.
 * @property {function(boolean): void}                         setLive       Let rates charge and move the layout, or the fixed charge alone.
 * @property {function(boolean): void}                         setKeepWarm   Hold a live layout's energy and friction, or let polls step them.
 * @property {function(boolean): void}                         setHidden     Hold the layout of a canvas no one sees.
 * @property {function(): Model}                               model         The model, replaced when its shape changes.
 * @property {function(): boolean}                             running       Whether the layout ticks, or will once a gesture or a drag ends: it is neither still, paused nor hidden.
 * @property {function(): boolean}                             runsUnpainted Whether the layout runs and the frame that ends it, or its untangling, is the next one painted.
 * @property {function(): number}                              ticks         Ticks the layout has run, painted or not.
 * @property {function(): void}                                destroy       Stop for good.
 */

/**
 * Whether a canvas has area to lay a graph out in.
 *
 * @param {{width: number, height: number}} size Canvas size.
 * @return {boolean} True when neither side is zero.
 */
const hasArea = ( { width, height } ) => width > 0 && height > 0;

/**
 * Make an engine. It starts still, with an empty model.
 *
 * `onTick` is for motion: the host paints what its own call placed, unless
 * the layout then runs unpainted, and `onTick` paints each frame after it. An
 * untangling runs unpainted until `onTick` paints where it ended, and under
 * reduced motion a layout runs unpainted until `onTick` paints where it
 * stopped. The layout is already still at the last call.
 *
 * A center node stands at the centre of the canvas, and a resize moves it
 * there. A drag takes it along, and the first tick after the drop puts it back.
 *
 * A full layout waits, still, for a canvas with area. Rates charge the leaves
 * of a live engine alone; the leaves of any other carry the fixed charge, and
 * rates do nothing. An engine starts out of live.
 *
 * @param {Object}           options
 * @param {number}           options.width           Canvas width.
 * @param {number}           options.height          Canvas height.
 * @param {function(): void} options.onTick          Paints a frame of motion.
 * @param {boolean}          [options.reducedMotion] Whether motion goes unpainted.
 * @return {Engine} The engine.
 */
export const createEngine = ( {
	width,
	height,
	onTick,
	reducedMotion = false,
} ) => {
	// The last size with area, which a canvas without any leaves in place.
	let size = { width, height };
	let sized = hasArea( size );
	// Whether a full layout waits for a canvas with area.
	let pending = false;
	let model = buildModel( { nodes: [], links: [], groups: [] } );
	let still = true;
	/** @type {string|undefined} */
	let key;
	/** @type {Map<string, {x: number, y: number}>} */
	const seen = new Map();
	let ticks = 0;
	// Null for a model that is not untangled, which has no such ticks.
	/** @type {?function(): void} */
	let untangle = null;
	let untangleTicks = 0;

	/** @type {Map<string, number>} */
	let rates = new Map();
	// Steps the polls have taken, and whether the next poll starts them over.
	let steadyPolls = 0;
	let startOver = true;
	let live = false;
	let keepWarm = false;
	let holdTicks = 0;
	// What the polls last asked of the layout.
	let energy = 0;
	let friction = VELOCITY_DECAY;

	let paused = false;
	let hidden = false;
	let held = false;
	let dragging = false;
	let destroyed = false;

	const simulation = forceSimulation()
		.stop()
		.alphaDecay( ALPHA_DECAY )
		.velocityDecay( VELOCITY_DECAY );
	const charge = forceManyBody();

	const running = () => ! ( still || paused || hidden || destroyed );

	const runsUnpainted = () =>
		running() && ( reducedMotion || untangleTicks > 0 );

	/**
	 * Take an energy and a friction: at once, or as the untangling ends.
	 *
	 * @param {number} nextEnergy   The alpha to settle at.
	 * @param {number} nextFriction The friction.
	 */
	const ask = ( nextEnergy, nextFriction ) => {
		energy = nextEnergy;
		friction = nextFriction;
		if ( ! untangleTicks ) {
			simulation.alphaTarget( energy ).velocityDecay( friction );
		}
	};

	/** Let the layout cool, at the friction of one no poll drives. */
	const release = () => ask( 0, VELOCITY_DECAY );

	/** End the untangling, if one is under way. */
	const endUntangling = () => {
		untangleTicks = 0;
		ask( energy, friction );
	};

	const tick = () => {
		ticks++;
		simulation.tick();
		if ( untangleTicks > 1 ) {
			untangleTicks--;
		} else if ( untangleTicks ) {
			endUntangling();
		} else if ( 0 === --holdTicks ) {
			release();
		}
		if ( simulation.alpha() < simulation.alphaMin() ) {
			still = true;
		}
	};

	/** Run a tick, or while the layout runs unpainted a slice of them. */
	const frame = () => {
		const until = performance.now() + SLICE_MS;
		do {
			tick();
		} while ( runsUnpainted() && performance.now() < until );
		run();
		if ( ! runsUnpainted() ) {
			onTick();
		}
	};

	const stepper = timer( frame );
	stepper.stop();

	/** Start or stop the timer, as the layout runs and is held. */
	const run = () => {
		if ( running() && ! held && ! dragging ) {
			stepper.restart( frame );
		} else {
			stepper.stop();
		}
	};

	/**
	 * Set the layout moving; an empty graph, or one that waits for area, is
	 * still.
	 */
	const start = () => {
		still = pending || ! model.leaves.length;
		run();
	};

	/**
	 * Raise alpha to at least this.
	 *
	 * @param {number} alpha The alpha.
	 */
	const raise = ( alpha ) =>
		simulation.alpha( Math.max( simulation.alpha(), alpha ) );

	/**
	 * Raise alpha and cool from it, without untangling.
	 *
	 * @param {number} alpha The alpha.
	 */
	const reheat = ( alpha ) => {
		endUntangling();
		raise( alpha );
		start();
	};

	/** The leaves the host centers. */
	const centered = () => model.leaves.filter( ( { node } ) => node.center );

	/**
	 * Fix the center leaves at the centre of the canvas, unless a drag has the
	 * layout; a tick puts them there.
	 *
	 * @return {boolean} Whether any was fixed elsewhere, or nowhere.
	 */
	const fixCenter = () => {
		if ( dragging ) {
			return false;
		}
		const [ fx, fy ] = [ size.width / 2, size.height / 2 ];
		const strays = centered().filter(
			( leaf ) => leaf.fx !== fx || leaf.fy !== fy
		);
		strays.forEach( ( leaf ) => Object.assign( leaf, { fx, fy } ) );
		return strays.length > 0;
	};

	const applyCharge = () =>
		charge.strength( ( { id } ) =>
			live ? chargeOf( rates.get( id ) ?? 0 ) : CHARGE
		);

	/**
	 * Build the model's forces. The untangler's is first, so the rest push from
	 * where it leaves the bodies, and the boxes are fitted before what reads
	 * them. A model that is not untangled ends the untangling of the one before.
	 */
	const engage = () => {
		untangle = createUntangler( model );
		if ( ! untangle ) {
			endUntangling();
		}
		const pull = forceLink( model.pulls )
			.distance( ( { link } ) => link.distance ?? LINK_DISTANCE )
			.strength( LINK_STRENGTH );
		fixCenter();
		simulation
			.nodes( model.leaves )
			.randomSource( randomLcg( SEED ) )
			.force( 'untangle', () => {
				if ( untangleTicks && 0 === untangleTicks % UNTANGLE_EVERY ) {
					untangle();
				}
			} )
			.force( 'link', pull )
			.force( 'boxes', () => updateBoxes( model ) )
			.force( 'cohesion', forceCohesion( model, size ) )
			.force( 'siblings', forceSiblings( model ) )
			.force( 'charge', charge )
			.force( 'clamp', forceClamp( model ) );
		applyCharge();
	};
	engage();

	/** Place the model and lay it out in full, once the canvas has area. */
	const layOut = () => {
		seen.clear();
		startOver = true;
		pending = ! sized;
		if ( sized ) {
			placeNodes( model, size );
		}
		engage();
		release();
		untangleTicks = untangle ? UNTANGLE_TICKS : 0;
		simulation.alpha( ALPHA );
		start();
	};

	/**
	 * Take a model of another shape, keeping the picture.
	 *
	 * @param {Model}   next          The model.
	 * @param {boolean} sameSurvivors Whether what stays is as it was.
	 */
	const follow = ( next, sameSurvivors ) => {
		const { added, unsettled } = carry( model, next, seen, size );
		model = next;
		engage();
		if ( added || ! sameSurvivors || crowds( unsettled, model ) ) {
			reheat( REHEAT_ALPHA );
		} else {
			still ||= ! model.leaves.length;
			run();
		}
	};

	/** Hand the layout to a drag, the center leaves with it. */
	const hold = () => {
		if ( ! dragging ) {
			dragging = true;
			centered().forEach( ( leaf ) =>
				Object.assign( leaf, { fx: null, fy: null } )
			);
		}
		endUntangling();
		run();
	};

	return {
		setGraph: ( graph, layoutKey ) => {
			const next = buildModel( graph );
			const { same, sameSurvivors } = compare( model, next );
			startOver ||= ! same;
			if ( layoutKey !== key || ! model.leaves.length ) {
				key = layoutKey;
				model = next;
				layOut();
			} else if ( ! same ) {
				follow( next, sameSurvivors );
			} else if ( crowds( refresh( model, next ), model ) ) {
				reheat( REHEAT_ALPHA );
			}
		},

		setRates: ( next ) => {
			if ( ! live ) {
				return;
			}
			rates = next;
			applyCharge();
			if ( reducedMotion || paused || hidden || held ) {
				return;
			}
			if ( startOver ) {
				startOver = false;
				steadyPolls = 0;
			} else if ( STEADY_POLLS === steadyPolls ) {
				return;
			} else if ( ! keepWarm ) {
				steadyPolls++;
			}
			if ( STEADY_POLLS === steadyPolls ) {
				release();
			} else {
				const taken = POLL_STEP * steadyPolls;
				holdTicks = HOLD_TICKS;
				ask(
					Math.max( MIN_ENERGY, ALPHA - taken ),
					VELOCITY_DECAY + taken
				);
			}
			start();
		},

		reset: layOut,

		drag: ( id, x, y ) => {
			const body = model.byId.get( id );
			if ( 'leaf' === body?.type ) {
				body.x = x;
				body.y = y;
				hold();
			}
		},

		drop: () => {
			if ( dragging ) {
				dragging = false;
				fixCenter();
				reheat( ALPHA );
			}
		},

		setSize: ( next ) => {
			sized = hasArea( next );
			if ( ! sized ) {
				return;
			}
			size = next;
			const strayed = fixCenter();
			simulation.force( 'cohesion', forceCohesion( model, size ) );
			if ( pending ) {
				layOut();
			} else if ( strayed && ! untangleTicks ) {
				reheat( REHEAT_ALPHA );
			}
		},

		setPaused: ( next ) => {
			paused = next;
			run();
		},

		setHeld: ( next ) => {
			held = next;
			run();
		},

		setLive: ( next ) => {
			if ( next === live ) {
				return;
			}
			live = next;
			release();
			applyCharge();
			raise( REHEAT_ALPHA );
			start();
		},

		setKeepWarm: ( next ) => {
			keepWarm = next;
			startOver ||= keepWarm && STEADY_POLLS === steadyPolls;
		},

		setHidden: ( next ) => {
			hidden = next;
			run();
		},

		model: () => model,
		running,
		runsUnpainted,
		ticks: () => ticks,

		destroy: () => {
			destroyed = true;
			run();
		},
	};
};
