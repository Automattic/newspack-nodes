/**
 * useDismissable — ESC and click-outside, the two ways a panel closes besides
 * its own × button. A dialog takes only its ESC from here, through
 * `useDialog`, which closes it on its backdrop instead.
 *
 * Mousedown, not click: a dialog dismissed on click can be re-opened by the
 * same gesture that closed it (the button underneath receives the mouseup),
 * and a drag that starts inside and ends outside is not a click away.
 *
 * Both listeners sit on `document`, one pair per mounted caller. An ESC whose
 * default is already prevented belongs to whatever prevented it (a picker
 * inside the dialog clearing its search, a dialog above this one), so it
 * dismisses nothing. A caller that acts on an ESC prevents its default in
 * turn, so the listeners after it leave it alone; one that answers `false`
 * declines, and leaves the ESC to them.
 */

import { useEffect, useRef } from '@wordpress/element';

/**
 * Dismisses on ESC, and on a mousedown landing outside the given element.
 *
 * Until `ref.current` is attached nothing counts as outside, so a dialog whose
 * ref never lands closes on ESC alone rather than on the first click anywhere.
 * Given no ref at all it is ESC alone, with no mousedown listener.
 *
 * @param {?{current: HTMLElement|null}} ref       The dialog element; a mousedown inside it is not outside. Null for ESC alone.
 * @param {() => (boolean|void)}         onDismiss Runs on an untaken ESC and on a mousedown outside `ref`; `false` declines the ESC.
 * @return {void}
 */
export function useDismissable( ref, onDismiss ) {
	// An inline-arrow caller would re-attach both listeners on every render.
	const onDismissRef = useRef( onDismiss );
	onDismissRef.current = onDismiss;

	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' !== e.key || e.defaultPrevented ) {
				return;
			}
			if ( false !== onDismissRef.current() ) {
				e.preventDefault();
			}
		};
		const onDown = ( e ) => {
			const el = ref?.current;
			if ( el && ! el.contains( e.target ) ) {
				onDismissRef.current();
			}
		};
		document.addEventListener( 'keydown', onKey );
		if ( ref ) {
			document.addEventListener( 'mousedown', onDown );
		}
		return () => {
			document.removeEventListener( 'keydown', onKey );
			document.removeEventListener( 'mousedown', onDown );
		};
	}, [ ref ] );
}
