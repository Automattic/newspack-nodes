/**
 * useDialog — the wiring every dialog shell shares: a place in the dialog
 * stack, ESC and a mousedown on the backdrop answered only while topmost, Tab
 * trapped only while topmost, first focus, the shared exit timing, and the
 * handle a caller closes through.
 *
 * ESC closes the topmost dialog unless something already took it: a picker
 * inside the dialog that prevents its default keeps the dialog open. A
 * dialog beneath the topmost declines the ESC rather than taking it.
 *
 * Only a mousedown whose target is the backdrop element itself closes the
 * dialog, so a press in a popover the dialog opened, which portals outside
 * the box, or in a dialog stacked above it leaves it open.
 *
 * On open, focus moves into the box unless the caller's own effects already
 * put it there: to the title that names the dialog, else to the box, which
 * takes `tabIndex -1`. Closing hands it back to the opener.
 *
 * A shell keeps its own render; it reads `closing` for its backdrop and box,
 * and hands `close` to the `ModalClose` its header plays. The handle carries
 * `close` and `closeWith`.
 */

import { useEffect, useImperativeHandle } from '@wordpress/element';
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
 * @param {{current: HTMLElement|null}} [options.backdropRef] The backdrop; a mousedown on it, and on nothing inside it, closes the dialog.
 * @return {{closing: boolean, close: () => void, closeWith: (run: () => void) => void}} `useModalExit`'s answer.
 */
export function useDialog(
	ref,
	onClose,
	{ handleRef, returnFocus, backdropRef } = {}
) {
	const isTop = useDialogLayer();
	const { closing, close, closeWith } = useModalExit( onClose );
	useImperativeHandle( handleRef, () => ( { close, closeWith } ), [
		close,
		closeWith,
	] );
	useDismissable( null, () => ( isTop() ? close() : false ) );
	useFocusTrap( ref, returnFocus, isTop );

	useEffect( () => {
		const backdrop = backdropRef?.current;
		if ( ! backdrop ) {
			return undefined;
		}
		const onDown = ( e ) => e.target === backdrop && isTop() && close();
		backdrop.addEventListener( 'mousedown', onDown );
		return () => backdrop.removeEventListener( 'mousedown', onDown );
	}, [ backdropRef, isTop, close ] );

	// The caller's effects ran first, so a field it focused already holds it.
	useEffect( () => {
		const box = ref.current;
		const doc = box?.ownerDocument;
		if ( ! box || box.contains( doc.activeElement ) ) {
			return;
		}
		const named = box.getAttribute( 'aria-labelledby' );
		( ( named && doc.getElementById( named ) ) || box ).focus();
	}, [ ref ] );

	return { closing, close, closeWith };
}
