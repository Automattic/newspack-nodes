/**
 * useDialogLayer — the open dialogs, each ranked by when it first rendered.
 * Only the topmost answers Escape, an outside mousedown and Tab, so a dialog
 * opened from another leaves the first one open beneath it.
 *
 * Rank is taken at render, not in the effect: effects run child-first, so a
 * dialog mounted open inside another in one commit would otherwise register
 * beneath its parent. Render runs parent-first.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';

/** @type {Set<number>} The rank of each open dialog. */
const layers = new Set();

/** The last rank handed out. */
let seq = 0;

/**
 * Registers the calling dialog while mounted.
 *
 * @return {() => boolean} Whether this dialog is the topmost open one.
 */
export function useDialogLayer() {
	const [ order ] = useState( () => ++seq );

	useEffect( () => {
		layers.add( order );
		return () => {
			layers.delete( order );
		};
	}, [ order ] );

	return useCallback( () => Math.max( ...layers ) <= order, [ order ] );
}
