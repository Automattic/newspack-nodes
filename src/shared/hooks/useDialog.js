/**
 * useDialog — the wiring every dialog shell shares: a place in the dialog
 * stack, ESC and an outside mousedown answered only while topmost, Tab
 * trapped only while topmost, the shared exit timing, and the handle a caller
 * closes through.
 *
 * A shell keeps its own render; it reads `closing` for its backdrop and box,
 * and hands `close` to the `ModalClose` its header plays. The handle carries
 * `close` and `closeWith`.
 */

import { useImperativeHandle } from '@wordpress/element';
import { useDialogLayer } from './useDialogLayer';
import { useDismissable } from './useDismissable';
import { useFocusTrap } from './useFocusTrap';
import { useModalExit } from './useModalExit';

/**
 * What a caller closes a dialog through: `close()` plays the exit and then the
 * dialog's own close, `closeWith( run )` the exit and then `run` in its place.
 *
 * @typedef {{close: () => void, closeWith: (run: () => void) => void}} DialogHandle
 */

/**
 * Joins the dialog at `ref` to the stack and gives it the shared close.
 *
 * @param {{current: HTMLElement|null}} ref                   The dialog box.
 * @param {?() => void}                 onClose               Runs once a close without an answer has played the exit; omitted, nothing dismisses the dialog.
 * @param {Object}                      [options]
 * @param {{current: ?DialogHandle}}    [options.handleRef]   Takes `{ close, closeWith }`, the animated close.
 * @param {{current: HTMLElement|null}} [options.returnFocus] The element closing hands focus to.
 * @return {{closing: boolean, close: () => void, closeWith: (run: () => void) => void}} `useModalExit`'s answer.
 */
export function useDialog( ref, onClose, { handleRef, returnFocus } = {} ) {
	const isTop = useDialogLayer();
	const { closing, close, closeWith } = useModalExit( onClose );
	useImperativeHandle( handleRef, () => ( { close, closeWith } ), [
		close,
		closeWith,
	] );
	useDismissable( ref, () => isTop() && close() );
	useFocusTrap( ref, returnFocus, isTop );
	return { closing, close, closeWith };
}
