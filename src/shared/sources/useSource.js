/**
 * useSource — read a declared source under params, as every block on a page
 * does, so N blocks with equal params share one live source and one fetch.
 *
 * A live source is built by the substrate's own hooks: a poll by
 * `useBatchedPoll` and `addSliceFetcher`, a command by `useCommandRead`, a
 * stream by `useLogTailStream`, whose readers also get its view node and
 * controls. A hook runs only inside a component, so a
 * `SourcesProvider` renders one host per held key inside the page's own
 * tree, under its StrictMode and its boundaries, built by this bundle's
 * hooks. A block only holds its key and reads what the host publishes, so a
 * block unmounting never tears down a source another block still reads, and
 * a block remounting in the same commit holds the same graph again. The last
 * release unmounts the host, whose hook takes its nodes away. Each kind
 * pauses with a hidden tab as its hook does.
 *
 * `ComposedLayout` and `mountComposedEditor` render the provider; a page of
 * its own wraps its tree in `SourcesProvider`. A provider inside another
 * reuses the outer one's sources, so every layout on a page shares one fetch
 * per key. A bundle reads only the sources its own modules declare.
 *
 * A params change is a new key: the hook reads the new key's model at once,
 * empty until its own answer lands, and the old key's late answer reaches
 * only the old key's nodes, gone with its last holder.
 */

import {
	Component,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from '@wordpress/element';
import { useNodeField } from '@newspack-nodes/runtime';
import { useBatchedPoll } from '../hooks/useBatchedPoll';
import { useCommandRead } from '../hooks/useCommandRead';
import { useLogTailStream } from '../hooks/useLogTailStream';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import { sliceView } from '../nodes/slice-view-node';
import { errorMessage } from '../errorMessage';
import {
	acquire,
	createSources,
	heldSources,
	publish,
	release,
	settle,
	sourceKey,
	subscribe,
} from './registry';

/** @typedef {import('./registry').Entry} Entry */
/** @typedef {import('./registry').Sources} Sources */

/**
 * What a source shows: its model, its refusal, whether its first answer is
 * owed, and whether the model is a remembered one standing in.
 *
 * @typedef  {Object}  SourceState
 * @property {*}              model    The view model, null until an answer lands.
 * @property {?string}        error    The refusal, or null.
 * @property {boolean}        loading  Whether its first answer is owed.
 * @property {boolean}        stale    Whether a remembered answer stands in.
 * @property {StreamControls} [stream] A stream's view node and controls.
 */

/**
 * A stream source's view node and the controls its readers send it, shared
 * by every reader of the key.
 *
 * @typedef  {Object}                     StreamControls
 * @property {() => ?Object}             node      The view node holding the ring.
 * @property {(paused: boolean) => void} setPaused Pause or resume the stream.
 * @property {(term: string) => void}    setFilter Admit only rows matching a term.
 * @property {() => void}                clear     Empty the view.
 */

/** What a key shows before its host publishes anything. */
const UNSTARTED = Object.freeze( {
	model: null,
	error: null,
	loading: true,
	stale: false,
} );

/** @type {import('react').Context<?Sources>} */
const SourcesContext = createContext( null );

/**
 * A poll: one Fetcher on its own Tee and Timer, asking its args each tick,
 * its view the transform of each answer under the key's params.
 *
 * @param {Entry} entry The live source.
 * @return {SourceState} What it shows.
 */
function usePollSource( { decl, params, prefix } ) {
	const [ tokens ] = useState( () => decl.args( params ) );
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ prefix }:fetch`,
				receiver: `${ prefix }:in`,
				command: decl.command,
				view: `${ prefix }:view`,
				viewClass: sliceView( {
					empty: UNSTARTED,
					parse: ( answer ) => {
						const model = decl.transform
							? decl.transform( answer, params )
							: answer;
						return null === model ? null : { model, stale: false };
					},
				} ),
				tee,
				target: egressPath( decl.group, decl.ci ),
				argsFn: () => tokens,
			} ),
		timerName: `${ prefix }:timer`,
		teeName: `${ prefix }:tee`,
		intervalMs: decl.intervalMs,
		passenger: true,
	} );
	return useNodeField( `${ prefix }:view`, 'view' ) ?? UNSTARTED;
}

/**
 * A command: one read, asked once and again only when it went missing, its
 * remembered answer standing in, stale, while a fresh one is owed.
 *
 * @param {Entry} entry The live source.
 * @return {SourceState} What it shows.
 */
function useCommandSource( { decl, params, prefix } ) {
	const [ tokens ] = useState( () => decl.args( params ) );
	const { answer, error, loading, stale } = useCommandRead( {
		group: decl.group,
		ci: decl.ci,
		scope: prefix,
		command: decl.command,
		args: tokens,
	} );
	return useMemo(
		() => ( { model: answer, error, loading, stale } ),
		[ answer, error, loading, stale ]
	);
}

/**
 * A stream: one declared tail riding the page's stream link on the key's
 * subscription, opened where its mode says.
 *
 * @param {Entry} entry The live source.
 * @return {SourceState} What it shows.
 */
function useStreamSource( { decl, params, prefix } ) {
	const [ subscription ] = useState( () => decl.subscribe( params ) );
	const { viewRef, setPaused, setFilter, clear } = useLogTailStream( {
		name: prefix,
		subscribe: subscription,
		viewClass: decl.viewClass,
		mode: decl.mode,
	} );
	const view = useNodeField( `${ prefix }:view`, 'view' );
	const stream = useMemo(
		() => ( { node: () => viewRef.current, setPaused, setFilter, clear } ),
		[ viewRef, setPaused, setFilter, clear ]
	);
	return useMemo(
		() => ( {
			model: view ?? null,
			error: null,
			loading: undefined === view,
			stale: false,
			stream,
		} ),
		[ view, stream ]
	);
}

/** Each kind's host hook, by the `kind` a declaration names. */
const KINDS = {
	poll: usePollSource,
	command: useCommandSource,
	stream: useStreamSource,
};

/**
 * Runs one live source's kind hook and publishes what it shows.
 *
 * @param {{entry: Entry}} props The live source.
 * @return {null} Nothing; a host renders nothing.
 */
function KindHost( { entry } ) {
	const useKind = KINDS[ entry.decl.kind ];
	if ( ! useKind ) {
		throw new TypeError( `no source kind '${ entry.decl.kind }'` );
	}
	const state = useKind( entry );
	useEffect( () => publish( entry, state ), [ entry, state ] );
	return null;
}

/**
 * Keeps one source's failure to its own key: the key shows the error, and
 * the provider's other sources keep running.
 */
class Contained extends Component {
	/** @param {{entry: Entry, children: *}} props The source and its host. */
	constructor( props ) {
		super( props );
		this.state = { failed: false };
	}

	/** @return {{failed: boolean}} The failed state. */
	static getDerivedStateFromError() {
		return { failed: true };
	}

	/** @param {Error} error What the host threw. */
	componentDidCatch( error ) {
		publish( this.props.entry, {
			...UNSTARTED,
			loading: false,
			error: errorMessage( error ),
		} );
	}

	/** @return {*} The host, until it fails. */
	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/**
 * One held source's host, which settles the source once it unmounts.
 *
 * @param {{entry: Entry}} props The live source.
 * @return {import('react').ReactElement} Its contained kind host.
 */
function SourceHost( { entry } ) {
	useEffect( () => () => settle( entry ), [ entry ] );
	return (
		<Contained entry={ entry }>
			<KindHost entry={ entry } />
		</Contained>
	);
}

/**
 * Holds the live sources of the tree beneath it, one host for each a
 * reader holds, rendered beside that tree.
 *
 * @param {{children: *}} props The tree reading sources.
 * @return {import('react').ReactElement} The tree and its hosts.
 */
function OwnSources( { children } ) {
	const [ sources ] = useState( createSources );
	useSyncExternalStore(
		useCallback(
			( listener ) => subscribe( sources, listener ),
			[ sources ]
		),
		() => sources.version
	);
	return (
		<SourcesContext.Provider value={ sources }>
			{ children }
			{ heldSources( sources ).map( ( entry ) => (
				<SourceHost key={ entry.prefix } entry={ entry } />
			) ) }
		</SourcesContext.Provider>
	);
}

/**
 * The live sources of the tree beneath it: the ones of a provider already
 * above it, so every layout on a page shares one fetch per key, or else
 * its own.
 *
 * @param {{children: *}} props The tree reading sources.
 * @return {import('react').ReactElement} The tree, with its hosts when it
 *   holds its own sources.
 */
export function SourcesProvider( { children } ) {
	if ( useContext( SourcesContext ) ) {
		return children;
	}
	return <OwnSources>{ children }</OwnSources>;
}

/**
 * Read a declared source under `params`, holding it while mounted.
 *
 * @param {string} name     A name this bundle's `registerSource()` declared.
 * @param {Object} [params] What it is read with; equal params share it.
 * @return {SourceState} What the key shows now.
 * @throws {Error} Outside a `SourcesProvider`, or when nothing declares `name`.
 */
export function useSource( name, params = {} ) {
	const sources = useContext( SourcesContext );
	if ( ! sources ) {
		throw new Error(
			`useSource( '${ name }' ) reads through a SourcesProvider above it: a composed page's ComposedLayout renders one, and a page of its own wraps its tree in <SourcesProvider>`
		);
	}
	const key = sourceKey( name, params );
	const state = useSyncExternalStore(
		useCallback(
			( listener ) => subscribe( sources, listener ),
			[ sources ]
		),
		() => sources.entries.get( key )?.state ?? UNSTARTED
	);
	const paramsRef = useRef( params );
	paramsRef.current = params;
	useEffect( () => {
		const entry = acquire( sources, name, paramsRef.current );
		return () => release( entry );
	}, [ sources, name, key ] );
	return state;
}
