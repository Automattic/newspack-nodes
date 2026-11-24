/**
 * The force graph's keys. Each acts while the canvas has focus or the pointer
 * is over it, but for those that another control or the page may want: Escape
 * and an arrow's move of the selection want focus, and Space wants it once
 * anything in the document has it.
 */

import { isTypingTarget } from '../utils/isTypingTarget';
import { ARROWS, nearestInDirection } from '../utils/keyboardNav';
import { KEY_ZOOM } from '../utils/wheelGesture';

/** Pixels an arrow pans. */
const PAN_STEP = 80;

/** @typedef {import('./ForceGraph').Stage} Stage */
/** @typedef {import('./ForceGraph').ForceGraphProps} ForceGraphProps */

/**
 * What the keys do to the view and the layout.
 *
 * @typedef {Object} KeyMoves
 * @property {function(number, number): void} pan         Move the view by pixels.
 * @property {function(number): void}         zoomBy      Zoom about the middle of the canvas.
 * @property {function(): void}               refit       Fit the view, and keep it fitted.
 * @property {function(): boolean}            isOver      Whether the pointer is over the canvas.
 * @property {function(): void}               togglePause Pause the layout, or let it go on.
 */

/**
 * Listen for the keys of a force graph's svg.
 *
 * @param {SVGSVGElement}              svg      The svg.
 * @param {{current: Stage}}           stageRef The stage the svg shows.
 * @param {{current: ForceGraphProps}} hostRef  The host's latest props.
 * @param {KeyMoves}                   moves    What the keys do.
 * @return {function(): void} Stops listening.
 */
export const bindKeys = (
	svg,
	stageRef,
	hostRef,
	{ pan, zoomBy, refit, isOver, togglePause }
) => {
	const doc = svg.ownerDocument;

	/**
	 * Move the selection the way an arrow points, among the nodes as painted,
	 * or with none pan that way.
	 *
	 * @param {[number, number]} dir     The arrow.
	 * @param {boolean}          focused Whether the canvas has focus.
	 */
	const arrow = ( dir, focused ) => {
		const { drawing, engine } = stageRef.current;
		const { byId } = engine.model();
		const boxes = drawing
			.boxes()
			.filter( ( { id } ) => 'leaf' === byId.get( id )?.type );
		const { selectedId, onSelect } = hostRef.current;
		const selected =
			focused && boxes.find( ( { id } ) => id === selectedId );
		if ( ! selected ) {
			pan( -dir[ 0 ] * PAN_STEP, -dir[ 1 ] * PAN_STEP );
			return;
		}
		const next = nearestInDirection( boxes, selected, dir );
		if ( next ) {
			onSelect?.( next.id );
		}
	};

	const isLive = () => hostRef.current.live;
	const hasSelection = () => {
		const { selectedId, selectedLink, selectedGroup } = hostRef.current;
		return null !== ( selectedId ?? selectedLink ?? selectedGroup ?? null );
	};

	// What each key does, and when the canvas takes it from the page.
	const acts = {
		Escape: {
			when: ( focused ) => focused && hasSelection(),
			run: () => hostRef.current.onDeselect?.(),
		},
		0: { when: () => true, run: refit },
		r: { when: () => true, run: () => stageRef.current.reset() },
		' ': {
			when: ( focused ) =>
				isLive() && ( focused || doc.body === doc.activeElement ),
			run: togglePause,
		},
		k: { when: isLive, run: () => hostRef.current.onKeepWarm?.() },
	};

	const onKey = ( e ) => {
		const focused = svg === doc.activeElement;
		if (
			! ( focused || isOver() ) ||
			e.defaultPrevented ||
			e.altKey ||
			e.ctrlKey ||
			e.metaKey ||
			isTypingTarget( e.target )
		) {
			return;
		}
		if ( ARROWS[ e.key ] ) {
			arrow( ARROWS[ e.key ], focused );
		} else if ( KEY_ZOOM[ e.key ] ) {
			zoomBy( 1 / KEY_ZOOM[ e.key ] );
		} else if ( acts[ e.key ]?.when( focused ) ) {
			if ( ! e.repeat ) {
				acts[ e.key ].run();
			}
		} else {
			return;
		}
		e.preventDefault();
	};

	doc.addEventListener( 'keydown', onKey );
	return () => doc.removeEventListener( 'keydown', onKey );
};
