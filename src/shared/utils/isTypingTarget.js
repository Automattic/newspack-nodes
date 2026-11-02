/* global Element */
/** Where a key is the reader's typing: a field, or content they can edit. */
const FIELD =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a key event's target is a field the reader types in, the target
 * itself or an ancestor, so a page-level shortcut leaves the key alone.
 * Anything that is not an element, `document` and `window` among them, is
 * not one.
 *
 * @param {?EventTarget} element The event's target.
 * @return {boolean} Whether a key there is typing.
 */
export function isTypingTarget( element ) {
	return element instanceof Element && null !== element.closest( FIELD );
}
