/**
 * The dialog layer of the topology console and the debug overlay: `ModalShell`,
 * which owns the backdrop, the panel chrome and the dismiss wiring, and the
 * three stock dialogs built on it — a confirmation, a single-line prompt, and
 * the new-node form a palette drop opens.
 *
 * Every dialog closes three ways: its × button, ESC, and a mousedown outside
 * the panel. Each focuses on mount where the answer begins — the confirm
 * button for a yes/no, the text input with its initial value selected for the
 * two that take typing — so a dialog can be answered without the mouse.
 */

import {
	createPortal,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from '@wordpress/element';
import { useDismissable } from '@newspack-nodes/shared/hooks/useDismissable';
import { __, sprintf } from '@wordpress/i18n';
import { CtorField } from './CtorField';
import { serializeCtorArgs } from '../utils/tslArgs';
import { primaryButtonClass } from '@newspack-nodes/shared/utils/buttonClass';

// Breathing room between a panel-anchored dialog's edge and the panel's own.
const PANEL_GUTTER = 16;

/**
 * `.topology-modal`'s own `min-width`, which outranks any max-width the panel
 * cap narrows. `styleOwnership` pins this to the stylesheet it is copied from.
 *
 * @testonly
 */
export const MODAL_MIN_W = 360;

// @longform Chrome the caps cannot shrink, measured off graph-view.scss: a 40px
// header (24px close control + 8px padding each side) over a 51px actions row
// (30px button + 10px padding each side + a 1px border). The body absorbs every
// other squeeze — it carries `min-height: 0` and scrolls — so these two are the
// dialog's irreducible height.
const MODAL_CHROME_H = 40 + 51;

// @longform Below either floor plus its gutters a panel cannot contain a dialog
// however tight the caps are, and `useDebugFrame` lets one be dragged down to
// 200x120 — so there the dialog stays viewport-centred rather than anchoring
// and painting outside the panel it is supposed to belong to.
const MIN_ANCHOR_W = MODAL_MIN_W + 2 * PANEL_GUTTER;
const MIN_ANCHOR_H = MODAL_CHROME_H + 2 * PANEL_GUTTER;

/**
 * ModalShell — the backdrop, panel, header and dismiss wiring every dialog in
 * the console and the debug overlay reuses.
 *
 * It renders through a portal on `document.body`, so no ancestor's overflow or
 * stacking context can clip it and the fixed backdrop dims the whole page,
 * overlay panel included. That portal lands outside the app root, which is
 * where the skin selectors are scoped, so it re-establishes the skin, theme
 * and UI classes on a root of its own; `display: contents` keeps that root
 * from adding a box between `<body>` and the backdrop.
 *
 * Rendered inside a debug-overlay panel big enough to hold it, the dialog
 * belongs to that panel rather than the viewport: it centers on the panel in
 * both axes and hands the panel's box down as `--nodes-modal-max-w` /
 * `--nodes-modal-max-h`, which the stylesheet narrows its standing width and
 * height caps with, so no edge escapes the overlay. That cap is what makes the
 * vertical anchor safe — a dialog taller than the panel scrolls in its own
 * body instead of stranding its head above the fixed backdrop. The measurement
 * is all that crosses: the geometry stays in CSS. Anywhere else — no panel, a
 * panel the dialog does not render inside, or one under MIN_ANCHOR_W /
 * MIN_ANCHOR_H — it centers on the viewport as it always has.
 *
 * The dialog panel carries two class families: `topology-modal*` for the
 * console's geometry, `newspack-nodes-modal*` for the canonical shared paint.
 *
 * @param {Object}                    props
 * @param {string}                    props.title       Dialog title, also its accessible name.
 * @param {() => void}                props.onDismiss   Runs on ESC, a mousedown outside the panel, and the close button.
 * @param {boolean}                   [props.wide]      Add the large-panel modifier class.
 * @param {string}                    [props.className] Extra classes on the panel.
 * @param {import('react').ReactNode} props.children    Body and action rows.
 * @return {import('react').ReactNode} The portal, or null where there is no document.
 */
export function ModalShell( {
	title,
	onDismiss,
	wide = false,
	className = '',
	children,
} ) {
	const ref = useRef( null );
	// Sentinel at the render site: a dialog's panel is the one it is nested in.
	const anchorRef = useRef( null );
	const [ panelRect, setPanelRect ] = useState( null );
	// The backdrop needs no handler: a mousedown on it is outside the panel.
	useDismissable( ref, onDismiss );

	useLayoutEffect( () => {
		const panel = anchorRef.current?.closest( '.nodes-debug__panel' );
		const measure = () => {
			const rect = panel?.getBoundingClientRect();
			setPanelRect(
				rect &&
					MIN_ANCHOR_W <= rect.width &&
					MIN_ANCHOR_H <= rect.height
					? rect
					: null
			);
		};
		measure();
		if ( ! panel ) {
			return undefined;
		}
		// @longform The panel's own box, not the window's: `useDebugFrame`
		// re-clamps the panel on a window resize through a batched state
		// update, so a listener on the same event reads the box it had before
		// that landed. A ResizeObserver fires after layout whatever moved it.
		if ( typeof window.ResizeObserver === 'undefined' ) {
			window.addEventListener( 'resize', measure );
			return () => window.removeEventListener( 'resize', measure );
		}
		const observer = new window.ResizeObserver( measure );
		observer.observe( panel );
		return () => observer.disconnect();
	}, [] );

	if ( typeof document === 'undefined' ) {
		return null;
	}
	const modalStyle = panelRect
		? /** @type {import('react').CSSProperties} */ ( {
				position: 'absolute',
				left: panelRect.left + panelRect.width / 2,
				top: panelRect.top + panelRect.height / 2,
				transform: 'translate(-50%, -50%)',
				'--nodes-modal-max-w': `${ Math.max(
					0,
					panelRect.width - 2 * PANEL_GUTTER
				) }px`,
				'--nodes-modal-max-h': `${ Math.max(
					0,
					panelRect.height - 2 * PANEL_GUTTER
				) }px`,
		  } )
		: undefined;
	const portal = createPortal(
		<div
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ { display: 'contents' } }
		>
			<div className="topology-modal-backdrop" role="presentation">
				<div
					className={ `topology-modal newspack-nodes-modal${
						wide ? ' topology-modal--large' : ''
					}${ className ? ` ${ className }` : '' }` }
					ref={ ref }
					role="dialog"
					aria-modal="true"
					aria-label={ title }
					style={ modalStyle }
				>
					<header className="topology-modal__header newspack-nodes-modal__header">
						<span className="topology-modal__title newspack-nodes-modal__title">
							{ title }
						</span>
						<button
							type="button"
							className="topology-modal__close newspack-nodes-modal__close"
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
	return (
		<>
			<span ref={ anchorRef } hidden />
			{ portal }
		</>
	);
}

/**
 * ConfirmModal — a yes/no dialog. The confirm button takes focus on mount, so
 * Enter accepts and ESC cancels without reaching for the mouse.
 *
 * @param {Object}                    props
 * @param {string}                    props.title          Dialog title.
 * @param {import('react').ReactNode} props.body           Question or explanation above the actions.
 * @param {string}                    [props.confirmLabel] Label on the primary button.
 * @param {string}                    [props.cancelLabel]  Label on the dismiss button.
 * @param {boolean}                   [props.danger]       Style the primary button as destructive.
 * @param {() => void}                props.onConfirm      Runs when the primary button is pressed.
 * @param {() => void}                props.onCancel       Runs on cancel, ESC, and a mousedown outside the panel.
 * @return {import('react').ReactNode} The dialog.
 */
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

/**
 * PromptModal — a single-line text prompt. The input takes focus and selects
 * its initial value on mount, Enter submits, and confirm stays disabled while
 * the value is empty or fails `pattern`.
 *
 * @param {Object}                    props
 * @param {string}                    props.title          Dialog title.
 * @param {import('react').ReactNode} props.body           Prompt text above the input.
 * @param {string}                    [props.initialValue] Value the input starts with, pre-selected.
 * @param {string}                    [props.placeholder]  Placeholder for the empty input.
 * @param {RegExp}                    [props.pattern]      Value must match this to submit; a miss names it in a hint.
 * @param {string}                    [props.confirmLabel] Label on the primary button.
 * @param {string}                    [props.cancelLabel]  Label on the dismiss button.
 * @param {(value: string) => void}   props.onConfirm      Runs with the entered value.
 * @param {() => void}                props.onCancel       Runs on cancel, ESC, and a mousedown outside the panel.
 * @return {import('react').ReactNode} The dialog.
 */
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
					className={ primaryButtonClass( ! valid || '' === value ) }
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
 * NewNodeModal — the form a palette drop opens in live mode, in both the
 * topology console and the debug overlay. It takes the node's name, pre-filled
 * with the auto-generated one, above one row per constructor argument the
 * class's `node_schema()` declares.
 *
 * Those rows are the `CtorField` widgets edit mode renders — typed text,
 * formatter, node and vault pickers, per-field defaults — rather than a single
 * freeform args string, so adding a node live offers the same pickers and
 * typed inputs the editor does. On confirm the per-field values
 * serialize positionally with defaults filled and trailing empties dropped,
 * which is what the editor writes for the same node, and `onConfirm` receives
 * `{ name, args }` for the caller to format into its `make_node` line.
 *
 * @param {Object}                                         props
 * @param {string}                                         props.shellName    Class shell name, such as "Partition".
 * @param {string}                                         props.defaultName  Auto-generated node id; pre-fills the name input.
 * @param {import('./CtorField').CtorArgSpec[]}            [props.argSchema]  Constructor arguments the class declares.
 * @param {string[]}                                       [props.nodeNames]  Node ids the `node_name` pickers offer.
 * @param {string[]}                                       [props.formatters] Registered formatter names, for `formatter_name` arguments.
 * @param {import('./CtorField').VaultEntry[]}             [props.vaults]     Vault entries, for `vault_id` arguments.
 * @param {(node: { name: string, args: string }) => void} props.onConfirm    Runs with the node id and its serialized args string.
 * @param {() => void}                                     props.onCancel     Runs on cancel, ESC, and a mousedown outside the panel.
 * @return {import('react').ReactNode} The dialog.
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
					className={ primaryButtonClass( ! valid ) }
					onClick={ submit }
					disabled={ ! valid }
				>
					{ __( 'Add', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}
