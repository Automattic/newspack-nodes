/**
 * useDialogLayer — the open dialogs, each ranked by when it first rendered.
 * Only the topmost answers Escape, a mousedown on its backdrop and Tab, so a
 * dialog opened from another leaves the first one open beneath it.
 *
 * Rank is taken at render, not in the effect: effects run child-first, so a
 * dialog mounted open inside another in one commit would otherwise register
 * beneath its parent. Render runs parent-first.
 *
 * While any dialog is open, `<body>` wears `newspack-nodes-modal-open`, which
 * locks the page's scroll; the last dialog to unmount takes it off, an exit
 * cut short included. It is the shell's own class: WordPress admin's
 * `modal-open` is toggled by the media modal and other admin scripts, which
 * would unlock under an open dialog, and is styled only where admin CSS loads.
 */

/** The class on `<body>` while a dialog is open. */
const LOCK = 'newspack-nodes-modal-open';

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
		document.body.classList.add( LOCK );
		return () => {
			layers.delete( order );
			if ( 0 === layers.size ) {
				document.body.classList.remove( LOCK );
			}
		};
	}, [ order ] );

	return useCallback( () => Math.max( ...layers ) <= order, [ order ] );
}
