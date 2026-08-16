import { useRef } from '@wordpress/element';
import { useDismissable } from '../hooks/useDismissable';
import './Modal.scss';

/**
 * The shared plain-DOM modal shell (no `@wordpress/components`): a backdrop and
 * a `role="dialog"` box carrying the canonical `.newspack-nodes-modal` role, so
 * every dashboard's dialog looks identical without declaring its own selectors.
 *
 * ESC and a backdrop mousedown invoke `onClose`. Callers own their own initial
 * focus, so each dialog can focus the element that fits it.
 *
 * @param {Object}                    props
 * @param {string}                    props.ariaLabel           Accessible dialog label.
 * @param {Function}                  props.onClose             Dismiss handler (ESC / backdrop).
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
	// ESC + click-outside; the backdrop IS the region outside the dialog.
	const dialogRef = useRef( null );
	useDismissable( dialogRef, onClose );

	return (
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
	);
}
