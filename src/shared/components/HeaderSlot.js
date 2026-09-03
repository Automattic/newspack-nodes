/**
 * HeaderSlot — puts a dashboard's own controls where its host wants them.
 *
 * Not named `HeaderControls`: the topology console already exports one, and
 * that is the console's own row of buttons. This component places controls; it
 * never supplies any.
 *
 * The `slot` prop carries three states. An Element portals the controls into
 * the host's shared header. `undefined` means no host offered a slot, so the
 * controls render inline, which is the standalone admin page. `null` means the
 * host has a shared header whose slot element has not mounted yet, so the
 * controls are withheld for that render: DevToolsHub seeds that state with null
 * and fills it from its `<Header controlsSlotRef>` callback ref, so every tab
 * sees null on its first render, and rendering inline there would put the
 * controls in the tab body and move them into the header on the next.
 */

import { createPortal } from '@wordpress/element';

/**
 * Renders the controls into the host's slot, inline, or not at all.
 *
 * @param {Object}                    props
 * @param {?Element}                  props.slot     Host header slot; null while the host's slot is pending, undefined when standalone.
 * @param {import('react').ReactNode} props.children The controls to place.
 * @return {import('react').ReactNode} The portal, the controls inline, or nothing.
 */
export function HeaderSlot( { slot, children } ) {
	if ( slot ) {
		return createPortal( children, slot );
	}
	return undefined === slot ? children : null;
}
