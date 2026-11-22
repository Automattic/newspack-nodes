/**
 * useFocusTrap — what `aria-modal="true"` promises the keyboard: Tab and
 * Shift+Tab stay inside the dialog, and closing it returns focus to the
 * element a `returnFocus` ref holds, else to whatever held it when the
 * dialog opened.
 *
 * Only the two edges are handled. Tab between inner fields is left to the
 * browser, so the trap adds nothing to the dialog's own tab order.
 *
 * The opener is read during the first render: effects run child-first, so a
 * dialog or a child focusing itself on mount would otherwise be read instead.
 */

import { useEffect, useRef, useState } from '@wordpress/element';

/** Every element Tab can reach, by the browser's own rule. */
export const TABBABLE =
	'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside `ref`, and on unmount returns focus to the element
 * `returnFocus` held as the dialog opened, else to what held focus then.
 *
 * @param {{current: HTMLElement|null}} ref           The dialog element.
 * @param {{current: HTMLElement|null}} [returnFocus] The element closing hands focus to, such as the dialog's trigger.
 * @param {() => boolean}               [isActive]    Whether this trap answers Tab now; a dialog beneath another answers false, leaving Tab to the browser.
 * @return {void}
 */
export function useFocusTrap( ref, returnFocus = null, isActive = () => true ) {
	const [ opener ] = useState(
		() =>
			/** @type {HTMLElement|null} */ (
				// eslint-disable-next-line @wordpress/no-global-active-element -- no ref yet
				'undefined' === typeof document ? null : document.activeElement
			)
	);
	// An inline-arrow caller would otherwise re-run the effect, and refocus.
	const isActiveRef = useRef( isActive );
	isActiveRef.current = isActive;
	useEffect( () => {
		const doc = ref.current?.ownerDocument;
		if ( ! doc ) {
			return;
		}
		const onKey = ( e ) => {
			const el = ref.current;
			if ( 'Tab' !== e.key || ! el || ! isActiveRef.current() ) {
				return;
			}
			const tabbable = /** @type {HTMLElement[]} */ (
				Array.from( el.querySelectorAll( TABBABLE ) )
			);
			if ( 0 === tabbable.length ) {
				e.preventDefault();
				return;
			}
			const first = tabbable[ 0 ];
			const last = tabbable[ tabbable.length - 1 ];
			const edge = e.shiftKey ? first : last;
			if (
				doc.activeElement === edge ||
				! el.contains( doc.activeElement )
			) {
				e.preventDefault();
				( e.shiftKey ? last : first ).focus();
			}
		};
		doc.addEventListener( 'keydown', onKey );
		const back = returnFocus?.current ?? opener;
		return () => {
			doc.removeEventListener( 'keydown', onKey );
			if ( back?.isConnected ) {
				back.focus();
			}
		};
	}, [ ref, opener, returnFocus ] );
}
