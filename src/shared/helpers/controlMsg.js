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
 * Whether an arriving message is a CONTROL for this view.
 *
 * A control is recognised by WHO SENT IT, never by what its payload looks like
 * — a record whose VALUE happens to carry an `action` field is still a record,
 * and sniffing for one swallowed whole streams. A view with no `controlFrom`
 * takes no controls, so nothing can pass for one.
 *
 * @param {Object} view    The view node receiving it.
 * @param {Array}  message The 7-field positional message.
 * @return {boolean} True when the view should apply it as a control.
 */
export function isControl( view, message ) {
	return '' !== view.controlFrom && message[ FROM ] === view.controlFrom;
}

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
