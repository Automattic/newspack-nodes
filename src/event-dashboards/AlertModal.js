/**
 * AlertModal — the one-button dialog the Overview fleet board raises when a
 * topology mutation is refused.
 *
 * `useTopologyManager`'s activate, deactivate and restart are fire-and-forget:
 * the refusal arrives a tick later as the verb's error text on the node that
 * asked (TO=FROM, ADR-7), with no promise to reject. Without a dialog the
 * operator sees the toggle snap back and nothing else, so the reason — an
 * unknown name, or an activate that would put two fleets on one log — is what
 * this exists to show.
 *
 * The shell is built here rather than reusing the shared `Modal`, which
 * hardcodes `role="dialog"`. A refusal is an `alertdialog`: the role for a
 * message the operator has to read before carrying on.
 *
 * Paint belongs to the canonical `.newspack-nodes-modal` role, so this dialog
 * matches every other modal in the hub and the `nodes-tm__alert*` classes carry
 * geometry alone. It renders in place instead of portaling to `document.body`,
 * because that role is scoped under the hub root's `.newspack-nodes-ui` and
 * draws its tokens from the `.newspack-nodes-theme` provider there; the fixed
 * backdrop covers the viewport from inside that tree. Repeating the theme class
 * here would declare a second provider.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useDismissable } from '@newspack-nodes/shared/hooks/useDismissable';

/**
 * @param {Object}     props
 * @param {string}     props.title   Dialog heading, and its only accessible
 *                                   name; Overview names the topology that
 *                                   refused.
 * @param {string}     props.message The refusal text the verb returned.
 * @param {() => void} props.onClose Dismiss handler; runs on OK, ESC, and backdrop click.
 * @return {import('react').ReactElement} The modal.
 */
export default function AlertModal( { title, message, onClose } ) {
	const okRef = useRef( null );

	const dialogRef = useRef( null );
	// The one action takes focus, so Enter dismisses without a tab stop.
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
