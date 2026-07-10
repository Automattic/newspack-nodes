/**
 * Modal — minimal centered dialog (ConfirmModal + PromptModal + NewNodeModal).
 * ESC and backdrop-click dismiss; the primary action focuses on mount.
 */

import { createPortal, useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { CtorField } from './CtorField';
import { serializeCtorArgs } from '../utils/serializeTsl';

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

	if ( typeof document === 'undefined' ) {
		return null;
	}
	// Center the dialog over the overlay PANEL (backdrop still dims the page).
	const panelRect = document
		.querySelector( '.nodes-debug__panel' )
		?.getBoundingClientRect();
	const modalStyle = panelRect
		? {
				position: 'absolute',
				left: panelRect.left + panelRect.width / 2,
				top: panelRect.top + panelRect.height / 2,
				transform: 'translate(-50%, -50%)',
		  }
		: undefined;
	return createPortal(
		<div
			className="topology-app newspack-nodes-theme"
			style={ { display: 'contents' } }
		>
			<div
				className="topology-modal-backdrop"
				role="presentation"
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
					style={ modalStyle }
				>
					<header className="topology-modal__header">
						<span className="topology-modal__title">{ title }</span>
						<button
							type="button"
							className="topology-modal__close"
							aria-label={ __( 'Close', 'newspack-nodes' ) }
							onClick={ onDismiss }
						>
							{ '×' }
						</button>
					</header>
					{ children }
				</div>
			</div>
		</div>,
		document.body
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
				<button type="button" className="button" onClick={ onCancel }>
					{ cancelLabel }
				</button>
				<button
					type="button"
					ref={ primaryRef }
					className={ `button button-primary${
						danger ? ' is-danger' : ''
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
				<button type="button" className="button" onClick={ onCancel }>
					{ cancelLabel }
				</button>
				<button
					type="button"
					className="button button-primary"
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
 * and debug overlay). A name input (pre-filled with the auto-generated
 * `${shell}1` etc.) above the class's node_schema-enriched Constructor fields —
 * the SAME `CtorField` widgets edit mode renders (typed text, formatter/node
 * pickers, per-field defaults), instead of one freeform args string. On confirm
 * the per-field values serialize to the positional args string (defaults filled,
 * trailing empties dropped — matching edit-mode `serializeTsl`), and `onConfirm`
 * fires with `{ name, args }` so the caller formats the make_node line.
 *
 * @param {Object}   props
 * @param {string}   props.shellName   Class shell name (e.g. "Partition").
 * @param {string}   props.defaultName Auto-generated id (pre-fills name).
 * @param {Array}    props.argSchema   [{ name, type?, required?, default? }, ...]
 * @param {Array}    props.nodeNames   Other node ids (for node_name arg pickers).
 * @param {Array}    props.formatters  Registered formatter names (formatter_name args).
 * @param {Array}    props.vaults      Registered Vault entries (vault_id args).
 * @param {Function} props.onConfirm   ({ name, args }) => void
 * @param {Function} props.onCancel    () => void
 */
export function NewNodeModal( {
	shellName,
	defaultName,
	argSchema = [],
	nodeNames = [],
	formatters = [],
	vaults = [],
	onConfirm,
	onCancel,
} ) {
	const [ name, setName ] = useState( defaultName || '' );
	const [ values, setValues ] = useState( () => argSchema.map( () => '' ) );
	const nameRef = useRef( null );

	useEffect( () => {
		nameRef.current?.focus();
		nameRef.current?.select();
	}, [] );

	const valid = '' !== name.trim();
	const submit = () => {
		if ( ! valid ) {
			return;
		}
		onConfirm( {
			name: name.trim(),
			args: serializeCtorArgs( values, argSchema ),
		} );
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
				{ argSchema.length > 0 && (
					// eslint-disable-next-line jsx-a11y/no-static-element-interactions
					<div className="topology-modal__ctor" onKeyDown={ onKey }>
						{ argSchema.map( ( spec, i ) => (
							<CtorField
								key={ spec.name }
								spec={ spec }
								value={ values[ i ] }
								nodeNames={ nodeNames }
								formatters={ formatters }
								vaults={ vaults }
								onChange={ ( v ) => {
									const next = values.slice();
									next[ i ] = v;
									setValues( next );
								} }
							/>
						) ) }
					</div>
				) }
			</div>
			<div className="topology-modal__actions">
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="button button-primary"
					onClick={ submit }
					disabled={ ! valid }
				>
					{ __( 'Add', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}
