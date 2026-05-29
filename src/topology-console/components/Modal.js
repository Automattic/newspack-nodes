/**
 * Modal — minimal centered dialog (ConfirmModal + PromptModal + NewNodeModal).
 * ESC and backdrop-click dismiss; the primary action focuses on mount.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

export function ModalShell( { title, onDismiss, children } ) {
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
	confirmLabel = __( 'Confirm', 'newspack-nodes' ),
	cancelLabel = __( 'Cancel', 'newspack-nodes' ),
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
	confirmLabel = __( 'Save', 'newspack-nodes' ),
	cancelLabel = __( 'Cancel', 'newspack-nodes' ),
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
						{ sprintf(
							// translators: %s: the regular expression the input must match.
							__( 'Invalid: must match %s', 'newspack-nodes' ),
							String( pattern )
						) }
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

/**
 * NewNodeModal — prompted on a palette drop in live mode (topology console
 * and debug overlay). Two inputs stacked: name (pre-filled with the auto-
 * generated `${shell}1` etc.) above args (placeholder = the declared schema
 * template, e.g. `topic* segment_size=4096`). Enter in either input submits;
 * confirm fires with `{ name, args }` so the caller can format the make_node
 * line.
 *
 * @param {Object}   props
 * @param {string}   props.shellName   Class shell name (e.g. "Partition").
 * @param {string}   props.defaultName Auto-generated id (pre-fills name).
 * @param {Array}    props.argSchema   [{ name, required?, default? }, ...]
 * @param {Function} props.onConfirm   ({ name, args }) => void
 * @param {Function} props.onCancel    () => void
 */
export function NewNodeModal( {
	shellName,
	defaultName,
	argSchema = [],
	onConfirm,
	onCancel,
} ) {
	const [ name, setName ] = useState( defaultName || '' );
	const [ args, setArgs ] = useState( '' );
	const nameRef = useRef( null );

	useEffect( () => {
		nameRef.current?.focus();
		nameRef.current?.select();
	}, [] );

	const argPlaceholder = argSchema
		.map(
			( a ) =>
				`${ a.name }${ a.required ? '*' : '' }${
					a.default !== undefined ? `=${ a.default }` : ''
				}`
		)
		.join( ' ' );

	const valid = '' !== name.trim();
	const submit = () => {
		if ( ! valid ) {
			return;
		}
		onConfirm( { name: name.trim(), args } );
	};

	const onKey = ( e ) => {
		if ( 'Enter' === e.key ) {
			e.preventDefault();
			submit();
		}
	};

	const title = sprintf(
		// translators: %s: class shell name (e.g. "Partition").
		__( 'Add %s', 'newspack-nodes' ),
		shellName
	);

	return (
		<ModalShell title={ title } onDismiss={ onCancel }>
			<div className="topology-modal__body">
				<label
					className="topology-modal__label"
					htmlFor="newspack-nodes-newnode-name"
				>
					{ __( 'name', 'newspack-nodes' ) }
				</label>
				<input
					id="newspack-nodes-newnode-name"
					ref={ nameRef }
					type="text"
					className="topology-modal__input"
					value={ name }
					onChange={ ( e ) => setName( e.target.value ) }
					onKeyDown={ onKey }
				/>
				<label
					className="topology-modal__label"
					htmlFor="newspack-nodes-newnode-args"
				>
					{ __( 'arguments', 'newspack-nodes' ) }
				</label>
				<input
					id="newspack-nodes-newnode-args"
					type="text"
					className="topology-modal__input"
					value={ args }
					placeholder={ argPlaceholder }
					onChange={ ( e ) => setArgs( e.target.value ) }
					onKeyDown={ onKey }
				/>
				{ argPlaceholder && (
					<div className="topology-modal__hint">
						{ argPlaceholder }
					</div>
				) }
			</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="topology-modal__btn topology-modal__btn--primary"
					onClick={ submit }
					disabled={ ! valid }
				>
					{ __( 'Add', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}
