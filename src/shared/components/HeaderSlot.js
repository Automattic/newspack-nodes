/**
 * HeaderSlot — put a dashboard's own controls where the host wants them.
 *
 * NOT `HeaderControls`: the topology console already owns a component by that
 * name, and it is a different thing entirely — the console's actual header bar.
 * This one only decides WHERE a screen's controls go.
 *
 * Three states, and the third is the one worth naming: a SLOT portals into the
 * hub's shared header, `undefined` means nobody offered a slot so the controls
 * render inline, and an explicit null means the host renders them itself and
 * this dashboard must not. Four screens spelled that out by hand, and the
 * undefined-versus-null distinction is exactly what a fifth would get wrong.
 */

import { createPortal } from '@wordpress/element';

/**
 * @param {Object}   o          Options.
 * @param {?Element} o.slot     The hub header slot; undefined when standalone.
 * @param {Object}   o.children The controls to place.
 * @return {?Object} The controls, portalled, inline, or withheld.
 */
export function HeaderSlot( { slot, children } ) {
	if ( slot ) {
		return createPortal( children, slot );
	}
	return undefined === slot ? children : null;
}
