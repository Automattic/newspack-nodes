/**
 * CompositionEditSlot — the place on a page where a context's layout editor
 * renders once the editor's bundle has registered it.
 *
 * It renders nothing until then, so on a reader's page, which never loads
 * the editor bundle, the slot shows nothing and costs no editor script.
 */

import { useCallback, useSyncExternalStore } from '@wordpress/element';
import {
	compositionEditor,
	subscribeCompositionEditors,
} from './editorRegistry';

/**
 * @param {Object} props
 * @param {string} props.context A declared context, `<namespace>/<name>`.
 * @return {?import('react').ReactElement} The registered editor with the rest of the props, or nothing.
 */
export default function CompositionEditSlot( { context, ...props } ) {
	const read = useCallback( () => compositionEditor( context ), [ context ] );
	const Editor = useSyncExternalStore( subscribeCompositionEditors, read );
	return Editor ? <Editor { ...props } /> : null;
}
