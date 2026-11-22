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
 * the box, or in a dialog stacked above it leaves it open. Every press on the
 * backdrop has its default prevented, whether or not the dialog can be
 * dismissed, so it never moves focus out of the box.
 *
 * On open, focus moves into the box unless it is already there: to what
 * `initialFocus` names, else to the title that names the dialog, else to the
 * box, which takes `tabIndex -1`. `initialFocus` is a ref, or `'field'`, the
 * box's first enabled input, select or textarea, a button-type input
 * excepted. A target that does not take focus inside the box, one disabled,
 * hidden, detached or outside it, falls through to the title or the box. A
 * component inside the dialog that focuses itself on mount wins, because its
 * effects run before this hook's; a parent that renders the dialog and then
 * focuses or selects from its own effect does so after this hook. The box
 * is `inert` while its exit plays, which blurs whatever it held, so a close
 * its caller declines puts focus back the same way, unless another dialog
 * now stands above it. Closing hands it back to the opener.
 *
 * A shell keeps its own render; it reads `closing` for its backdrop and box,
 * and hands `close` to the `ModalClose` its header plays. The handle carries
 * `close` and `closeWith`.
 */

import { useEffect, useImperativeHandle } from '@wordpress/element';
import { useDialogLayer } from './useDialogLayer';
import { useDismissable } from './useDismissable';
import { TABBABLE, useFocusTrap } from './useFocusTrap';
import { useModalExit } from './useModalExit';

/**
 * What a caller closes a dialog through: `close()` plays the exit and then the
 * dialog's own close, `closeWith( run )` the exit and then `run` in its place.
 *
 * @typedef {{close: () => void, closeWith: (run: () => void) => void}} DialogHandle
 */

/**
 * What takes a dialog's first focus: the element a ref holds, or `'field'`,
 * the box's first enabled input, select or textarea, a button-type input
 * excepted.
 *
 * @typedef {{current: HTMLElement|null}|'field'} InitialFocus
 */

/** What `'field'` takes: a control a person types or picks in, not a button. */
const FIELD =
	'input:not([type="submit" i]):not([type="button" i]):not([type="reset" i]):not([type="image" i]), select, textarea';

/**
 * Joins the dialog at `ref` to the stack and gives it the shared close.
 *
 * @param {{current: HTMLElement|null}} ref                    The dialog box.
 * @param {?() => void}                 onClose                Runs once a close without an answer has played the exit; omitted, nothing dismisses the dialog.
 * @param {Object}                      [options]
 * @param {{current: ?DialogHandle}}    [options.handleRef]    Takes `{ close, closeWith }`, the animated close.
 * @param {{current: HTMLElement|null}} [options.returnFocus]  The element closing hands focus to.
 * @param {{current: HTMLElement|null}} [options.backdropRef]  The backdrop; a mousedown on it, and on nothing inside it, closes the dialog.
 * @param {InitialFocus}                [options.initialFocus] What takes first focus, over the title; a declined close refocuses it.
 * @return {{closing: boolean, close: () => void}} `closing` while the exit plays, and the close a header's button runs.
 */
export function useDialog(
	ref,
	onClose,
	{ handleRef, returnFocus, backdropRef, initialFocus } = {}
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
		const onDown = ( e ) => {
			if ( e.target !== backdrop ) {
				return;
			}
			e.preventDefault();
			if ( isTop() ) {
				close();
			}
		};
		backdrop.addEventListener( 'mousedown', onDown );
		return () => backdrop.removeEventListener( 'mousedown', onDown );
	}, [ backdropRef, isTop, close ] );

	useEffect( () => {
		const box = ref.current;
		const doc = box?.ownerDocument;
		if (
			closing ||
			! box ||
			! isTop() ||
			box.contains( doc.activeElement )
		) {
			return;
		}
		initialTarget( box, initialFocus )?.focus();
		if ( ! box.contains( doc.activeElement ) ) {
			const named = box.getAttribute( 'aria-labelledby' );
			( ( named && doc.getElementById( named ) ) || box ).focus();
		}
	}, [ ref, closing, isTop, initialFocus ] );

	return { closing, close };
}

/**
 * The element `initialFocus` names, or null for none; `'field'` reads `box`.
 *
 * @param {HTMLElement}  box          The dialog box.
 * @param {InitialFocus} initialFocus What takes first focus.
 * @return {HTMLElement|null} The element.
 */
function initialTarget( box, initialFocus ) {
	if ( 'field' !== initialFocus ) {
		return initialFocus?.current ?? null;
	}
	return (
		/** @type {HTMLElement[]} */ (
			Array.from( box.querySelectorAll( TABBABLE ) )
		).find( ( el ) => el.matches( FIELD ) ) ?? null
	);
}
