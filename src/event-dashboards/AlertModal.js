import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useDismissable } from '@newspack-nodes/shared/hooks/useDismissable';

/**
 * Minimal one-button alert dialog for the Topology Manager. Used to surface a
 * rejected mutation's reason (e.g. an activate that write-conflicts with the
 * active set) so an operator sees WHY instead of a silent no-op. ESC and
 * backdrop-click dismiss; the OK button focuses on mount.
 *
 * @param {Object}     props
 * @param {string}     props.title   Dialog heading (e.g. the topology that failed).
 * @param {string}     props.message The reason text.
 * @param {() => void} props.onClose Dismiss handler; runs on OK, ESC, and backdrop click.
 * @return {import('react').ReactElement} The modal.
 */
export default function AlertModal( { title, message, onClose } ) {
	const okRef = useRef( null );

	const dialogRef = useRef( null );
	useEffect( () => okRef.current?.focus(), [] );
	// ESC + click-outside; the backdrop is the region outside the dialog.
	useDismissable( dialogRef, onClose );

	return (
		<div className="nodes-tm__alert-backdrop" role="presentation">
			<div
				ref={ dialogRef }
				className="nodes-tm__alert newspack-nodes-modal"
				role="alertdialog"
				aria-modal="true"
				aria-label={ title }
			>
				<header className="newspack-nodes-modal__header newspack-nodes-modal__title nodes-tm__alert-title">
					{ title }
				</header>
				<div className="nodes-tm__alert-body">{ message }</div>
				<div className="nodes-tm__alert-actions">
					<button
						type="button"
						ref={ okRef }
						className="button"
						onClick={ onClose }
					>
						{ __( 'OK', 'newspack-nodes' ) }
					</button>
				</div>
			</div>
		</div>
	);
}
