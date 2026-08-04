/**
 * LayoutContext — where the canvas is looking, and where nodes sit.
 *
 * `positionOverrides`, `onPositionChange`, `viewport` and `onViewportChange`
 * were threaded TopologyConsole → ConsoleShell → GraphView → SchematicCanvas.
 * GraphView declares all four and reads none, which is the same test the
 * catalogs passed and most of the chrome props failed.
 *
 * Layout is not document state: it is already keyed per cwd by `scopeFromCwd`,
 * so it survives Stage 2 untouched and a draft gets its own scope for free.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

const LayoutContext = createContext( null );

// Module-level so an omitted value keeps ONE identity across renders.
const NO_POSITIONS = Object.freeze( {} );
const NOOP = () => {};

/**
 * @param {Object}   props                     Component props.
 * @param {Object}   [props.positionOverrides] node id → { x, y }.
 * @param {Function} [props.onPositionChange]  Commit a moved node.
 * @param {?Object}  [props.viewport]          Controlled viewport, or null for
 *                                             uncontrolled — NOT "no viewport".
 * @param {Function} [props.onViewportChange]  Commit a pan/zoom.
 * @param {*}        props.children            Consumers.
 * @return {Element} The provider.
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
 * @return {Object} `{ positionOverrides, onPositionChange, viewport, onViewportChange }`.
 */
export function useLayoutContext() {
	const value = useContext( LayoutContext );
	if ( ! value ) {
		// Loud: an empty layout reads as a graph with every node at the origin.
		throw new Error( 'useLayoutContext called outside a LayoutProvider' );
	}
	return value;
}
