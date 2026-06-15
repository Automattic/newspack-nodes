import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

/**
 * Minimal one-button alert dialog for the Topology Manager. Used to surface a
 * rejected mutation's reason (e.g. an activate that write-conflicts with the
 * active set) so an operator sees WHY instead of a silent no-op. ESC and
 * backdrop-click dismiss; the OK button focuses on mount.
 *
 * @param {Object}   props
 * @param {string}   props.title   Dialog heading (e.g. the topology that failed).
 * @param {string}   props.message The reason text.
 * @param {Function} props.onClose Dismiss handler.
 * @return {import('react').ReactElement} The modal.
 */
export default function AlertModal( { title, message, onClose } ) {
	const okRef = useRef( null );

	useEffect( () => {
		okRef.current?.focus();
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
			className="nodes-tm__alert-backdrop"
			role="presentation"
			onMouseDown={ ( e ) => {
				if ( e.target === e.currentTarget ) {
					onClose();
				}
			} }
		>
			<div
				className="nodes-tm__alert"
				role="alertdialog"
				aria-modal="true"
				aria-label={ title }
			>
				<header className="nodes-tm__alert-title">{ title }</header>
				<div className="nodes-tm__alert-body">{ message }</div>
				<div className="nodes-tm__alert-actions">
					<button
						type="button"
						ref={ okRef }
						className="nodes-tm__alert-ok"
						onClick={ onClose }
					>
						{ __( 'OK', 'newspack-nodes' ) }
					</button>
				</div>
			</div>
		</div>
	);
}
