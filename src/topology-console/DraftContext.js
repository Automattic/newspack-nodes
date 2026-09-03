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
 * undocumented way to change the document, and two spellings drift apart.
 *
 * `graph` is a READ of the interpreter, re-derived after every change. The
 * interpreter is the document; the graph is what the canvas draws.
 *
 * The document also knows whether it has diverged from what is stored. That
 * baseline lives here because it is a property of the document: held outside,
 * every operation that replaces or writes the document has to re-establish it,
 * and one that forgets leaves the editor claiming unsaved changes to a
 * document already on disk.
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

/**
 * One `command_node` statement a node carries, declared or seeded.
 *
 * @typedef {import('../runtime/draft-interpreter-node').Invocation} Invocation
 */

/**
 * The editor surface a `DraftProvider` publishes to the console's tree; null
 * until one does, which is what `useDraft` refuses on.
 */
const DraftContext = createContext( null );

/**
 * Own a draft document and expose its editor surface.
 *
 * @return {Object} `{ graph, isDirty, markSaved, run, load, reseed, dump,
 *                     replaceVerbs, replaceFrontmatter, clearSecure,
 *                     setCatalog, assertResolved, revertIncludes }`.
 */
export function useDraftInterpreter() {
	const ref = useRef( null );
	if ( null === ref.current ) {
		// It names itself `_command_interpreter` in a registry of its own.
		ref.current = new DraftInterpreterNode();
	}
	const [ graph, setGraph ] = useState( () => draftToGraph( ref.current ) );
	// What the document last equalled on disk.
	const [ baseline, setBaseline ] = useState( () =>
		JSON.stringify( draftToGraph( ref.current ) )
	);

	/**
	 * Re-read the interpreter into a graph and publish it.
	 *
	 * Every mutation ends here, so every mutation re-reads exactly once.
	 *
	 * @return {Object} The new graph.
	 */
	const commit = useCallback( () => {
		const next = draftToGraph( ref.current );
		setGraph( next );
		return next;
	}, [] );

	/**
	 * Run one TSL line against the draft interpreter, exactly as live mode runs
	 * it against the live one.
	 *
	 * @param {string} line One statement, or several the Shell's `;` split
	 *                      separates.
	 * @return {Object} The new graph, as every mutator returns.
	 */
	const run = useCallback(
		( line ) => {
			ref.current.run( line );
			return commit();
		},
		[ commit ]
	);

	/**
	 * Replace the whole document. A loaded document IS its baseline — that is
	 * what makes the load clean — unless it came from somewhere with no stored
	 * copy to be equal to, which is an upload.
	 *
	 * @param {string}  tsl         The document source.
	 * @param {?Object} expansion   Include expansion, or null.
	 * @param {?Array}  configEdges Resolved config edges, or null.
	 * @param {Object}  [opts]      `stored: false` for an upload, which has no
	 *                              stored copy to be equal to.
	 * @return {Object} The new graph.
	 */
	const load = useCallback(
		(
			tsl,
			expansion = null,
			configEdges = null,
			{ stored = true } = {}
		) => {
			ref.current.load( tsl, expansion, configEdges );
			const next = commit();
			// null matches no serialization: an unstored document is dirty.
			setBaseline( stored ? JSON.stringify( next ) : null );
			return next;
		},
		[ commit ]
	);

	/**
	 * The document was written. The caller passes what it SENT: the reply lands
	 * seconds later with the canvas live throughout, so baselining whatever is
	 * here on reply would adopt an edit made in flight as already saved.
	 *
	 * @param {string} written Serialization of the graph that was written.
	 */
	const markSaved = useCallback( ( written ) => {
		setBaseline( written );
	}, [] );

	/**
	 * Whether the document differs from what was last stored.
	 *
	 * One serialization per mutation, not per render.
	 */
	const isDirty = useMemo(
		() => JSON.stringify( graph ) !== baseline,
		[ graph, baseline ]
	);

	/**
	 * Re-run this document against a different include expansion.
	 *
	 * Dumping against the expansion it was loaded with and loading against the
	 * new one is what keeps the document while its borrowed half changes.
	 *
	 * @param {?Object} from The expansion the document currently holds.
	 * @param {?Object} to   The expansion to seed the reload from.
	 * @return {Object} The new graph.
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

	/**
	 * The document as TSL, in the order a topology file requires.
	 *
	 * @param {?Object} expansion The expansion a fresh load starts from; omit
	 *                            it for a document that includes nothing.
	 * @return {string} TSL, or '' for an empty document.
	 */
	const dump = useCallback(
		( expansion = null ) => ref.current.dumpDocument( expansion ),
		[]
	);

	/**
	 * Declare a node's whole verb set. `command_node` only appends, so a removal
	 * has no line to write.
	 *
	 * @param {string}       name        Node name.
	 * @param {Invocation[]} invocations Its whole declared set.
	 * @return {Object} The new graph.
	 */
	const replaceVerbs = useCallback(
		( name, invocations ) => {
			ref.current.replaceInvocations( name, invocations );
			return commit();
		},
		[ commit ]
	);

	/**
	 * Replace the whole frontmatter map.
	 *
	 * @param {Object} map Name to value.
	 * @return {Object} The new graph.
	 */
	const replaceFrontmatter = useCallback(
		( map ) => {
			ref.current.replaceFrontmatter( map );
			return commit();
		},
		[ commit ]
	);

	/**
	 * Undeclare `secure`. Its absence has no TSL spelling, because `insecure`
	 * declares a third state rather than removing the line.
	 *
	 * @return {Object} The new graph.
	 */
	const clearSecure = useCallback( () => {
		ref.current.clearSecureLevel();
		return commit();
	}, [ commit ] );

	/**
	 * Hand the interpreter its class catalog: which classes fan out, and which
	 * verb arguments are node references.
	 *
	 * @param {?Array} classes Class records, as `classes list` returns them.
	 */
	const setCatalog = useCallback( ( classes ) => {
		ref.current.catalog = classes || [];
	}, [] );

	/**
	 * Throw when a `<ns:key>` config target has no resolved edge to name — the
	 * SAME guard the live seed applies, over the same composed graph, so the
	 * editor and the canvas cannot disagree about which file is loadable.
	 *
	 * Only a load with a server response can check this; an uploaded file
	 * carries tokens nothing client-side can resolve.
	 *
	 * @param {?Array} configEdges Server-resolved `<ns:key>` targets.
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
	 * @param {?Object} lastGood `topologies expand`'s last good `tree`.
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
			isDirty,
			markSaved,
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
			isDirty,
			markSaved,
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
 * Publish one draft's editor surface to everything below it.
 *
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
 * Read the draft document's editor surface from context.
 *
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
