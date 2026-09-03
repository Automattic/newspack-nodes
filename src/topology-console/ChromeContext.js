/**
 * ChromeContext — the panel chrome the canvas surface reacts to, provided once
 * per mount instead of threaded down through GraphView.
 *
 * It carries the three values GraphView never reads: the palette's collapse
 * state and its toggle, which `Palette` consumes, and the height of the REPL
 * transcript overlay, which `SchematicCanvas` reserves while it autofits. Both
 * graph-surface mounts provide it — the topology console and the debug
 * overlay's inspector tab.
 *
 * `inspectorCollapsed` and `onInspectorToggle` fit the same shape and stay out
 * deliberately: GraphView renders the inspector's chevron and reads them both,
 * so lifting them here would move a prop away from its only consumer.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

// Null default, so `useChrome` can tell an unwrapped consumer from a provider.
const ChromeContext = createContext( null );

// Module-level so an omitted toggle keeps ONE identity across renders.
const NOOP = () => {};

/**
 * Publishes the chrome to everything the graph surface renders, memoized on the
 * three values so a consumer re-renders only when one of them moves.
 *
 * @param {Object}     props                       Component props.
 * @param {boolean}    [props.paletteCollapsed]    Palette dock collapsed. Default false.
 * @param {() => void} [props.onPaletteToggle]     Flips that state; the palette's chevron calls it.
 * @param {number}     [props.bottomObstructionPx] Canvas px the REPL transcript overlay covers, which autofit keeps the graph above. Default 0.
 * @param {*}          props.children              Consumers.
 * @return {import('react').ReactElement} The provider.
 */
export function ChromeProvider( {
	paletteCollapsed = false,
	onPaletteToggle = NOOP,
	bottomObstructionPx = 0,
	children,
} ) {
	const value = useMemo(
		() => ( { paletteCollapsed, onPaletteToggle, bottomObstructionPx } ),
		[ paletteCollapsed, onPaletteToggle, bottomObstructionPx ]
	);
	return (
		<ChromeContext.Provider value={ value }>
			{ children }
		</ChromeContext.Provider>
	);
}

/**
 * Reads the panel chrome. Throws outside a provider rather than falling back to
 * defaults, because a zero obstruction silently autofits the graph underneath
 * the transcript overlay.
 *
 * @return {Object} `{ paletteCollapsed, onPaletteToggle, bottomObstructionPx }`.
 */
export function useChrome() {
	const value = useContext( ChromeContext );
	if ( ! value ) {
		throw new Error( 'useChrome called outside a ChromeProvider' );
	}
	return value;
}
