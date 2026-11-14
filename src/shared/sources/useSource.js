/**
 * useSource — read a declared source under params, as every block on a page
 * does, so N blocks with equal params share one live source and one fetch.
 *
 * A live source is built by the substrate's own hooks: a poll by
 * `useBatchedPoll` and `addSliceFetcher`, a command by `useCommandRead`, a
 * stream by `useLogTailStream`, whose readers also get its view node and
 * controls, and a derived source by reading its inputs as a block would. A
 * poll's readers also get `refresh()`, which asks again at once. A hook
 * runs only inside a component, so a `SourcesProvider` renders one host per
 * held key inside the page's own tree, under its StrictMode and its
 * boundaries, built by this bundle's hooks. A block only holds its key and
 * reads what the host publishes, so a block unmounting never tears down a source another block still reads, and
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
import { Core, useNodeField } from '@newspack-nodes/runtime';
import { useBatchedPoll } from '../hooks/useBatchedPoll';
import { usePageState } from '../composition/page/pageState';
import { useCommandRead } from '../hooks/useCommandRead';
import { useLogTailStream } from '../hooks/useLogTailStream';
import { useGlobBrowse } from '../hooks/useStreamGraph';
import useRouterTick from '../hooks/useRouterTick';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import { sliceView } from '../nodes/slice-view-node';
import { errorMessage } from '../errorMessage';
import {
	acquire,
	createSources,
	hold,
	sourceDeclaration,
	heldSources,
	isHeld,
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
 * @property {*}              model     The view model, null until an answer lands.
 * @property {?string}        error     The refusal, or null.
 * @property {boolean}        loading   Whether its first answer is owed.
 * @property {boolean}        stale     Whether a remembered answer stands in.
 * @property {StreamControls} [stream]  A stream's view node and controls.
 * @property {() => void}     [refresh] A poll's re-ask, now.
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
 * @property {string[]}                  subscribe The subscription it tails.
 * @property {?Object}                   browse    A browsed stream's partition
 *                                                 pick, rail and jump
 *                                                 (`useGlobBrowse`); null
 *                                                 for one that browses none.
 * @property {(() => void)|undefined}    step      Deliver one record while
 *                                                 paused, once a browsed
 *                                                 stream has picked a dir.
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
 * A poll's cadence in milliseconds: the value of the page-state key its
 * `cadence` names, else its `intervalMs`. The key's hook runs or not by the
 * declaration, which is fixed for the host's life.
 *
 * @param {Object} decl The poll's declaration.
 * @return {number} The cadence.
 */
function useCadence( decl ) {
	if ( ! decl.cadence ) {
		return decl.intervalMs;
	}
	// eslint-disable-next-line react-hooks/rules-of-hooks -- fixed per declaration
	const [ ms ] = usePageState( decl.cadence );
	return Number( ms );
}

/**
 * A poll: one Fetcher on its own Tee and Timer, asking its args each tick at
 * the interval its params set. Its view is the declared `viewClass`, with a
 * `transformClass` node on the edge before it, or else a slice holding the
 * transform of each answer under the key's params. It asks at the cadence
 * its `cadence` page-state key holds, re-armed in place on its grid when that
 * moves, else at its `intervalMs`. `retry: false` sets its Fetcher's
 * `retry_after_s` to 0, as `useCommandOnce` maps `retry`, so a question asks
 * once a poll however long its answer takes. Args answering null ask
 * nothing. `refresh()` asks again at once; a held page asks nothing, and
 * its next tick asks at once.
 *
 * @param {Entry}   entry  The live source.
 * @param {boolean} paused Whether the page holds every source still.
 * @return {SourceState} What it shows.
 */
function usePollSource( { decl, params, prefix }, paused ) {
	const [ tokens ] = useState( () =>
		decl.args ? decl.args( params ) : []
	);
	const { pollNow } = useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			addSliceFetcher( interpreter, {
				fetcher: `${ prefix }:fetch`,
				receiver: `${ prefix }:in`,
				command: decl.command,
				view: `${ prefix }:view`,
				viewClass:
					decl.viewClass ??
					sliceView( {
						empty: UNSTARTED,
						parse: ( answer ) => {
							const model = decl.transform
								? decl.transform( answer, params )
								: answer;
							return null === model
								? null
								: { model, stale: false };
						},
					} ),
				...( decl.transformClass && {
					transform: {
						name: `${ prefix }:transform`,
						nodeClass: decl.transformClass,
					},
				} ),
				tee,
				target: egressPath( decl.group, decl.ci ),
				argsFn: () => tokens,
			} );
			if ( false === decl.retry ) {
				Core.node( `${ prefix }:fetch` ).retry_after_s = 0;
			}
		},
		timerName: `${ prefix }:timer`,
		teeName: `${ prefix }:tee`,
		paused,
		intervalMs: useCadence( decl ),
		passenger: true,
	} );
	const view = useNodeField( `${ prefix }:view`, 'view' );
	return useMemo( () => {
		if ( ! decl.viewClass ) {
			return { ...( view ?? UNSTARTED ), refresh: pollNow };
		}
		return {
			model: view ?? null,
			error: view?.error ?? null,
			loading: undefined === view,
			stale: false,
			refresh: pollNow,
		};
	}, [ decl, view, pollNow ] );
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
 * subscription, opened where its mode says, its view emptied before each open
 * when it declares `clearOnOpen`. One declaring `browse` browses its glob
 * and steps a picked dir (`useGlobBrowse`), its readers getting the browse
 * model and the step, under the `group` it names. One naming a `cadence`
 * page-state key sends its view a `snapshot` control as it arms and at the
 * milliseconds that key holds.
 *
 * @param {Entry} entry The live source.
 * @return {SourceState} What it shows.
 */
function useStreamSource( { decl, params, prefix } ) {
	const [ subscription ] = useState( () => decl.subscribe( params ) );
	const graph = useLogTailStream( {
		name: prefix,
		subscribe: subscription,
		viewClass: decl.viewClass,
		mode: decl.mode,
		group: decl.group,
		clearOnOpen: decl.clearOnOpen ?? false,
	} );
	const { viewRef, setPaused, setFilter, clear, control } = graph;
	const browse = decl.browse
		? // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed per declaration
		  useGlobBrowse( { glob: subscription, graph } )
		: null;
	if ( decl.cadence ) {
		// eslint-disable-next-line react-hooks/rules-of-hooks -- fixed per declaration
		useSnapshots( decl, prefix, control );
	}
	const view = useNodeField( `${ prefix }:view`, 'view' );
	const node = useCallback( () => viewRef.current, [ viewRef ] );
	const stream = useMemo(
		() => ( {
			node,
			setPaused,
			setFilter,
			clear,
			subscribe: [ subscription ],
			browse,
			step: browse?.step,
		} ),
		[ node, setPaused, setFilter, clear, subscription, browse ]
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

/**
 * Send a stream's view a `snapshot` control as the cadence its declaration's
 * page-state key holds arms, and at that cadence after, so a page shows the
 * view's first snapshot without waiting out an interval.
 *
 * @param {Object}                  decl    The stream's declaration.
 * @param {string}                  prefix  Names the timer.
 * @param {(value: Object) => void} control Mints a control into the view.
 */
function useSnapshots( decl, prefix, control ) {
	const intervalMs = useCadence( decl );
	const onTick = useCallback(
		() => control( { action: 'snapshot' } ),
		[ control ]
	);
	useRouterTick( { name: `${ prefix }:timer`, onTick, intervalMs } );
	useEffect( () => {
		onTick();
	}, [ onTick, intervalMs ] );
}

/**
 * The params one input of a derived source is read with: those of the
 * derived key's params the input declares.
 *
 * @param {string} name   The input.
 * @param {Object} params The derived key's params.
 * @return {Object} The params the input is read with.
 */
const inputParams = ( name, params ) =>
	Object.fromEntries(
		( sourceDeclaration( name ).params ?? [] ).map( ( key ) => [
			key,
			params[ key ],
		] )
	);

/**
 * A derived source: every source it reads from held as any block holds one,
 * so a block reading an input directly shares its fetch, and its model what
 * `derive` makes of their models once every input has finished loading, a
 * model an input has yet to publish handed over as null. It shows the first input's refusal,
 * and none of its own, and its `refresh()` refreshes every input that has
 * one.
 *
 * @param {Entry} entry The live source.
 * @return {SourceState} What it shows.
 */
function useDerivedSource( { decl, params } ) {
	const inputs = decl.from.map( ( name ) =>
		// eslint-disable-next-line react-hooks/rules-of-hooks -- `from` is fixed per declaration
		useSource( name, inputParams( name, params ) )
	);
	const models = inputs.map( ( input ) => input.model );
	const waiting = inputs.some( ( input ) => input.loading );
	const error = inputs.find( ( input ) => input.error )?.error ?? null;
	const model = useMemo(
		() => ( waiting ? null : decl.derive( models, params ) ),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the models key the derivation
		[ waiting, ...models ]
	);
	const refreshes = inputs.map( ( input ) => input.refresh );
	const refresh = useCallback(
		() => refreshes.forEach( ( one ) => one?.() ),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the inputs' refreshes key it
		refreshes
	);
	return useMemo(
		() => ( {
			model,
			error,
			loading: waiting && ! error,
			stale: false,
			refresh,
		} ),
		[ model, error, waiting, refresh ]
	);
}

/** Each kind's host hook, by the `kind` a declaration names. */
const KINDS = {
	poll: usePollSource,
	command: useCommandSource,
	stream: useStreamSource,
	derived: useDerivedSource,
};

/**
 * Runs one live source's kind hook and publishes what it shows, save while
 * the page is held, when its readers keep what it last showed.
 *
 * @param {{entry: Entry, held: boolean}} props The live source, and whether the page is held.
 * @return {null} Nothing; a host renders nothing.
 */
function KindHost( { entry, held } ) {
	const useKind = KINDS[ entry.decl.kind ];
	if ( ! useKind ) {
		throw new TypeError( `no source kind '${ entry.decl.kind }'` );
	}
	const state = useKind( entry, held );
	useEffect( () => {
		if ( ! held ) {
			publish( entry, state );
		}
	}, [ entry, state, held ] );
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
 * @param {{entry: Entry, held: boolean}} props The live source, and whether the page is held.
 * @return {import('react').ReactElement} Its contained kind host.
 */
function SourceHost( { entry, held } ) {
	useEffect( () => () => settle( entry ), [ entry ] );
	return (
		<Contained entry={ entry }>
			<KindHost entry={ entry } held={ held } />
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
				<SourceHost
					key={ entry.prefix }
					entry={ entry }
					held={ isHeld( entry ) }
				/>
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
	return useLastModel( name, params, state );
}

/**
 * A poll's or a derived source's state as a reader shows it: while a new key
 * loads, the model the reader last showed under the declaration, stale,
 * unless the source's scope (`scopeOf()`) differs under the new params,
 * so a reader keeps its rows and its figures on screen across a new
 * question. A command keeps its own remembered answers.
 *
 * @param {string}      name   The source.
 * @param {Object}      params What it is read with.
 * @param {SourceState} state  What its key shows.
 * @return {SourceState} What the reader shows.
 */
function useLastModel( name, params, state ) {
	const decl = sourceDeclaration( name );
	const scope = scopeOf( decl, params );
	const keeps = 'poll' === decl.kind || 'derived' === decl.kind;
	const last = useRef( null );
	if ( keeps && null !== state.model ) {
		last.current = { name, scope, model: state.model };
	}
	const standsIn =
		keeps &&
		null === state.model &&
		state.loading &&
		last.current?.name === name &&
		last.current.scope === scope;
	const model = standsIn ? last.current.model : null;
	return useMemo(
		() => ( standsIn ? { ...state, model, stale: true } : state ),
		[ standsIn, state, model ]
	);
}

/**
 * The scope a source is read under: what its declaration's `scope` answers,
 * else for a derived source its inputs' scopes, each under its own params,
 * else none.
 *
 * @param {Object} decl   The declaration.
 * @param {Object} params What it is read with.
 * @return {string} The scope.
 */
function scopeOf( decl, params ) {
	if ( decl.scope ) {
		return decl.scope( params );
	}
	if ( 'derived' !== decl.kind ) {
		return '';
	}
	return decl.from
		.map( ( input ) =>
			scopeOf( sourceDeclaration( input ), inputParams( input, params ) )
		)
		.join( '\n' );
}

/**
 * Keep the page's sources in `groups`, or every source when `groups` is
 * null, still while `held`: no poll asks and no source shows anything new, so
 * nothing moves under a pointer mid-drag or behind a window over the page.
 * Its next tick asks at once once the last hold ends.
 *
 * @param {boolean}  held     Whether to hold them now.
 * @param {string[]} [groups] The groups it holds, an empty list none; null
 *                            holds every source.
 * @throws {Error} Outside a `SourcesProvider`.
 */
export function useSourcesPaused( held, groups = null ) {
	const sources = useContext( SourcesContext );
	if ( ! sources ) {
		throw new Error(
			'useSourcesPaused() holds the sources of a SourcesProvider above it'
		);
	}
	const named = groups ? JSON.stringify( groups ) : null;
	useEffect( () => {
		if ( ! held || '[]' === named ) {
			return undefined;
		}
		const list = null === named ? null : JSON.parse( named );
		hold( sources, true, list );
		return () => hold( sources, false, list );
	}, [ sources, held, named ] );
}
