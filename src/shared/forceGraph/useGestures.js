/**
 * The force graph's gestures: what a press, a drag, a wheel and a pinch do to
 * its view, its layout and its host. `keys.js` holds the keys.
 *
 * One listener of each kind on the svg reads what it landed on from the
 * element's datum, and finds that in the engine's model, which may be ahead
 * of the drawing. d3's drag moves a body by mouse or touch. d3's zoom holds
 * the view: it answers a mouse or a touch on the canvas itself, and a wheel, a
 * key and a gesture event move it by steps here.
 *
 * A drag, a zoom by pointer and a run of steps, which ends after a pause, may
 * overlap. While any of them lasts the layout and the fit are held.
 */

import { useEffect, useRef } from '@wordpress/element';
import { drag, pointer, select, zoom, zoomTransform } from 'd3';
import {
	ZOOM_STEP,
	createWheelStream,
	wheelNotches,
} from '../utils/wheelGesture';
import { BLOCK } from './drawing';
import { TEXT_ZOOM, ZOOM_RANGE, fitOf } from './fit';
import { bindKeys } from './keys';

/** Pixels of travel a press may make before it is a drag. */
const PRESS_SLACK = 2;

/** Pixels of travel that take the view out of its fit. */
const FIT_SLACK = 5;

/** Milliseconds without a step that end a run of them. */
const STEP_GAP_MS = 150;

/** The part a line that takes no press is. */
const MUTE_LINK = 'link:not(.is-pressable)';

/** @typedef {import('./model').Body} Body */
/** @typedef {import('./ForceGraph').GraphLink} GraphLink */
/** @typedef {import('./ForceGraph').Stage} Stage */
/** @typedef {import('./ForceGraph').ForceGraphProps} ForceGraphProps */

/**
 * @typedef {Object} Gestures
 * @property {function(): void} follow Fit the view, unless the reader left the fit or a gesture is under way.
 * @property {function(): void} refit  Fit the view, and keep it fitted, at the end of any drag or zoom under way.
 * @property {function(): void} resume Take back the pause of the reader.
 * @property {function(): void} prune  Let go of what the model or the document no longer holds.
 * @property {function(): void} unbind Stop listening, for good.
 */

/** @typedef {'drag'|'zoom'|'steps'} Holder */

/**
 * The part of the graph an event landed on.
 *
 * @param {EventTarget} target What the event landed on, within the svg.
 * @param {...string}   parts  The parts to look for.
 * @return {?Element} The part's element, or null.
 */
const partAt = ( target, ...parts ) =>
	/** @type {Element} */ ( target ).closest(
		parts.map( ( part ) => `.${ BLOCK }__${ part }` ).join()
	);

/**
 * The element a touch event goes to for as long as the touch lasts. The
 * events of a mouse go to the window.
 *
 * @param {Event} e The event a gesture starts with.
 * @return {?Element} The element, or null for a mouse.
 */
const touchedBy = ( { type, target } ) =>
	type.startsWith( 'touch' ) ? /** @type {Element} */ ( target ) : null;

/**
 * The id of the node a body is.
 *
 * @param {?Body} body A body, or null.
 * @return {?string} The id, or null for a hull and for none.
 */
const nodeOf = ( body ) => ( 'leaf' === body?.type ? body.id : null );

/**
 * The id of the group a body is the hull of.
 *
 * @param {?Body} body A body, or null.
 * @return {?string} The id, or null for a node and for none.
 */
const groupOf = ( body ) => ( 'branch' === body?.type ? body.group.id : null );

/**
 * Listen on an svg. Nothing here reads the stage before an event does.
 *
 * @param {SVGSVGElement}              svg      The svg.
 * @param {{current: Stage}}           stageRef The stage the svg shows.
 * @param {{current: ForceGraphProps}} hostRef  The host's latest props.
 * @return {Gestures} The gestures.
 */
const bindGestures = ( svg, stageRef, hostRef ) => {
	const root = select( svg );
	const verdict = createWheelStream();

	let fitting = true;
	let paused = false;
	// What holds the layout and the fit.
	/** @type {Set<Holder>} */
	const holders = new Set();
	// The element under each finger the zoom has had, until it lifts.
	/** @type {Map<number, Element>} */
	const fingers = new Map();
	// The view the first of them began at.
	let from = null;
	// The pause that ends a run of steps.
	let gap;
	// What the pointer is over, and what it has hold of.
	let over = false;
	/** @type {?Body} */
	let hovered = null;
	let grab = null;
	// The scale of a pinch by gesture event, at its last step.
	let pinched = 1;

	const modelOf = () => stageRef.current.engine.model();

	/**
	 * The model's body for one painted or pressed.
	 *
	 * @param {Body} body A body of any model the stage has had.
	 * @return {Body|undefined} The body, or undefined when the model has none.
	 */
	const bodyOf = ( { type, id } ) => {
		const { leaves, branches } = modelOf();
		const bodies = /** @type {Body[]} */ (
			'leaf' === type ? leaves : branches
		);
		return bodies.find( ( body ) => id === body.id );
	};

	/**
	 * The body an event landed on.
	 *
	 * @param {EventTarget} target What the event landed on.
	 * @return {?Body} The body, or null off any in the model.
	 */
	const bodyAt = ( target ) => {
		const el = partAt( target, 'node', 'hull' );
		return ( el && bodyOf( select( el ).datum() ) ) ?? null;
	};

	const follow = () => {
		const { size, inset, unpainted } = stageRef.current;
		const { leaves } = modelOf();
		if ( fitting && ! from && leaves.length && ! unpainted() ) {
			root.call( zooming.transform, fitOf( leaves, size, inset ) );
		}
	};

	/**
	 * Hold the layout and the fit.
	 *
	 * @param {Holder} who What holds them.
	 */
	const hold = ( who ) => {
		if ( ! holders.size ) {
			from = zoomTransform( svg );
			stageRef.current.engine.setHeld( true );
		}
		holders.add( who );
	};

	/**
	 * Let the layout and the fit go on, when the last to hold them lets go.
	 *
	 * @param {Holder} who What held them.
	 */
	const letGo = ( who ) => {
		holders.delete( who );
		if ( ! holders.size ) {
			from = null;
			stageRef.current.engine.setHeld( false );
			follow();
		}
	};

	const endSteps = () => {
		clearTimeout( gap );
		letGo( 'steps' );
	};

	const step = ( move ) => {
		clearTimeout( gap );
		hold( 'steps' );
		move();
		gap = setTimeout( endSteps, STEP_GAP_MS );
	};

	const zooming = zoom()
		.scaleExtent( ZOOM_RANGE )
		.extent( () => {
			const { width, height } = stageRef.current.size;
			return [
				[ 0, 0 ],
				[ width, height ],
			];
		} )
		.filter( ( e ) => ! grab && ! e.ctrlKey && ! e.button )
		.clickDistance( PRESS_SLACK )
		.on( 'start', ( { sourceEvent } ) => sourceEvent && hold( 'zoom' ) )
		.on( 'zoom', ( { transform: to } ) => {
			stageRef.current.drawing.view
				.attr( 'transform', to )
				.classed( 'is-far', to.k < TEXT_ZOOM );
			if (
				from &&
				! stageRef.current.drawing.isEmpty() &&
				( to.k !== from.k ||
					Math.hypot( to.x - from.x, to.y - from.y ) >= FIT_SLACK )
			) {
				fitting = false;
			}
		} )
		.on( 'end', ( { sourceEvent } ) => sourceEvent && letGo( 'zoom' ) );

	const pan = ( dx, dy ) =>
		step( () => {
			const { k } = zoomTransform( svg );
			zooming.translateBy( root, dx / k, dy / k );
		} );

	/**
	 * Zoom about a point of the canvas.
	 *
	 * @param {number}           factor What to multiply the scale by.
	 * @param {[number, number]} [at]   The point; the middle without one.
	 */
	const zoomBy = ( factor, at ) =>
		step( () => zooming.scaleBy( root, factor, at ) );

	const refit = () => {
		fitting = true;
		endSteps();
	};

	/** @param {?Body} body What the pointer is over, or null. */
	const hover = ( body ) => {
		const was = hovered;
		hovered = body;
		const { onHover, onHoverGroup } = hostRef.current;
		if ( nodeOf( body ) !== nodeOf( was ) ) {
			onHover?.( nodeOf( body ) );
		}
		if ( groupOf( body ) !== groupOf( was ) ) {
			onHoverGroup?.( groupOf( body ) );
		}
	};

	const press = ( body ) =>
		'leaf' === body.type
			? hostRef.current.onSelect?.( body.id )
			: hostRef.current.onSelectGroup?.( body.group.id );

	/**
	 * Where the painted nodes stand, while the model is ahead of them.
	 *
	 * @return {Map<string, number[]>} Places by node id; empty when it is not.
	 */
	const painted = () => {
		const { drawing, unpainted } = stageRef.current;
		return new Map(
			( unpainted() ? drawing.boxes() : [] ).map(
				( { id, x, y, w, h } ) => [ id, [ x + w / 2, y + h / 2 ] ]
			)
		);
	};

	/**
	 * Move a body from where it is painted, and hold the layout.
	 *
	 * @param {Body}   body A body the model has.
	 * @param {number} dx   How far, in the graph's own units.
	 * @param {number} dy   How far.
	 */
	const shift = ( body, dx, dy ) => {
		const places = painted();
		for ( const leaf of bodyOf( body ).leafNodes ) {
			const [ x, y ] = places.get( leaf.id ) ?? [ leaf.x, leaf.y ];
			stageRef.current.engine.drag( leaf.id, x + dx, y + dy );
		}
	};

	/** Let go of the body, so the layout parts what its move crowded. */
	const release = () => {
		grab = null;
		stageRef.current.engine.drop();
		letGo( 'drag' );
	};

	const dragging = drag()
		.container( svg )
		.subject( ( { sourceEvent, x, y } ) => {
			const body = grab ? null : bodyAt( sourceEvent.target );
			return body && { body, x, y };
		} )
		.on( 'start', ( { subject, x, y, sourceEvent } ) => {
			grab = {
				body: subject.body,
				start: [ x, y ],
				at: zoomTransform( svg ).invert( [ x, y ] ),
				moved: false,
				touched: touchedBy( sourceEvent ),
			};
			hold( 'drag' );
		} )
		.on( 'drag', ( { x, y } ) => {
			if ( ! grab ) {
				return;
			}
			const [ x0, y0 ] = grab.start;
			grab.moved ||= Math.hypot( x - x0, y - y0 ) > PRESS_SLACK;
			if ( grab.moved ) {
				const { body, at } = grab;
				grab.at = zoomTransform( svg ).invert( [ x, y ] );
				shift( body, grab.at[ 0 ] - at[ 0 ], grab.at[ 1 ] - at[ 1 ] );
				stageRef.current.paint();
			}
		} )
		.on( 'end', ( { sourceEvent } ) => {
			if ( ! grab ) {
				return;
			}
			const { body, moved } = grab;
			release();
			if ( ! moved && 'touchcancel' !== sourceEvent.type ) {
				press( body );
			}
		} );

	/**
	 * End a zoom whose every finger went down on an element the document no
	 * longer holds, where the end of a touch goes unheard.
	 */
	const endLostZoom = () => {
		const elements = [ ...fingers.values() ];
		if (
			elements.length &&
			! elements.some( ( { isConnected } ) => isConnected )
		) {
			fingers.clear();
			letGo( 'zoom' );
		}
	};

	const onTouchStart = ( { changedTouches } ) => {
		for ( const { identifier, target } of changedTouches ) {
			fingers.set( identifier, target );
		}
	};

	const onTouchEnd = ( { changedTouches } ) => {
		for ( const { identifier } of changedTouches ) {
			fingers.delete( identifier );
		}
		endLostZoom();
	};

	const prune = () => {
		if (
			grab &&
			( false === grab.touched?.isConnected || ! bodyOf( grab.body ) )
		) {
			release();
		}
		endLostZoom();
		if ( hovered && ! bodyOf( hovered ) ) {
			hover( null );
		}
	};

	const onWheel = ( e ) => {
		e.preventDefault();
		if ( 'pan' === verdict( e ) ) {
			pan( -e.deltaX, -e.deltaY );
		} else {
			zoomBy( ZOOM_STEP ** -wheelNotches( e ), pointer( e, svg ) );
		}
	};

	/**
	 * The hull painted beneath a line that takes no press.
	 *
	 * @param {MouseEvent} e What landed there.
	 * @return {?Body} The hull, or null over the canvas and off any such line.
	 */
	const hullBeneath = ( e ) => {
		if ( ! partAt( e.target, MUTE_LINK ) ) {
			return null;
		}
		const at = zoomTransform( svg ).invert( pointer( e, svg ) );
		const hull = stageRef.current.drawing.hullAt( at );
		return ( hull && bodyOf( hull ) ) ?? null;
	};

	const onClick = ( e ) => {
		const { target } = e;
		if ( partAt( target, 'node', 'hull' ) ) {
			return;
		}
		const { onSelectLink, onDeselect } = hostRef.current;
		const el = onSelectLink && partAt( target, 'link.is-pressable', 'hit' );
		if ( ! el ) {
			const hull = hullBeneath( e );
			if ( hull ) {
				press( hull );
			} else {
				onDeselect?.();
				refit();
			}
			return;
		}
		const { id } = select( el ).datum().link;
		const links = modelOf().links.map(
			( { link } ) => /** @type {GraphLink} */ ( link )
		);
		const link = links.find( ( one ) => id === one.id );
		if ( link ) {
			onSelectLink( link );
		}
	};

	// Desktop Safari pinches by gesture event; d3 reads a screen's touches.
	const onPinch = ( e ) => {
		if ( window.navigator.maxTouchPoints ) {
			return;
		}
		e.preventDefault();
		if ( 'gesturechange' === e.type ) {
			zoomBy( e.scale / pinched, pointer( e, svg ) );
		}
		pinched = e.scale;
	};

	const pause = ( next ) => {
		paused = next;
		stageRef.current.engine.setPaused( paused );
		if ( paused ) {
			stageRef.current.show();
		}
	};

	const unbindKeys = bindKeys( svg, stageRef, hostRef, {
		pan,
		zoomBy,
		refit,
		isOver: () => over,
		togglePause: () => pause( ! paused ),
	} );

	// In this order: the drag, then the zoom, stop what they take.
	root.call( dragging )
		.on( 'touchstart.graph', onTouchStart )
		.on( 'touchend.graph touchcancel.graph', onTouchEnd )
		.call( zooming )
		.on( 'wheel.zoom', null )
		.on( 'dblclick.zoom', null )
		.on( 'wheel.graph', onWheel, { passive: false } )
		.on( 'gesturestart.graph gesturechange.graph', onPinch, {
			passive: false,
		} )
		.on( 'click.graph', onClick )
		.on( 'pointerdown.graph', () =>
			svg.focus( { preventScroll: true, focusVisible: false } )
		)
		.on( 'pointerover.graph', ( e ) => {
			over = true;
			hover( bodyAt( e.target ) ?? hullBeneath( e ) );
		} )
		// A line is one element over every hull it crosses.
		.on( 'pointermove.graph', ( e ) => {
			if ( partAt( e.target, MUTE_LINK ) ) {
				hover( hullBeneath( e ) );
			}
		} )
		.on( 'pointerleave.graph', () => {
			over = false;
			hover( null );
		} );

	return {
		follow,
		refit,
		resume: () => pause( false ),
		prune,
		unbind: () => {
			clearTimeout( gap );
			grab = null;
			zooming.on( 'start zoom end', null );
			unbindKeys();
		},
	};
};

/**
 * Bind the gestures of a force graph's svg.
 *
 * @param {{current: SVGSVGElement}}   svgRef   The svg.
 * @param {{current: Stage}}           stageRef The stage the svg shows.
 * @param {{current: ForceGraphProps}} hostRef  The host's latest props.
 * @return {{current: Gestures}} The gestures.
 */
export function useGestures( svgRef, stageRef, hostRef ) {
	const gesturesRef = useRef( /** @type {Gestures} */ ( null ) );
	useEffect( () => {
		const gestures = bindGestures( svgRef.current, stageRef, hostRef );
		gesturesRef.current = gestures;
		return gestures.unbind;
	}, [ svgRef, stageRef, hostRef ] );
	return gesturesRef;
}
