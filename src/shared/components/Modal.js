import { useEffect } from '@wordpress/element';
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
 * @param {string}                    props.ariaLabel   Accessible dialog label.
 * @param {Function}                  props.onClose     Dismiss handler (ESC / backdrop).
 * @param {string}                    [props.className] Extra classes on the dialog box.
 * @param {import('react').ReactNode} props.children    Dialog body.
 * @return {import('react').ReactElement} The modal.
 */
export default function Modal( {
	ariaLabel,
	onClose,
	className = '',
	children,
} ) {
	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ onClose ] );

	return (
		<div
			className="newspack-nodes-modal__backdrop"
			role="presentation"
			onMouseDown={ ( e ) => {
				if ( e.target === e.currentTarget ) {
					onClose();
				}
			} }
		>
			<div
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
