import {
	createContext,
	createPortal,
	useContext,
	useEffect,
	useId,
	useRef,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useDismissable } from '../hooks/useDismissable';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { primaryButtonClass } from '../utils/buttonClass';
import { submitProps } from '../utils/submitProps';
import CloseIcon from './CloseIcon';
import './Modal.scss';

/**
 * The body-level host every shared dialog renders through: a portal onto
 * `document.body` behind a `display: contents` root wearing the skin classes.
 *
 * A caller's box is routinely a stacking context — a dashboard shell is
 * `position: fixed; z-index: 99` — and a z-index inside one ranks only against
 * its siblings there, so a dialog that must cover a `@wordpress/components`
 * modal portalled to the body at 100000 cannot win from inside the tree. Out
 * here it can. The skin tokens resolve at `<html>`, but the type and colour
 * rules key off those class names, so the host wears them; `display: contents`
 * keeps it from adding a box between `<body>` and what it carries.
 *
 * @param {Object}                    props
 * @param {import('react').ReactNode} props.children What to render at body level.
 * @return {import('react').ReactNode} The portal, or null where there is no document.
 */
export function ModalPortal( { children } ) {
	if ( 'undefined' === typeof document ) {
		return null;
	}

	return createPortal(
		<div
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ { display: 'contents' } }
		>
			{ children }
		</div>,
		document.body
	);
}

/**
 * The id a dialog shell names itself by: the shell points `aria-labelledby`
 * at it, and the `ModalHeader` inside gives it to its title. `Modal` provides
 * it; a shell that draws its own box provides `useId()` the same way.
 *
 * @type {import('react').Context<string|null>}
 */
export const ModalTitleId = createContext( null );

/**
 * The one dialog header: the title, then an icon button running `onClose`,
 * as siblings of the canonical `.newspack-nodes-modal__header`, whose row
 * layout, title type and close geometry the shared `_modal.scss` owns. The
 * title names the dialog, through the id `ModalTitleId` provides, and holds
 * one line, ellipsised, with its whole text in its `title` attribute. A
 * dialog that focuses its close button first hands `closeRef` in.
 *
 * `closeLabel` defaults to the substrate's "Close", which only a substrate
 * bundle translates; a consumer hands in its own, translated in its own text
 * domain, as it does `LogStreamViewer`'s `pickerLabel`.
 *
 * @param {Object}                                 props
 * @param {string}                                 props.title        The dialog's title, and its name.
 * @param {() => void}                             props.onClose      Runs on a click of the close button.
 * @param {import('react').Ref<HTMLButtonElement>} [props.closeRef]   Takes the close button.
 * @param {string}                                 [props.closeLabel] The close button's name.
 * @return {import('react').ReactElement} The header.
 * @throws {Error} Outside a dialog providing `ModalTitleId`, which would be left unnamed.
 */
export function ModalHeader( {
	title,
	onClose,
	closeRef,
	closeLabel = __( 'Close', 'newspack-nodes' ),
} ) {
	const titleId = useContext( ModalTitleId );
	if ( null === titleId ) {
		throw new Error(
			'ModalHeader renders inside a dialog that provides ModalTitleId'
		);
	}
	return (
		<header className="newspack-nodes-modal__header">
			<h2
				id={ titleId }
				className="newspack-nodes-modal__title"
				title={ title }
				tabIndex={ -1 }
			>
				{ title }
			</h2>
			<button
				type="button"
				ref={ closeRef }
				className="newspack-nodes-modal__close"
				aria-label={ closeLabel }
				onClick={ onClose }
			>
				<CloseIcon />
			</button>
		</header>
	);
}

/**
 * The shared plain-DOM modal shell (no `@wordpress/components`): a backdrop and
 * a `role="dialog"` box carrying the canonical `.newspack-nodes-modal` role, so
 * every dashboard's dialog looks identical without declaring its own selectors.
 *
 * ESC and a mousedown outside the box invoke `onClose`, both through the shared
 * `useDismissable`. The backdrop covers the viewport and carries no handler of
 * its own, which is what keeps it `role="presentation"`: a click handler there
 * would make it interactive, and an interactive element owes the keyboard the
 * equivalent ESC already provides.
 *
 * It renders through `ModalPortal`, which is what lets a dialog cover the
 * `@wordpress/components` modal it was summoned from.
 *
 * Callers own their own initial focus, so each dialog can focus the element
 * that fits it; `useFocusTrap` keeps Tab inside the box and hands focus back
 * to the opener on close.
 *
 * Given `onSubmit`, the box itself is the dialog's `<form>` (see
 * `submitProps`), so Enter in a field runs the default action; the caller's
 * primary button is then `type="submit"` and every other button
 * `type="button"`.
 *
 * @param {Object}                    props
 * @param {string}                    [props.ariaLabel]         The name of a dialog with no `ModalHeader`;
 *                                                              one headed by it is named by its title.
 * @param {() => void}                props.onClose             Dismiss handler (ESC / backdrop).
 * @param {string}                    [props.className]         Extra classes on the dialog box.
 * @param {string}                    [props.backdropClassName] Extra classes on the BACKDROP — where
 *                                                              `position`/`z-index` live, so a dialog
 *                                                              opened over another modal layer raises
 *                                                              itself here.
 * @param {() => void}                [props.onSubmit]          The default action; makes the box a form.
 * @param {import('react').ReactNode} props.children            Dialog body.
 * @return {import('react').ReactElement} The modal.
 */
export default function Modal( {
	ariaLabel,
	onClose,
	className = '',
	backdropClassName = '',
	onSubmit,
	children,
} ) {
	const dialogRef = useRef( null );
	const titleId = useId();
	useDismissable( dialogRef, onClose );
	useFocusTrap( dialogRef );
	const Box = onSubmit ? 'form' : 'div';

	return (
		<ModalPortal>
			<div
				className={ `newspack-nodes-modal__backdrop ${ backdropClassName }`.trim() }
				role="presentation"
			>
				<Box
					ref={ dialogRef }
					className={ `newspack-nodes-modal ${ className }`.trim() }
					role="dialog"
					aria-modal="true"
					aria-label={ ariaLabel }
					aria-labelledby={ ariaLabel ? undefined : titleId }
					{ ...( onSubmit && submitProps( onSubmit ) ) }
				>
					<ModalTitleId.Provider value={ titleId }>
						{ children }
					</ModalTitleId.Provider>
				</Box>
			</div>
		</ModalPortal>
	);
}

/**
 * A question whose yes loses work, its safe answer focused: the shared
 * dialog headed by its question, the yes painted as danger.
 *
 * @param {Object}     props
 * @param {string}     props.title  The question.
 * @param {string}     [props.body] What the yes costs.
 * @param {string}     props.yes    The yes button.
 * @param {string}     props.no     The safe button.
 * @param {() => void} props.onYes  Runs on the yes.
 * @param {() => void} props.onNo   Runs on the safe answer, ESC or a click outside.
 * @return {import('react').ReactElement} The dialog.
 */
export function Confirm( { title, body, yes, no, onYes, onNo } ) {
	const noRef = useRef( null );
	useEffect( () => noRef.current?.focus(), [] );
	return (
		<Modal onClose={ onNo }>
			<ModalHeader title={ title } onClose={ onNo } />
			{ body && <p>{ body }</p> }
			<div className="newspack-nodes-modal__actions">
				<button
					type="button"
					ref={ noRef }
					className="button"
					onClick={ onNo }
				>
					{ no }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( false, 'is-danger' ) }
					onClick={ onYes }
				>
					{ yes }
				</button>
			</div>
		</Modal>
	);
}
