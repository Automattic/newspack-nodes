/**
 * useDismissable — ESC and click-outside, the two ways every dialog closes
 * besides its own × button.
 *
 * Mousedown, not click: a dialog dismissed on click can be re-opened by the
 * same gesture that closed it (the button underneath receives the mouseup),
 * and a drag that starts inside and ends outside is not a click away.
 */

import { useEffect, useRef } from '@wordpress/element';

/**
 * @param {Object}   ref       Ref to the dialog element; a click inside it is not outside.
 * @param {Function} onDismiss Called on ESC and on a mousedown outside the ref.
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
