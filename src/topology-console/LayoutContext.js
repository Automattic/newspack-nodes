/**
 * LayoutContext — where the canvas is looking and where its nodes sit,
 * provided once per mount instead of threaded down through GraphView.
 *
 * `SchematicCanvas` is the only reader of the four values; GraphView and
 * ConsoleShell sit between it and the provider and touch none of them. Both
 * graph-surface mounts provide it — the topology console and the debug
 * overlay's inspector tab.
 *
 * Layout is browser state rather than part of the draft document, which is why
 * it lives here instead of in DraftContext. `useCanvasLayout` owns the map, its
 * per-scope storage key and its persistence; this context only publishes what
 * the canvas draws.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

/**
 * Where one node card sits, in world (viewBox) units.
 *
 * @typedef {{x:number,y:number}} Position
 */

/**
 * The canvas viewBox: origin, width and height, all in world units.
 *
 * @typedef {{x:number,y:number,w:number,h:number}} ViewBox
 */

/**
 * A viewBox stored as its offset from autofit — the pan in world units, the
 * zoom as a ratio to the autofit scale — which is what `deltaFromAutofit`
 * produces and what survives a canvas resize.
 *
 * @typedef {{dcx:number,dcy:number,zoom:number}} ViewportDelta
 */

// Null default: that is how the hook spots an unwrapped consumer.
const LayoutContext = createContext( null );

// Module-level so an omitted value keeps ONE identity across renders.
const NO_POSITIONS = Object.freeze( {} );
const NOOP = () => {};

/**
 * Publishes the layout to the graph surface, memoized on the four values so a
 * consumer re-renders only when one of them moves.
 *
 * @param {Object}                                        props                     Component props.
 * @param {Record<string,Position>}                       [props.positionOverrides] Node id to its position. The canvas draws only the nodes it finds here, so the map has to be complete. Defaults to empty.
 * @param {(id: string, pos: Position) => void}           [props.onPositionChange]  Commits one node's new position: a card drag calls it on release, a hull drag once per node it moved.
 * @param {?ViewBox}                                      [props.viewport]          Controlled viewBox, or null to leave the canvas autofitting. Null is "uncontrolled", not "no viewport".
 * @param {(vp: ?ViewBox, delta: ?ViewportDelta) => void} [props.onViewportChange]  Commits a pan or zoom together with its offset from the current autofit, which is the form the layout is stored in.
 * @param {*}                                             props.children            Consumers.
 * @return {import('react').ReactElement} The provider.
 */
export function LayoutProvider( {
	positionOverrides = NO_POSITIONS,
	onPositionChange = NOOP,
	viewport = null,
	onViewportChange = NOOP,
	children,
} ) {
	const value = useMemo(
		() => ( {
			positionOverrides,
			onPositionChange,
			viewport,
			onViewportChange,
		} ),
		[ positionOverrides, onPositionChange, viewport, onViewportChange ]
	);
	return (
		<LayoutContext.Provider value={ value }>
			{ children }
		</LayoutContext.Provider>
	);
}

/**
 * Reads the canvas layout. Throws outside a provider rather than falling back
 * to an empty map, because the canvas draws only the nodes it has a position
 * for: the fallback renders a graph with no cards on it and names nothing.
 *
 * @return {Object} `{ positionOverrides, onPositionChange, viewport, onViewportChange }`.
 */
export function useLayoutContext() {
	const value = useContext( LayoutContext );
	if ( ! value ) {
		throw new Error( 'useLayoutContext called outside a LayoutProvider' );
	}
	return value;
}
