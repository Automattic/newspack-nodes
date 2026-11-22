import {
	createContext,
	createPortal,
	useContext,
	useEffect,
	useId,
	useRef,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useDialog } from '../hooks/useDialog';
import { primaryButtonClass } from '../utils/buttonClass';
import { submitProps } from '../utils/submitProps';
import CloseIcon from './CloseIcon';
import { SKIN_ROOT_CLASSES } from './ThemedRoot';
import './Modal.scss';

/**
 * The class attribute for the names given, falsy ones skipped.
 *
 * @param {...(string|false|undefined)} names Class names.
 * @return {string} The names, space-separated.
 */
export const classes = ( ...names ) => names.filter( Boolean ).join( ' ' );

/**
 * The body-level host for what must paint above every box on the page: a
 * portal onto `document.body` behind a `display: contents` root wearing the
 * skin classes.
 *
 * A caller's box is routinely a stacking context — a dashboard shell is
 * `position: fixed; z-index: 99` — and a z-index inside one ranks only against
 * its siblings there, so what must cover a `@wordpress/components` modal
 * portalled to the body at 100000 cannot win from inside the tree. Out here
 * it can. The skin tokens resolve at `<html>`, but the type and colour
 * rules key off those class names, so the host wears them; `display: contents`
 * keeps it from adding a box between `<body>` and what it carries.
 *
 * @param {Object}                    props
 * @param {import('react').ReactNode} props.children What to render at body level.
 * @return {import('react').ReactNode} The portal, or null where there is no document.
 */
export function BodyPortal( { children } ) {
	if ( 'undefined' === typeof document ) {
		return null;
	}

	return createPortal(
		<div className={ SKIN_ROOT_CLASSES } style={ { display: 'contents' } }>
			{ children }
		</div>,
		document.body
	);
}

/**
 * The id a dialog shell names itself by: the box points `aria-labelledby` at
 * it, and the `ModalHeader` inside gives it to its title. `ModalBox` provides
 * it from its own `useId()`, for `Modal` and the console's `ModalShell`
 * alike.
 *
 * @type {import('react').Context<string|null>}
 */
export const ModalTitleId = createContext( null );

/**
 * The close a dialog shell plays its exit through: `ModalHeader`'s close
 * button runs it in place of its own `onClose`. `ModalBox` provides it from
 * the shell's `useDialog`, or null for a shell without `onClose`, which stays
 * open until its caller unmounts it; outside every shell it is undefined.
 *
 * @type {import('react').Context<(() => void)|null|undefined>}
 */
export const ModalClose = createContext( undefined );

/**
 * The one dialog header: the title, then any `actions`, then an icon close
 * button, as siblings of the canonical `.newspack-nodes-modal__header`, whose
 * row layout, title type and close geometry the shared `_modal.scss` owns.
 * The title names the dialog, through the id `ModalTitleId` provides, and
 * holds one line, ellipsised, with its whole text in its `title` attribute.
 * A dialog that focuses its close button first hands `closeRef` in.
 *
 * Inside a shell, the close button draws when the shell can be dismissed, and
 * plays the shell's close: the exit and then the shell's own `onClose`. A
 * shell without `onClose` provides a null `ModalClose`, so its header draws
 * no close whatever `onClose` it is handed. Outside every shell the button
 * draws given `onClose`, and runs it at once. `compact` is the second header
 * style, for consoles, confirms and pickers.
 *
 * `closeLabel` defaults to the substrate's "Close", which only a substrate
 * bundle translates; a consumer hands in its own, translated in its own text
 * domain, as it does `LogStreamViewer`'s `pickerLabel`.
 *
 * @param {Object}                                 props
 * @param {string}                                 props.title        The dialog's title, and its name.
 * @param {() => void}                             [props.onClose]    Outside every shell, draws the close button and runs on its click.
 * @param {import('react').Ref<HTMLButtonElement>} [props.closeRef]   Takes the close button.
 * @param {string}                                 [props.closeLabel] The close button's name.
 * @param {import('react').ReactNode}              [props.actions]    Rendered between the title and the close.
 * @param {boolean}                                [props.compact]    The compact header style.
 * @return {import('react').ReactElement} The header.
 * @throws {Error} Outside a dialog providing `ModalTitleId`, which would be left unnamed.
 */
export function ModalHeader( {
	title,
	onClose,
	closeRef,
	closeLabel = __( 'Close', 'newspack-nodes' ),
	actions,
	compact = false,
} ) {
	const titleId = useContext( ModalTitleId );
	const shellClose = useContext( ModalClose );
	const close = undefined === shellClose ? onClose : shellClose;
	if ( null === titleId ) {
		throw new Error(
			'ModalHeader renders inside a dialog that provides ModalTitleId'
		);
	}
	return (
		<header
			className={ classes(
				'newspack-nodes-modal__header',
				compact && 'newspack-nodes-modal__header--compact'
			) }
		>
			<h2
				id={ titleId }
				className="newspack-nodes-modal__title"
				title={ title }
				tabIndex={ -1 }
			>
				{ title }
			</h2>
			{ actions && (
				<div className="newspack-nodes-modal__header-actions">
					{ actions }
				</div>
			) }
			{ close && (
				<button
					type="button"
					ref={ closeRef }
					className="newspack-nodes-modal__close"
					aria-label={ closeLabel }
					onClick={ close }
				>
					<CloseIcon />
				</button>
			) }
		</header>
	);
}

/**
 * The shared plain-DOM modal shell (no `@wordpress/components`): a backdrop and
 * a `dialog` (or `alertdialog`) box carrying the canonical `.newspack-nodes-modal`
 * role and its `--<size>` modifier, so every dashboard's dialog looks identical
 * without declaring its own selectors.
 *
 * ESC and a mousedown outside the box close it, through the shared
 * `useDialog`, and only while it is the topmost open dialog, so a dialog
 * opened from another closes alone. Every close plays the exit: the backdrop
 * wears `is-closing`, and `onClose` runs once the animation has had its time,
 * the box `inert` meanwhile, so an exiting dialog takes no click and no focus.
 * A caller closes the same way through `handleRef.current.close()`, or through
 * `closeWith( run )` to run `run` in place of `onClose`; only the first close
 * counts. Without `onClose` nothing dismisses it. The backdrop covers the
 * viewport and carries no handler of its own, which is what keeps it
 * `role="presentation"`: a click handler there would make it interactive, and
 * an interactive element owes the keyboard the equivalent ESC already
 * provides.
 *
 * It renders through `BodyPortal`, which is what lets a dialog cover the
 * `@wordpress/components` modal it was summoned from.
 *
 * Callers own their own initial focus, so each dialog can focus the element
 * that fits it; `useFocusTrap` keeps Tab inside the box and hands focus back
 * on close to the element `returnFocus` holds, else to the opener. Only the
 * topmost dialog traps Tab.
 *
 * Given `onSubmit`, the box itself is the dialog's `<form>` (see
 * `submitProps`), so Enter in a field runs the default action; the caller's
 * primary button is then `type="submit"` and every other button
 * `type="button"`.
 *
 * @param {Object}                                                props
 * @param {string}                                                [props.ariaLabel]         The name of a dialog with no `ModalHeader`;
 *                                                                                          one headed by it is named by its title.
 * @param {() => void}                                            [props.onClose]           Runs once a close (ESC, backdrop, header close,
 *                                                                                          handle) has played the exit; omitted, the
 *                                                                                          dialog cannot be dismissed.
 * @param {string}                                                [props.size]              `small`, `medium`, `large` or `fullscreen`.
 * @param {string}                                                [props.role]              `dialog`, or `alertdialog` for a refusal.
 * @param {{current: ?import('../hooks/useDialog').DialogHandle}} [props.handleRef]         Takes `{ close, closeWith }`, the animated close.
 * @param {string}                                                [props.className]         Extra classes on the dialog box.
 * @param {string}                                                [props.backdropClassName] Extra classes on the BACKDROP — where
 *                                                                                          `position`/`z-index` live, so a dialog
 *                                                                                          opened over another modal layer raises
 *                                                                                          itself here.
 * @param {() => void}                                            [props.onSubmit]          The default action; makes the box a form.
 * @param {{current: ?HTMLElement}}                               [props.returnFocus]       The element closing hands focus to, such as
 *                                                                                          the dialog's trigger, over what held focus
 *                                                                                          as it opened.
 * @param {import('react').ReactNode}                             props.children            Dialog body.
 * @return {import('react').ReactElement} The modal.
 */
export default function Modal( {
	ariaLabel,
	onClose,
	size = 'medium',
	role = 'dialog',
	handleRef,
	className = '',
	backdropClassName = '',
	onSubmit,
	returnFocus,
	children,
} ) {
	const dialogRef = useRef( null );
	const { closing, close } = useDialog( dialogRef, onClose, {
		handleRef,
		returnFocus,
	} );

	return (
		<BodyPortal>
			<div
				className={ classes(
					'newspack-nodes-modal__backdrop',
					closing && 'is-closing',
					backdropClassName
				) }
				role="presentation"
			>
				<ModalBox
					boxRef={ dialogRef }
					closing={ closing }
					close={ onClose ? close : null }
					className={ classes(
						'newspack-nodes-modal',
						`newspack-nodes-modal--${ size }`,
						className
					) }
					role={ role }
					ariaLabel={ ariaLabel }
					onSubmit={ onSubmit }
				>
					{ children }
				</ModalBox>
			</div>
		</BodyPortal>
	);
}

/**
 * The dialog box both shells draw, `Modal` and the console's `ModalShell`:
 * the role, `aria-modal`, its name, `inert` while closing, a `<form>` given
 * `onSubmit`, and the `ModalTitleId` and `ModalClose` its header reads. The
 * shell keeps its own classes, style and backdrop.
 *
 * @param {Object}                        props
 * @param {import('react').Ref<any>}      props.boxRef      Takes the box, a `div` or a `form`, as `useDialog`'s `ref`.
 * @param {boolean}                       props.closing     `useDialog`'s `closing`.
 * @param {(() => void)|null}             props.close       `useDialog`'s `close`, null for a box that stays open until its caller unmounts it.
 * @param {string}                        props.className   The box's classes.
 * @param {string}                        [props.role]      `dialog`, or `alertdialog` for a refusal.
 * @param {string}                        [props.ariaLabel] The name of a box with no `ModalHeader`.
 * @param {() => void}                    [props.onSubmit]  The default action; makes the box a form.
 * @param {import('react').CSSProperties} [props.style]     Inline style on the box.
 * @param {import('react').ReactNode}     props.children    The header and body.
 * @return {import('react').ReactElement} The box.
 */
export function ModalBox( {
	boxRef,
	closing,
	close,
	className,
	role = 'dialog',
	ariaLabel,
	onSubmit,
	style,
	children,
} ) {
	const titleId = useId();
	const Box = onSubmit ? 'form' : 'div';
	return (
		<Box
			ref={ boxRef }
			className={ className }
			role={ role }
			// React 18 writes an unknown attribute as its string.
			inert={ closing ? '' : undefined }
			aria-modal="true"
			aria-label={ ariaLabel }
			aria-labelledby={ ariaLabel ? undefined : titleId }
			style={ style }
			{ ...( onSubmit && submitProps( onSubmit ) ) }
		>
			<ModalTitleId.Provider value={ titleId }>
				<ModalClose.Provider value={ close }>
					{ children }
				</ModalClose.Provider>
			</ModalTitleId.Provider>
		</Box>
	);
}

/**
 * A question whose yes loses work, its safe answer focused: the shared
 * dialog headed by its question, the yes painted as danger.
 *
 * Each answer closes through the handle and runs once the exit has played;
 * the first close is the one that runs, and a close without a button (ESC,
 * outside, the header's close) answers no.
 *
 * @param {Object}     props
 * @param {string}     props.title  The question.
 * @param {string}     [props.body] What the yes costs.
 * @param {string}     props.yes    The yes button.
 * @param {string}     props.no     The safe button.
 * @param {() => void} props.onYes  Runs on the yes, once the exit has played.
 * @param {() => void} props.onNo   Runs on the safe answer, ESC or a click outside, once the exit has played.
 * @return {import('react').ReactElement} The dialog.
 */
export function Confirm( { title, body, yes, no, onYes, onNo } ) {
	const noRef = useRef( null );
	const handle = useRef( null );
	useEffect( () => noRef.current?.focus(), [] );
	return (
		<Modal onClose={ onNo } handleRef={ handle }>
			<ModalHeader title={ title } onClose={ onNo } compact />
			{ body && <p>{ body }</p> }
			<div className="newspack-nodes-modal__actions">
				<button
					type="button"
					ref={ noRef }
					className="button"
					onClick={ () => handle.current.close() }
				>
					{ no }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( false, 'is-danger' ) }
					onClick={ () => handle.current.closeWith( onYes ) }
				>
					{ yes }
				</button>
			</div>
		</Modal>
	);
}
