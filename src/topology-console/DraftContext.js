/**
 * DraftContext — the draft document's editor surface.
 *
 * The document has two faces, and only one of them is TSL.
 *
 * The COMMAND face is the grammar: `run( line )` sends the same line live mode
 * sends, and the only difference is which interpreter receives it — a cwd.
 *
 * The EDITOR face is everything an editor needs that TSL cannot say, plus the
 * one thing it can say only a line at a time. One rule covers it:
 *
 *   **TSL edits one thing per line; an editor holds the whole map.**
 *
 * `command_node` only ever appends and has no removal spelling, so "these are
 * now the verbs" needs `replaceVerbs`. `secure` sets a level and a bare
 * `secure` means 1, while `insecure` declares a third state rather than
 * removing the line, so "undeclared" needs `clearSecure`. `replaceFrontmatter`
 * is the weaker case: `var <name> =` DOES delete, so it is expressible as a
 * diff — it stays because the settings panel holds the whole map already.
 * `load` replaces a whole document, which is why loading is not a verb either.
 *
 * This module IS that editor face. Nothing outside it touches the interpreter:
 * a consumer that reached past these operations would be inventing a second,
 * undocumented way to change the document, which is how the last one drifted.
 *
 * `graph` is a READ of the interpreter, re-derived after every change. The
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
import { withResolvedConfigEdges } from './utils/consoleGraph';

const DraftContext = createContext( null );

/**
 * Own a draft document and expose its editor surface.
 *
 * @return {Object} `{ graph, run, load, reseed, dump, replaceVerbs,
 *                     replaceFrontmatter, clearSecure, setCatalog,
 *                     assertResolved, revertIncludes }`.
 */
export function useDraftInterpreter() {
	const ref = useRef( null );
	if ( null === ref.current ) {
		// It names itself `_command_interpreter` in a registry of its own.
		ref.current = new DraftInterpreterNode();
	}
	const [ graph, setGraph ] = useState( () => draftToGraph( ref.current ) );

	// Every mutation ends here, so every mutation re-reads exactly once.
	const commit = useCallback( () => {
		const next = draftToGraph( ref.current );
		setGraph( next );
		return next;
	}, [] );

	// Returns the graph, for the caller that also records a dirty snapshot.
	const run = useCallback(
		( line ) => {
			ref.current.run( line );
			return commit();
		},
		[ commit ]
	);

	const load = useCallback(
		( tsl, expansion = null, configEdges = null ) => {
			ref.current.load( tsl, expansion, configEdges );
			return commit();
		},
		[ commit ]
	);

	/**
	 * Re-run this document against a different include expansion.
	 *
	 * Dumping against the expansion it was loaded with and loading against the
	 * new one is what keeps the document while its borrowed half changes.
	 */
	const reseed = useCallback(
		( from, to ) => {
			ref.current.load(
				ref.current.dumpDocument( from ),
				to,
				ref.current.resolvedConfigEdges
			);
			return commit();
		},
		[ commit ]
	);

	const dump = useCallback(
		( expansion = null ) => ref.current.dumpDocument( expansion ),
		[]
	);

	const replaceVerbs = useCallback(
		( name, invocations ) => {
			ref.current.replaceInvocations( name, invocations );
			return commit();
		},
		[ commit ]
	);

	const replaceFrontmatter = useCallback(
		( map ) => {
			ref.current.replaceFrontmatter( map );
			return commit();
		},
		[ commit ]
	);

	const clearSecure = useCallback( () => {
		ref.current.clearSecureLevel();
		return commit();
	}, [ commit ] );

	// Which classes fan out, and which verb arguments are node references.
	const setCatalog = useCallback( ( classes ) => {
		ref.current.catalog = classes || [];
	}, [] );

	/**
	 * Throw when a `<ns:key>` config target has no resolved edge to name — the
	 * SAME guard the live seed applies, over the same composed graph, so the
	 * editor and the canvas cannot disagree about which file is loadable.
	 *
	 * Only a load that HAD a server response can check this; an uploaded file
	 * carries tokens nothing client-side can resolve, and always did.
	 */
	const assertResolved = useCallback( ( configEdges ) => {
		withResolvedConfigEdges( draftToGraph( ref.current ), configEdges );
	}, [] );

	/**
	 * Expand-error backstop: drop the includes the last good tree lacks.
	 *
	 * Commits only when an include actually WENT. Committing regardless makes
	 * a new graph on every call, and a caller re-running on graph identity
	 * would then spin — which is what a persistent expand error does.
	 *
	 * @param {Object} lastGood `topologies expand`'s last good `tree`.
	 * @return {?Object} The new graph, or null when nothing was removed.
	 */
	const revertIncludes = useCallback(
		( lastGood ) => {
			const good = lastGood || {};
			const stale = ref.current.includes.filter(
				( name ) => ! ( name in good )
			);
			if ( ! stale.length ) {
				return null;
			}
			for ( const name of stale ) {
				ref.current.run( `remove_include ${ name }` );
			}
			return commit();
		},
		[ commit ]
	);

	return useMemo(
		() => ( {
			graph,
			run,
			load,
			reseed,
			dump,
			replaceVerbs,
			replaceFrontmatter,
			clearSecure,
			setCatalog,
			assertResolved,
			revertIncludes,
		} ),
		[
			graph,
			run,
			load,
			reseed,
			dump,
			replaceVerbs,
			replaceFrontmatter,
			clearSecure,
			setCatalog,
			assertResolved,
			revertIncludes,
		]
	);
}

/**
 * @param {Object} props          Component props.
 * @param {Object} props.draft    From `useDraftInterpreter`.
 * @param {*}      props.children Consumers.
 * @return {import('react').ReactElement} The provider.
 */
export function DraftProvider( { draft, children } ) {
	return (
		<DraftContext.Provider value={ draft }>
			{ children }
		</DraftContext.Provider>
	);
}

/**
 * @return {Object} The document's editor surface.
 */
export function useDraft() {
	const value = useContext( DraftContext );
	if ( ! value ) {
		// Loud: a default here would read as "the topology is empty".
		throw new Error( 'useDraft called outside a DraftProvider' );
	}
	return value;
}
