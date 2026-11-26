/**
 * ForceGraph — nodes, lines and nested hulls on one svg, laid out by force.
 *
 * React renders the svg and nothing under it. d3 joins keyed by id draw the
 * rest, so a node keeps its element through every change of the data, and
 * each frame of motion writes positions alone. While the layout runs unpainted
 * the svg is busy, and while nothing is painted yet either it is a skeleton.
 *
 * The host colors nodes, lines and hulls through the classes it hands them,
 * which may change on every poll without moving anything. What is selected or
 * hovered comes back as a class, as does a rate above zero. The host decides
 * what a line's rate is.
 */

import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from '@wordpress/element';
import { classes } from '../components/Modal';
import { useContainerRefit } from '../hooks/useContainerRefit';
import { BLOCK, createDrawing } from './drawing';
import { createEngine } from './engine';
import { useGestures } from './useGestures';
import './ForceGraph.scss';

/** A graph's groups when its host has none. */
const NO_GROUPS = [];

/**
 * A node: a labelled rect, or with a `size` a circle of that radius, or wide
 * enough for its detail where that is wider, its label above it and its detail
 * in it.
 *
 * @typedef {Object} GraphNode
 * @property {string}   id        Unique among nodes.
 * @property {string}   label     Its text.
 * @property {?string=} group     Id of the group holding it.
 * @property {string=}  className The host's classes.
 * @property {number=}  size      Least circle radius.
 * @property {number=}  scale     What its label is drawn at, box and text; 1 without one.
 * @property {boolean=} center    Whether the layout holds it at the centre of the canvas.
 * @property {number=}  charge    What it carries while not live, negative to repel; -1000 without one.
 * @property {boolean=} landmark  Whether its label shows at every scale, at one size on screen times its `scale`.
 * @property {boolean=} dock      Whether the layout pins it in a row under the rest, unless it is centred or grouped.
 * @property {string=}  detail    Text in the circle.
 * @property {number=}  rate      Messages a second; above zero it is live.
 * @property {string=}  title     Native tooltip.
 */

/**
 * @typedef {Object} GraphLink
 * @property {string}   id        Unique among links.
 * @property {string}   source    Id of a node.
 * @property {string}   target    Id of a node.
 * @property {string=}  className The host's classes.
 * @property {number=}  weight    What its base width is drawn from.
 * @property {number=}  rate      Messages a second; with one it lights and fades.
 * @property {string=}  title     Native tooltip.
 * @property {boolean=} directed  Whether it ends in an arrowhead.
 * @property {boolean=} curved    Whether it is drawn as an arc, as d3_visualizer.html draws a target.
 * @property {boolean=} pressable False lets a press through to what is beneath.
 * @property {number=}  distance  Pixels it pulls its ends to; without one, 30 between their edges while live and 250 between their centres while not.
 * @property {number=}  strength  Share of its error it corrects each tick, per alpha; 1 over its less joined end's lines without one.
 * @property {boolean=} loose     Whether it is drawn alone, taking no part in the layout.
 * @property {boolean=} tangle    False for one that pulls, but whose crossings the untangling never counts.
 */

/**
 * @typedef {Object} GraphGroup
 * @property {string}   id        Unique among groups.
 * @property {string}   label     Its text.
 * @property {?string=} parent    Id of the enclosing group.
 * @property {string=}  className The host's classes, worn by its hull.
 */

/**
 * @typedef {Object} ForceGraphProps
 * @property {GraphNode[]}               nodes           The nodes.
 * @property {GraphLink[]}               links           The lines; one whose end is not a node is not drawn.
 * @property {GraphGroup[]}              [groups]        The groups, a tree by `parent`.
 * @property {string}                    [layoutKey]     Lays the graph out in full when it changes.
 * @property {unknown}                   [pollKey]       With `live`, hands the rates of `nodes` to the layout when it changes.
 * @property {?string}                   [selectedId]    Id of the selected node.
 * @property {?string}                   [selectedLink]  Id of the selected line.
 * @property {?string}                   [selectedGroup] Id of the selected group.
 * @property {?string}                   [hoveredId]     Id of the hovered node.
 * @property {function(string): void}    [onSelect]      Takes a pressed node's id, or an arrow's.
 * @property {function(GraphLink): void} [onSelectLink]  Takes a pressed line; without it lines take no press.
 * @property {function(string): void}    [onSelectGroup] Takes a pressed hull's group id.
 * @property {function(?string): void}   [onHover]       Takes the id of the node the pointer is over, or null.
 * @property {function(?string): void}   [onHoverGroup]  Takes the group id of the hull the pointer is over, or null, as on a node or a line that takes a press.
 * @property {function(): void}          [onDeselect]    Runs on a press of the canvas and on Escape; a press of the canvas fits the view unless something is selected and this clears it.
 * @property {boolean}                   [live]          Whether rates move the layout, and Space and `k` act.
 * @property {boolean}                   [keepWarm]      Whether a live layout holds its energy.
 * @property {function(): void}          [onKeepWarm]    Runs on `k`.
 * @property {string}                    [ariaLabel]     The canvas's name.
 * @property {string}                    [className]     The host's class on the svg.
 * @property {number}                    [bottomInset]   Pixels the host covers at the canvas's foot, which a fit keeps the graph above.
 * @property {{current: ?SVGSVGElement}} [svgRef]        Takes the svg, for a host that asks whether an event landed on it.
 */

/**
 * What the svg shows, and the engine that moves it.
 *
 * @typedef {Object} Stage
 * @property {import('./engine').Engine}        engine    The engine.
 * @property {ReturnType<typeof createDrawing>} drawing   The drawing.
 * @property {{width: number, height: number}}  size      The last box with area.
 * @property {number}                           inset     Pixels the host covers at the canvas's foot.
 * @property {boolean}                          shown     Whether the box has area.
 * @property {unknown}                          polled    The last poll key handed over.
 * @property {function(): boolean}              unpainted Whether the model is ahead of what is painted.
 * @property {function(): void}                 paint     Paint the positions, and first whatever is not yet drawn.
 * @property {function(): void}                 show      Draw the model: at once, or once the layout no longer runs unpainted.
 * @property {function(): void}                 reset     Lay the graph out from scratch.
 */

/** The poll key of a stage no poll has reached. */
const UNPOLLED = {};

/**
 * Whether the reader asked for less motion.
 *
 * @return {boolean} True when layouts run unpainted.
 */
const prefersReducedMotion = () =>
	window.matchMedia?.( '(prefers-reduced-motion: reduce)' )?.matches;

/**
 * The graph. `nodes`, `links`, `groups` and `pollKey` are compared by
 * identity, so a host hands over a new array only with new data. A new
 * `nodes` is not a poll: its classes may follow a hover.
 *
 * @param {ForceGraphProps} props Component props.
 * @return {import('react').ReactElement} The svg.
 */
export function ForceGraph( props ) {
	const {
		nodes,
		links,
		groups = NO_GROUPS,
		layoutKey,
		pollKey,
		selectedId,
		selectedLink,
		selectedGroup,
		hoveredId,
		onSelect,
		onSelectLink,
		live = false,
		keepWarm = false,
		ariaLabel,
		className,
		bottomInset = 0,
		svgRef: hostSvgRef,
	} = props;
	const svgRef = useRef( /** @type {SVGSVGElement} */ ( null ) );
	// The svg's own ref, mirrored into the host's when it passes one.
	const attachSvg = useCallback(
		( el ) => {
			svgRef.current = el;
			if ( hostSvgRef ) {
				hostSvgRef.current = el;
			}
		},
		[ hostSvgRef ]
	);
	const stageRef = useRef( /** @type {Stage} */ ( null ) );
	const [ { isBusy, isBlank }, setWait ] = useState( {
		isBusy: false,
		isBlank: false,
	} );
	const hostRef = useRef( props );
	hostRef.current = props;
	const arrowId = `${ BLOCK }-arrow-${ useId() }`;
	const gestures = useGestures( svgRef, stageRef, hostRef );

	useEffect( () => {
		const drawing = createDrawing( svgRef.current, arrowId );
		// Whether the model holds what the drawing lacks.
		let behind = false;
		// The engine's ticks at the last paint.
		let painted = 0;

		const place = () => {
			painted = engine.ticks();
			drawing.place();
			gestures.current.follow();
		};
		const draw = () => {
			behind = false;
			drawing.join( engine.model(), hostRef.current );
			place();
			gestures.current.prune();
		};
		const paint = () => ( behind ? draw : place )();

		const engine = createEngine( {
			width: 0,
			height: 0,
			onTick: paint,
			onUnpainted: ( unpainted ) =>
				setWait( {
					isBusy: unpainted,
					isBlank: unpainted && drawing.isEmpty(),
				} ),
			reducedMotion: prefersReducedMotion(),
		} );
		const stage = {
			engine,
			drawing,
			size: { width: 0, height: 0 },
			inset: 0,
			shown: false,
			polled: UNPOLLED,
			unpainted: () => behind || engine.ticks() !== painted,
			paint,
			show: () => {
				behind = true;
				if ( stage.shown && ! engine.runsUnpainted() ) {
					draw();
				}
			},
			reset: () => {
				engine.reset();
				stage.show();
			},
		};
		stageRef.current = stage;
		return () => {
			engine.destroy();
			drawing.clear();
		};
	}, [ arrowId, gestures ] );

	const measure = () => {
		const el = svgRef.current;
		if ( ! el ) {
			return;
		}
		const { clientWidth: width, clientHeight: height } = el;
		const stage = stageRef.current;
		const shown = width > 0 && height > 0;
		const gained = shown && ! stage.shown;
		stage.shown = shown;
		stage.engine.setHidden( ! shown );
		stage.engine.setSize( { width, height } );
		if ( shown ) {
			stage.size = { width, height };
		}
		if ( gained ) {
			stage.show();
			gestures.current.refit();
		} else {
			gestures.current.follow();
		}
	};
	useEffect( measure, [ gestures ] );

	useEffect( () => {
		stageRef.current.inset = bottomInset;
		gestures.current.follow();
	}, [ gestures, bottomInset ] );
	useContainerRefit( svgRef, measure, [], 0 );

	useEffect( () => {
		stageRef.current.engine.setLive( live );
		if ( ! live ) {
			gestures.current.resume();
		}
	}, [ gestures, live ] );

	useEffect( () => {
		stageRef.current.engine.setKeepWarm( keepWarm );
	}, [ keepWarm ] );

	useEffect( () => {
		const { engine, show } = stageRef.current;
		engine.setGraph( { nodes, links, groups }, layoutKey );
		show();
		gestures.current.prune();
	}, [ gestures, nodes, links, groups, layoutKey ] );

	useEffect( () => {
		const stage = stageRef.current;
		if ( live && pollKey !== stage.polled ) {
			stage.polled = pollKey;
			stage.engine.setRates(
				new Map(
					hostRef.current.nodes.flatMap( ( { id, rate } ) =>
						rate > 0 ? [ [ id, rate ] ] : []
					)
				)
			);
		}
	}, [ live, pollKey ] );

	const nodesPress = !! onSelect;
	useEffect( () => {
		stageRef.current.drawing.dressNodes( hostRef.current );
	}, [ selectedId, hoveredId, nodesPress ] );
	const linksPress = !! onSelectLink;
	useEffect( () => {
		stageRef.current.drawing.dressLinks( hostRef.current );
	}, [ selectedLink, linksPress ] );
	useEffect( () => {
		stageRef.current.drawing.dressHulls( hostRef.current );
	}, [ selectedGroup ] );

	return (
		<svg
			ref={ attachSvg }
			className={ classes( BLOCK, isBlank && 'is-blank', className ) }
			aria-busy={ isBusy }
			tabIndex={ 0 }
			role="application"
			aria-label={ ariaLabel }
		/>
	);
}
