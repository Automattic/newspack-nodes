/**
 * DraftContext — the draft document's React seam.
 *
 * Two doors, one per concern, and they are the two an interpreter has:
 *
 *   - `run( line )` MUTATES, and takes a TSL LINE. The same line live mode
 *     sends; the only difference is which interpreter receives it, which is a
 *     cwd. This is the only way the document changes.
 *   - `load( tsl, expansion )` REPLACES. Opening a topology, discarding,
 *     uploading a .tsl. Loading is not a verb, and dressing it as one would put
 *     a word in the grammar no topology can contain.
 *
 * `graph` is a READ of the interpreter, re-derived after every run. The
 * interpreter is the document; the graph is what the canvas draws.
 */

import {
	createContext,
	useContext,
	useCallback,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { DraftInterpreterNode } from '../runtime/draft-interpreter-node';
import { draftToGraph } from './utils/draftToGraph';

const DraftContext = createContext( null );

/**
 * Own a draft interpreter and the graph read off it.
 *
 * @return {{interpreter: Object, graph: Object, run: Function, load: Function}}
 *         The document and its two doors.
 */
export function useDraftInterpreter() {
	const ref = useRef( null );
	if ( null === ref.current ) {
		// UNNAMED: nothing routes to a draft, and a name would collide.
		ref.current = new DraftInterpreterNode();
	}
	const [ graph, setGraph ] = useState( () => draftToGraph( ref.current ) );

	// Both return the graph, for the caller that also records a baseline.
	const run = useCallback( ( line ) => {
		ref.current.run( line );
		const next = draftToGraph( ref.current );
		setGraph( next );
		return next;
	}, [] );

	const load = useCallback( ( tsl, expansion = null, configEdges = null ) => {
		ref.current.load( tsl, expansion, configEdges );
		const next = draftToGraph( ref.current );
		setGraph( next );
		return next;
	}, [] );

	return useMemo(
		() => ( { interpreter: ref.current, graph, run, load } ),
		[ graph, run, load ]
	);
}

/**
 * @param {Object} props          Component props.
 * @param {Object} props.draft    From `useDraftInterpreter`.
 * @param {*}      props.children Consumers.
 * @return {Element} The provider.
 */
export function DraftProvider( { draft, children } ) {
	return (
		<DraftContext.Provider value={ draft }>
			{ children }
		</DraftContext.Provider>
	);
}

/**
 * @return {{interpreter: Object, graph: Object, run: Function, load: Function}}
 *         The document.
 */
export function useDraft() {
	const value = useContext( DraftContext );
	if ( ! value ) {
		// Loud: a default here would read as "the topology is empty".
		throw new Error( 'useDraft called outside a DraftProvider' );
	}
	return value;
}
