/**
 * AlertModal — the one-button dialog the Overview fleet board raises when a
 * topology mutation is refused, or an activation succeeds with a warning.
 *
 * `useTopologyManager`'s activate, deactivate and restart are fire-and-forget:
 * the refusal arrives a tick later as the command's error text on the node that
 * asked (TO=FROM, ADR-7), with no promise to reject. Without a dialog the
 * operator sees the toggle snap back and nothing else, so the reason — an
 * unknown name, or an activate that would put two fleets on one log — is what
 * this exists to show.
 *
 * It is the shared `Modal` as an `alertdialog`, the role for a message the
 * operator has to read before carrying on, headed by the compact
 * `ModalHeader` and described by its message. The `nodes-tm__alert*` classes
 * carry only its width and its body; its OK sits in the shared actions row
 * and closes through the shell's handle, so it plays the same exit as ESC and
 * the close icon.
 */

import { useEffect, useId, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import Modal, { ModalHeader } from '@newspack-nodes/shared/components/Modal';

/**
 * @param {Object}     props
 * @param {string}     props.title   Dialog heading, which names the dialog;
 *                                   Overview names the topology that
 *                                   refused.
 * @param {string}     props.message The refusal text the command returned.
 * @param {() => void} props.onClose Runs once OK, the close icon, ESC or a
 *                                   backdrop click has played the exit.
 * @return {import('react').ReactElement} The modal.
 */
export default function AlertModal( { title, message, onClose } ) {
	const okRef = useRef( null );
	const handle = useRef( null );
	const messageId = useId();
	// OK takes focus, so Enter dismisses without a tab stop.
	useEffect( () => okRef.current?.focus(), [] );

	return (
		<Modal
			role="alertdialog"
			onClose={ onClose }
			handleRef={ handle }
			ariaDescribedby={ messageId }
			className="nodes-tm__alert"
		>
			<ModalHeader title={ title } compact />
			<div id={ messageId } className="nodes-tm__alert-body">
				{ message }
			</div>
			<div className="newspack-nodes-modal__actions">
				<button
					type="button"
					ref={ okRef }
					className="button"
					onClick={ () => handle.current.close() }
				>
					{ __( 'OK', 'newspack-nodes' ) }
				</button>
			</div>
		</Modal>
	);
}
