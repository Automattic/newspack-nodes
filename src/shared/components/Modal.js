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
 * The close a dialog shell plays its exit through, which `ModalHeader`'s close
 * button runs. `ModalBox` provides it from the shell's `useDialog`, or null
 * for a shell without `onClose`, which stays open until its caller unmounts
 * it.
 *
 * @type {import('react').Context<(() => void)|null>}
 */
export const ModalClose = createContext( null );

/**
 * The one dialog header: the title, then any `actions`, then an icon close
 * button, as siblings of the canonical `.newspack-nodes-modal__header`, whose
 * row layout, title type and close geometry the shared `_modal.scss` owns.
 * The title names the dialog, through the id `ModalTitleId` provides, and
 * holds one line, ellipsised, with its whole text in its `title` attribute.
 * A dialog that focuses its close button first hands `closeRef` in.
 *
 * The close button draws when the shell can be dismissed, and plays the
 * shell's close: the exit and then the shell's own `onClose`. A shell without
 * `onClose` provides a null `ModalClose`, so its header draws no close.
 * `compact` is the second header style, for consoles, confirms and pickers.
 *
 * `closeLabel` defaults to the substrate's "Close", which only a substrate
 * bundle translates; a consumer hands in its own, translated in its own text
 * domain, as it does `LogStreamViewer`'s `pickerLabel`.
 *
 * @param {Object}                                 props
 * @param {string}                                 props.title        The dialog's title, and its name.
 * @param {import('react').Ref<HTMLButtonElement>} [props.closeRef]   Takes the close button.
 * @param {string}                                 [props.closeLabel] The close button's name.
 * @param {import('react').ReactNode}              [props.actions]    Rendered between the title and the close.
 * @param {boolean}                                [props.compact]    The compact header style.
 * @return {import('react').ReactElement} The header.
 * @throws {Error} Outside a dialog providing `ModalTitleId`, which would be left unnamed.
 */
export function ModalHeader( {
	title,
	closeRef,
	closeLabel = __( 'Close', 'newspack-nodes' ),
	actions,
	compact = false,
} ) {
	const titleId = useContext( ModalTitleId );
	const close = useContext( ModalClose );
	if ( null === titleId ) {
		throw new Error(
			'ModalHeader renders inside a dialog that provides ModalTitleId'
		);
	}
	return (
		<div
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
		</div>
	);
}

/**
 * The shared plain-DOM modal shell (no `@wordpress/components`): a backdrop and
 * a `dialog` (or `alertdialog`) box carrying the canonical `.newspack-nodes-modal`
 * role and its `--<size>` modifier, so every dashboard's dialog looks identical
 * without declaring its own selectors.
 *
 * ESC and a mousedown on the backdrop close it, through the shared
 * `useDialog`, and only while it is the topmost open dialog, so a dialog
 * opened from another closes alone. An ESC something inside already took, and
 * a press in a popover the dialog opened, leave it open. A press on the
 * backdrop never moves focus out of the box. Every close plays the exit: the
 * backdrop wears `is-closing`, and `onClose` runs once the animation has had
 * its time, the box `inert` meanwhile, so an exiting dialog takes no click
 * and no focus.
 * A caller closes the same way through `handleRef.current.close()`, or through
 * `closeWith( run )` to run `run` in place of `onClose`; only the first close
 * counts. Without `onClose` nothing dismisses it. The backdrop covers the
 * viewport and stays `role="presentation"`: its mousedown is a pointer
 * shortcut for the ESC the keyboard already has, which `useDialog` listens
 * for rather than a handler on the element.
 *
 * It renders through `BodyPortal`, which is what lets a dialog cover the
 * `@wordpress/components` modal it was summoned from.
 *
 * First focus goes to the title, or to the box without one, unless a field
 * inside the dialog focused itself on mount, which wins: each dialog can
 * focus the element that fits it. A close the caller declines puts focus
 * back the same way, unless another dialog stands above it. `useFocusTrap` keeps Tab inside the box, from the
 * title or the box as from any control, and hands focus back on close to the
 * element `returnFocus` holds, else to the opener. Only the topmost dialog
 * traps Tab.
 *
 * Given `onSubmit`, the box itself is the dialog's `<form>` (see
 * `submitProps`), so Enter in a field runs the default action; the caller's
 * primary button is then `type="submit"` and every other button
 * `type="button"`.
 *
 * @param {Object}                                                props
 * @param {string}                                                [props.ariaLabel]         The name of a dialog with no `ModalHeader`;
 *                                                                                          one headed by it is named by its title.
 * @param {string}                                                [props.ariaDescribedby]   The id of the element that describes the
 *                                                                                          dialog, such as an alert's message.
 * @param {() => void}                                            [props.onClose]           Runs once a close (ESC, backdrop, header close,
 *                                                                                          handle) has played the exit; omitted, the
 *                                                                                          dialog cannot be dismissed.
 * @param {string}                                                [props.size]              `medium`, the default, or `large`.
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
	ariaDescribedby,
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
	const backdropRef = useRef( null );
	const { closing, close } = useDialog( dialogRef, onClose, {
		handleRef,
		returnFocus,
		backdropRef,
	} );

	return (
		<BodyPortal>
			<div
				className={ classes(
					'newspack-nodes-modal__backdrop',
					closing && 'is-closing',
					backdropClassName
				) }
				ref={ backdropRef }
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
					ariaDescribedby={ ariaDescribedby }
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
 * @param {import('react').Ref<any>}      props.boxRef            Takes the box, a `div` or a `form`, as `useDialog`'s `ref`.
 * @param {boolean}                       props.closing           `useDialog`'s `closing`.
 * @param {(() => void)|null}             props.close             `useDialog`'s `close`, null for a box that stays open until its caller unmounts it.
 * @param {string}                        props.className         The box's classes.
 * @param {string}                        [props.role]            `dialog`, or `alertdialog` for a refusal.
 * @param {string}                        [props.ariaLabel]       The name of a box with no `ModalHeader`.
 * @param {string}                        [props.ariaDescribedby] The id of the element that describes the box.
 * @param {() => void}                    [props.onSubmit]        The default action; makes the box a form.
 * @param {import('react').CSSProperties} [props.style]           Inline style on the box.
 * @param {import('react').ReactNode}     props.children          The header and body.
 * @return {import('react').ReactElement} The box.
 */
export function ModalBox( {
	boxRef,
	closing,
	close,
	className,
	role = 'dialog',
	ariaLabel,
	ariaDescribedby,
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
			tabIndex={ -1 }
			// React 18 writes an unknown attribute as its string.
			inert={ closing ? '' : undefined }
			aria-modal="true"
			aria-label={ ariaLabel }
			aria-labelledby={ ariaLabel ? undefined : titleId }
			aria-describedby={ ariaDescribedby }
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
			<ModalHeader title={ title } compact />
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
