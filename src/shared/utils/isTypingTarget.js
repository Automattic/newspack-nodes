/* global Element */
/** Input types that take no text, so a key pressed there is a shortcut. */
const UNTYPED = [
	'checkbox',
	'radio',
	'button',
	'submit',
	'reset',
	'range',
	'color',
	'file',
	'image',
];

const TEXT_INPUT =
	'input' +
	UNTYPED.map( ( type ) => `:not([type="${ type }" i])` ).join( '' );

/** Where a key is the reader's typing: a field, or content they can edit. */
const FIELD = [
	TEXT_INPUT,
	'textarea',
	'select',
	'[contenteditable]:not([contenteditable="false"])',
].join( ', ' );

/**
 * Whether a key event's target is a field the reader types in, the target
 * itself or an ancestor, so a page-level shortcut leaves the key alone. An
 * input counts only when its type takes text; one with no type, or a type
 * the browser does not know, takes text.
 * Anything that is not an element, `document` and `window` among them, is
 * not one.
 *
 * @param {?EventTarget} element The event's target.
 * @return {boolean} Whether a key there is typing.
 */
export function isTypingTarget( element ) {
	return element instanceof Element && null !== element.closest( FIELD );
}
