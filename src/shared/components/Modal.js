import { createPortal, useRef } from '@wordpress/element';
import { useDismissable } from '../hooks/useDismissable';
import './Modal.scss';

/**
 * The shared plain-DOM modal shell (no `@wordpress/components`): a backdrop and
 * a `role="dialog"` box carrying the canonical `.newspack-nodes-modal` role, so
 * every dashboard's dialog looks identical without declaring its own selectors.
 *
 * ESC and a mousedown outside the box invoke `onClose`, both through the shared
 * `useDismissable`. The backdrop covers the viewport and carries no handler of
 * its own, which is what keeps it `role="presentation"`: a click handler there
 * would make it interactive, and an interactive element owes the keyboard the
 * equivalent ESC already provides.
 *
 * It renders through a PORTAL to the body, carrying the skin classes
 * on its own host, because a caller's box is routinely a stacking context — a
 * dashboard shell is `position: fixed; z-index: 99` — and a z-index inside one
 * ranks only against its siblings. A dialog that must cover a
 * `@wordpress/components` modal, which portals to the body at 100000, cannot
 * win that from inside the tree however high it raises its backdrop. The skin
 * tokens resolve at `<html>`, but the type and colour rules key off those
 * class names, so the host wears them to keep the dialog themed out there.
 *
 * Callers own their own initial focus, so each dialog can focus the element
 * that fits it.
 *
 * @param {Object}                    props
 * @param {string}                    props.ariaLabel           Accessible dialog label.
 * @param {() => void}                props.onClose             Dismiss handler (ESC / backdrop).
 * @param {string}                    [props.className]         Extra classes on the dialog box.
 * @param {string}                    [props.backdropClassName] Extra classes on the BACKDROP — where
 *                                                              `position`/`z-index` live, so a dialog
 *                                                              opened over another modal layer raises
 *                                                              itself here.
 * @param {import('react').ReactNode} props.children            Dialog body.
 * @return {import('react').ReactElement} The modal.
 */
export default function Modal( {
	ariaLabel,
	onClose,
	className = '',
	backdropClassName = '',
	children,
} ) {
	const dialogRef = useRef( null );
	useDismissable( dialogRef, onClose );

	if ( 'undefined' === typeof document ) {
		return null;
	}

	return createPortal(
		<div
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ { display: 'contents' } }
		>
			<div
				className={ `newspack-nodes-modal__backdrop ${ backdropClassName }`.trim() }
				role="presentation"
			>
				<div
					ref={ dialogRef }
					className={ `newspack-nodes-modal ${ className }`.trim() }
					role="dialog"
					aria-modal="true"
					aria-label={ ariaLabel }
				>
					{ children }
				</div>
			</div>
		</div>,
		document.body
	);
}
