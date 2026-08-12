/**
 * The ONE control minter for dashboard view nodes.
 *
 * @package
 */

import {
	newMessage,
	TYPE,
	FROM,
	VALUE,
	TM_STRUCT,
} from '../../runtime/message';

/**
 * Mint a control the given view will apply, stamped with the origin that view
 * was told to trust.
 *
 * A view with no `controlFrom` is a wiring bug, and one that fails LOUD: the
 * alternative is a control whose FROM matches nothing, silently rendered as a
 * record or dropped — a dead Pause button with no error anywhere.
 *
 * @param {Object} view  The view node the control is filled into.
 * @param {Object} value The control payload; `action` picks the verb.
 * @return {Array} The 7-field TM_STRUCT message.
 */
export function controlMsg( view, value ) {
	if ( ! view?.controlFrom ) {
		throw new Error(
			`controlMsg: view ${
				view?.name ?? '(none)'
			} declares no controlFrom`
		);
	}
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = view.controlFrom;
	m[ VALUE ] = value;
	return m;
}
