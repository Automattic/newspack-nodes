/**
 * What a block on a composed page reads besides its attributes: the page it
 * stands on, which the consumer shapes and the substrate never reads past
 * `canTune`, `onRestored` and `group`; and whether its layout is being
 * edited, in which case every write control the block holds is inert, so
 * editing a layout writes nothing else.
 */

import { createContext, useContext } from '@wordpress/element';

/**
 * The page a composed layout stands on: the consumer's own object, carrying
 * at least these three.
 *
 * @typedef {Object} ComposedPageValue
 * @property {string}                   group      The surface the page's commands are sent for.
 * @property {boolean}                  canTune    Whether the reader may curate the layout.
 * @property {(layout: Object) => void} onRestored Takes the default a curator's restore answers.
 */

/** Does nothing, as a write control does while its layout is edited. */
const nothing = () => {};

/** @type {import('react').Context<?ComposedPageValue>} */
export const ComposedPage = createContext( null );

/**
 * Whether the block a control stands in is being edited, as the substrate
 * handed its View `editing`.
 *
 * @type {import('react').Context<boolean>}
 */
export const Editing = createContext( false );

/**
 * The page the block this stands in stands on.
 *
 * @return {ComposedPageValue} The consumer's page object.
 * @throws {Error} When the block stands outside every `ComposedPage`.
 */
export function usePage() {
	const page = useContext( ComposedPage );
	if ( null === page ) {
		throw new Error( 'usePage() outside a ComposedPage' );
	}
	return page;
}

/**
 * Whether the block this stands in is being edited.
 *
 * @return {boolean} Whether it is.
 */
export const useEditing = () => useContext( Editing );

/**
 * A write control's props: `onClick` while the layout is read, and while it
 * is edited `aria-disabled` with a click that does nothing, so the control
 * keeps its place and focus.
 *
 * @param {() => void} onClick The write.
 * @return {{onClick: () => void, 'aria-disabled'?: true}} The control's props.
 */
export function useWriteControl( onClick ) {
	return useEditing()
		? { 'aria-disabled': true, onClick: nothing }
		: { onClick };
}
