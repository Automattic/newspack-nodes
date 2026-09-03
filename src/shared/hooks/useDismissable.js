/**
 * useDismissable — ESC and click-outside, the two ways every dialog closes
 * besides its own × button.
 *
 * Mousedown, not click: a dialog dismissed on click can be re-opened by the
 * same gesture that closed it (the button underneath receives the mouseup),
 * and a drag that starts inside and ends outside is not a click away.
 *
 * Both listeners sit on `document`, one pair per mounted caller, so ESC
 * dismisses every open dialog at once. `preventDefault()` suppresses the
 * browser's own handling of the key, never a sibling listener.
 */

import { useEffect, useRef } from '@wordpress/element';

/**
 * Dismisses on ESC, and on a mousedown landing outside the given element.
 *
 * Until `ref.current` is attached nothing counts as outside, so a dialog whose
 * ref never lands closes on ESC alone rather than on the first click anywhere.
 *
 * @param {{current: HTMLElement|null}} ref       The dialog element; a mousedown inside it is not outside.
 * @param {() => void}                  onDismiss Runs on ESC and on a mousedown outside `ref`.
 * @return {void}
 */
export function useDismissable( ref, onDismiss ) {
	// An inline-arrow caller would re-attach both listeners on every render.
	const onDismissRef = useRef( onDismiss );
	onDismissRef.current = onDismiss;

	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				onDismissRef.current();
			}
		};
		const onDown = ( e ) => {
			const el = ref?.current;
			if ( el && ! el.contains( e.target ) ) {
				onDismissRef.current();
			}
		};
		document.addEventListener( 'keydown', onKey );
		document.addEventListener( 'mousedown', onDown );
		return () => {
			document.removeEventListener( 'keydown', onKey );
			document.removeEventListener( 'mousedown', onDown );
		};
	}, [ ref ] );
}
