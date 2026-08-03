/**
 * DraftContext — the draft document's React seam.
 *
 * Two doors, one per concern, and the split is the same one `Draft_Node` will
 * have in Stage 2:
 *
 *   - `dispatch( action )` MUTATES. Action types are TSL verbs; every one
 *     routes through `draftReducer`. This is the only way the document changes.
 *   - `setDraft( document )` LOADS. Opening a topology, discarding, uploading a
 *     .tsl — the whole document is replaced. That is not a verb, and dressing it
 *     as one would put a word in the grammar no topology can contain.
 *
 * The provider carries the document; it does not own it. TopologyConsole still
 * holds the state because it owns the load door too. Ownership moves when a
 * `Draft_Node` takes it.
 */

import {
	createContext,
	useContext,
	useCallback,
	useMemo,
} from '@wordpress/element';
import { draftReducer } from './utils/draftReducer';

const DraftContext = createContext( null );

/**
 * Bind a `setDraft` state setter to the reducer.
 *
 * @param {Function} setDraft React state setter for the draft document.
 * @return {Function} `dispatch( action )` — stable while `setDraft` is.
 */
export function useDraftDispatch( setDraft ) {
	return useCallback(
		( action ) => setDraft( ( graph ) => draftReducer( graph, action ) ),
		[ setDraft ]
	);
}

/**
 * `baseline` deliberately does NOT ride along. `draftIsDirty` compares the two,
 * but that comparison lives with the load door in TopologyConsole, and carrying
 * it here would re-render every consumer on a save for data none of them read.
 *
 * @param {Object}   props          Component props.
 * @param {Object}   props.draft    The working document.
 * @param {Function} props.dispatch From `useDraftDispatch`.
 * @param {*}        props.children Consumers.
 * @return {Element} The provider.
 */
export function DraftProvider( { draft, dispatch, children } ) {
	const value = useMemo( () => ( { draft, dispatch } ), [ draft, dispatch ] );
	return (
		<DraftContext.Provider value={ value }>
			{ children }
		</DraftContext.Provider>
	);
}

/**
 * @return {{draft: Object, dispatch: Function}} The document.
 */
export function useDraft() {
	const value = useContext( DraftContext );
	if ( ! value ) {
		// Loud: a default here would read as "the topology is empty".
		throw new Error( 'useDraft called outside a DraftProvider' );
	}
	return value;
}
