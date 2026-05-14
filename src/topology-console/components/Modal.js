/**
 * Modal — minimal centered dialog used by the edit-mode flow.
 *
 * Two affordances:
 *   <ConfirmModal>   — title + body + two-button action row (default + danger).
 *   <PromptModal>    — title + body + single text input + two-button row.
 *
 * Why custom: window.confirm/prompt block the JS thread, can't be
 * styled to match the console's brutalist aesthetic, and leak the
 * browser's native chrome (e.g. Chrome's "prevent this site from
 * showing more dialogs" checkbox is hostile for an admin tool).
 *
 * Both modals render via a portal-style overlay div appended to the
 * topology-console root; ESC dismisses (resolves to null/undefined);
 * click-on-backdrop also dismisses; the primary action focuses on
 * mount so Enter confirms without a tab dance.
 */

import { useEffect, useRef, useState } from '@wordpress/element';

function ModalShell( { title, onDismiss, children } ) {
	const ref = useRef( null );

	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				onDismiss();
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ onDismiss ] );

	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop is a click-to-dismiss target; ESC keyboard path is handled via document listener above.
		<div
			className="topology-modal-backdrop"
			onMouseDown={ ( e ) => {
				if ( e.target === e.currentTarget ) {
					onDismiss();
				}
			} }
		>
			<div
				className="topology-modal"
				ref={ ref }
				role="dialog"
				aria-modal="true"
				aria-label={ title }
			>
				<header className="topology-modal__header">{ title }</header>
				{ children }
			</div>
		</div>
	);
}

export function ConfirmModal( {
	title,
	body,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	danger = false,
	onConfirm,
	onCancel,
} ) {
	const primaryRef = useRef( null );
	useEffect( () => {
		primaryRef.current?.focus();
	}, [] );

	return (
		<ModalShell title={ title } onDismiss={ onCancel }>
			<div className="topology-modal__body">{ body }</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ cancelLabel }
				</button>
				<button
					type="button"
					ref={ primaryRef }
					className={ `topology-modal__btn topology-modal__btn--primary${
						danger ? ' topology-modal__btn--danger' : ''
					}` }
					onClick={ onConfirm }
				>
					{ confirmLabel }
				</button>
			</div>
		</ModalShell>
	);
}

export function PromptModal( {
	title,
	body,
	initialValue = '',
	placeholder = '',
	pattern,
	confirmLabel = 'Save',
	cancelLabel = 'Cancel',
	onConfirm,
	onCancel,
} ) {
	const [ value, setValue ] = useState( initialValue );
	const inputRef = useRef( null );
	const valid = ! pattern || pattern.test( value );

	useEffect( () => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [] );

	const submit = () => {
		if ( ! valid || '' === value ) {
			return;
		}
		onConfirm( value );
	};

	return (
		<ModalShell title={ title } onDismiss={ onCancel }>
			<div className="topology-modal__body">
				{ body }
				<input
					ref={ inputRef }
					type="text"
					className="topology-modal__input"
					value={ value }
					placeholder={ placeholder }
					onChange={ ( e ) => setValue( e.target.value ) }
					onKeyDown={ ( e ) => {
						if ( 'Enter' === e.key ) {
							e.preventDefault();
							submit();
						}
					} }
				/>
				{ pattern && ! valid && '' !== value && (
					<div className="topology-modal__hint">
						Invalid: must match { String( pattern ) }
					</div>
				) }
			</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ cancelLabel }
				</button>
				<button
					type="button"
					className="topology-modal__btn topology-modal__btn--primary"
					onClick={ submit }
					disabled={ ! valid || '' === value }
				>
					{ confirmLabel }
				</button>
			</div>
		</ModalShell>
	);
}
