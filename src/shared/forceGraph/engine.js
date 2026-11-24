/**
 * The force graph's engine: it owns the model and the d3 simulation that
 * moves it.
 *
 * A layout moves while it cools, and while rate polls hold its energy; after
 * that it is still. The simulation's own timer never runs. One d3 timer, a
 * call an animation frame, ticks it while it is not still and nothing holds
 * it: a pause, a hidden canvas, a gesture or a drag.
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

/** Ticks at the start of a full layout that untangle: alpha 0.5 to 0.003. */
const UNTANGLE_TICKS = 680;

/** Alpha of a full layout and of a drop, and the energy of a first poll. */
const ALPHA = 0.5;

/** Alpha a changed graph reheats to. */
const REHEAT_ALPHA = 0.1;

/** Share of its distance to its target that alpha covers each tick. */
const ALPHA_DECAY = 0.0075;

/** Share of its speed a leaf loses each tick: the friction. */
const VELOCITY_DECAY = 0.5;

/** Pixels a link pulls its ends to. */
const LINK_DISTANCE = 250;

/** Share of its error a link corrects each tick, per alpha. */
const LINK_STRENGTH = 1;

/** Steady polls that let a live layout go. */
const STEADY_POLLS = 10;

/** Energy a steady poll takes, and friction it adds. */
const POLL_STEP = 0.05;

/** Ticks a poll's energy holds without another poll. */
const HOLD_TICKS = 600;

/** Least energy a poll sets before the layout is let go. */
const MIN_ENERGY = 0.1;

/** Seed of the jiggle that parts bodies at one x or y, so a reset repeats. */
const SEED = 1;

/** Milliseconds of ticks in a frame under reduced motion. */
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
 * @property {function(HostGraph, (string|undefined)): void}   setGraph    Take the host's graph.
 * @property {function(Map<string, number>): void}             setRates    Take a poll's rates by node id; a node it leaves out has none.
 * @property {function(): void}                                reset       Lay the graph out from scratch.
 * @property {function(string, number, number): void}          drag        Put a node at a point and hold the layout.
 * @property {function(string, number, number): void}          dragGroup   Move a group's nodes by an offset and hold the layout.
 * @property {function(): void}                                drop        End a drag and reheat.
 * @property {function({width: number, height: number}): void} setSize     Take the canvas's size.
 * @property {function(boolean): void}                         setPaused   Hold the layout, or let it go on.
 * @property {function(boolean): void}                         setHeld     Hold the layout for a gesture, or let it go on.
 * @property {function(boolean): void}                         setLive     Let rates charge and move the layout, or the fixed charge alone.
 * @property {function(boolean): void}                         setKeepWarm Hold a live layout's energy and friction, or let polls step them.
 * @property {function(boolean): void}                         setHidden   Hold the layout of a canvas no one sees.
 * @property {function(): Model}                               model       The model, replaced when its shape changes.
 * @property {function(): boolean}                             running     Whether the layout ticks, or will once a gesture or a drag ends: it is neither still, paused nor hidden.
 * @property {function(): number}                              ticks       Ticks the layout has run, painted or not.
 * @property {function(): void}                                destroy     Stop for good.
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
 * `onTick` is for motion: the host paints what its own call placed, which is
 * a graph, a reset or a drag, and `onTick` paints each frame after it. Under
 * reduced motion a layout runs unpainted and `onTick` is called once, when it
 * stops. The layout is already still at the last call.
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
	let untangleTicks = 0;

	/** @type {Map<string, number>} */
	let rates = new Map();
	// Steps the polls have taken, and whether the next poll starts them over.
	let steadyPolls = 0;
	let startOver = true;
	let live = false;
	let keepWarm = false;
	let holdTicks = 0;

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

	/** Let the layout cool, at the friction of one no poll drives. */
	const release = () =>
		simulation.alphaTarget( 0 ).velocityDecay( VELOCITY_DECAY );

	const tick = () => {
		ticks++;
		simulation.tick();
		if ( 0 === --holdTicks ) {
			release();
		}
		if ( simulation.alpha() < simulation.alphaMin() ) {
			still = true;
		}
	};

	const slice = () => {
		const until = performance.now() + SLICE_MS;
		do {
			tick();
		} while ( ! still && performance.now() < until );
	};

	const frame = () => {
		( reducedMotion ? slice : tick )();
		run();
		if ( ! reducedMotion || still ) {
			onTick();
		}
	};

	const stepper = timer( frame );
	stepper.stop();

	const running = () => ! ( still || paused || hidden || destroyed );

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
		untangleTicks = 0;
		raise( alpha );
		start();
	};

	const applyCharge = () =>
		charge.strength( ( { id } ) =>
			live ? chargeOf( rates.get( id ) ?? 0 ) : CHARGE
		);

	/**
	 * Build the model's forces. The untangler's is first, so the rest push from
	 * where it leaves the bodies, and the boxes are fitted before what reads them.
	 */
	const engage = () => {
		const untangle = createUntangler( model );
		const pull = forceLink( model.pulls )
			.distance( LINK_DISTANCE )
			.strength( LINK_STRENGTH );
		simulation
			.nodes( model.leaves )
			.randomSource( randomLcg( SEED ) )
			.force( 'untangle', () => {
				if ( untangleTicks > 0 ) {
					untangleTicks--;
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
		untangleTicks = UNTANGLE_TICKS;
		simulation.alpha( ALPHA );
		release();
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

	const hold = () => {
		dragging = true;
		untangleTicks = 0;
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
				simulation
					.alphaTarget( Math.max( MIN_ENERGY, ALPHA - taken ) )
					.velocityDecay( VELOCITY_DECAY + taken );
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

		dragGroup: ( id, dx, dy ) => {
			const branch = model.branches.find( ( b ) => id === b.group.id );
			if ( branch ) {
				for ( const leaf of branch.leafNodes ) {
					leaf.x += dx;
					leaf.y += dy;
				}
				hold();
			}
		},

		drop: () => {
			if ( dragging ) {
				dragging = false;
				reheat( ALPHA );
			}
		},

		setSize: ( next ) => {
			sized = hasArea( next );
			if ( ! sized ) {
				return;
			}
			size = next;
			simulation.force( 'cohesion', forceCohesion( model, size ) );
			if ( pending ) {
				layOut();
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
		ticks: () => ticks,

		destroy: () => {
			destroyed = true;
			run();
		},
	};
};
