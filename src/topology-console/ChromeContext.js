/**
 * ChromeContext — panel chrome the canvas surface reacts to.
 *
 * Only the three GraphView forwards without reading: the palette's collapse
 * state and its toggle, which reach `Palette`, and the transcript overlay's
 * height, which `SchematicCanvas` reserves during autofit.
 *
 * `inspectorCollapsed` / `onInspectorToggle` are deliberately absent. GraphView
 * renders the inspector's chevron and reads them; they are its own state, and
 * lifting them would move a prop away from its only real consumer.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

const ChromeContext = createContext( null );

const NOOP = () => {};

/**
 * @param {Object}   props                       Component props.
 * @param {boolean}  [props.paletteCollapsed]    Palette dock collapsed.
 * @param {Function} [props.onPaletteToggle]     Toggle it.
 * @param {number}   [props.bottomObstructionPx] Canvas px the REPL covers.
 * @param {*}        props.children              Consumers.
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
 * @return {Object} `{ paletteCollapsed, onPaletteToggle, bottomObstructionPx }`.
 */
export function useChrome() {
	const value = useContext( ChromeContext );
	if ( ! value ) {
		// Loud: a zero obstruction silently autofits under the transcript.
		throw new Error( 'useChrome called outside a ChromeProvider' );
	}
	return value;
}
