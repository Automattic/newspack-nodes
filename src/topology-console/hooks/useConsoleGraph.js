/**
 * useConsoleGraph — mounts the per-session in-browser node graph. Send: Shell →
 * _command_interpreter → _router ─[peel {worker}]→ the worker's RemoteIpc (which
 * bundles connect_worker_input + the command and POSTs through its OWN HttpOut).
 * Receive: each worker's RemoteIpc owns a SseIn that forwards parsed frames →
 * _router ─[peel reply-node]→ _output (Dumper) | _metadata | _uptime. The
 * _metadata / _uptime poll nodes emit on the Router TIMER (batched into one POST
 * per tick by the ACTIVE RemoteIpc's HttpOut) addressed to `_cwd`; the active
 * RemoteIpc's composed Heartbeat keeps its SSE slot alive. Mounted while
 * `enabled`; torn down on unmount or edit mode. Node names come from the
 * shared-canonical reserved-node-names.json.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`: `cd /{worker}` routes
 * straight to it. Only one stream is live at a time — the active worker's
 * RemoteIpc steals it on a send/connect.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { useGraphGeneration } from '../../runtime/react';
import { Node } from '../../runtime/node';
import { mountExospine } from '../../runtime/exospine';
import { DumperNode } from '../../runtime/dumper-node';
import { ShellNode } from '../../runtime/shell-node';
import { RemoteIpcNode } from '../../runtime/remote-ipc-node';
import { getCommandClient } from '../utils/commandClient';
import { useTopology } from './useTopologyList';
import { parseTsl } from '../utils/parseTsl';
import {
	fetchExpandedIncludes,
	primeExpandedIncludes,
} from './useExpandedIncludes';
import {
	applyLoadedBaseline,
	withReplAnchor,
	withResolvedConfigEdges,
} from '../utils/draftGraph';
import { augmentWithVirtualEdges } from '../utils/virtualEdges';
import { scopeFromCwd } from '../utils/scope';
import {
	loadHubTranscript,
	saveHubTranscript,
} from '../core/consolePersistence';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import names from '../../runtime/reserved-node-names.json';

const EMPTY_TRANSCRIPT = [];

/**
 * @param {Object}   params
 * @param {string}   params.topology      Topology name.
 * @param {number}   params.partition     Partition number.
 * @param {boolean}  params.enabled       Mount the graph (false = edit mode).
 * @param {string[]} params.workers       Active worker readers (`['aggregator.p0', …]`); one RemoteIpc per entry.
 * @param {boolean}  params.streamEnabled Open the active worker's SSE stream (cwd is a worker). The graph stays mounted regardless; this only gates the EventSource, so cd-ing off a worker stops streaming without rebuilding. Default true.
 * @param {Object}   params.debugLevelRef React ref holding the Dumper verbosity dial.
 * @param {Function} params.loadCatalog   Load the PHP class catalog with `fans_out` flags.
 * @return {Object} Connection state, the anonymous Shell, and any pre-metadata
 *                  seed failure.
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
	workers = [],
	streamEnabled = true,
	debugLevelRef,
	loadCatalog,
} ) {
	const [ ssePid, setSsePid ] = useState( null );
	const [ shell, setShell ] = useState( null );
	const [ seedError, setSeedError ] = useState( null );

	// Hidden tab throttles the heartbeat → slot TTLs out; gate on visibility.
	const isPageVisible = usePageVisibility();

	// Reset Graph bumps generation → re-runs the effect, rebuilding the graph.
	const generation = useGraphGeneration();

	// Direct `topologies get` for the mount TSL seed; stable identity.
	const fetchTopologyTsl = useTopology();

	// Stash debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	// Stable key over the worker list; the effect rebuilds RemoteIpc on change.
	const workersKey = workers.join( ',' );

	useEffect( () => {
		if ( ! enabled ) {
			setSsePid( null );
			setShell( null );
			setSeedError( null );
			return undefined;
		}
		let seedCancelled = false;
		setSeedError( null );

		const reader = `${ topology }.p${ partition }`;

		// The shared rule-#2 backbone: _command_interpreter → _router.
		const {
			interpreter,
			router,
			shell: shellTap,
			http,
			teardown: teardownSpine,
		} = mountExospine();
		// Interpreter ships the PHP verb set as built-ins (no overrides).

		// Reply nodes sink into the interpreter (rule #2); Dumper stays bare.
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRefRef.current;
		dumper.name = names.OUTPUT;
		dumper.sink = interpreter;
		// Persist/restore transcript; teardown drops it on switch/reload.
		const transcriptListenerId = 'useConsoleGraph/transcript';
		dumper.register( 'transcript', transcriptListenerId, ( next ) => {
			saveHubTranscript( next || EMPTY_TRANSCRIPT );
			return true;
		} );
		dumper.restore( loadHubTranscript() );
		// Substrate soft-nodes via make_node: name + sink + args in one.
		const metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		const uptime = interpreter.makeNode( 'Uptime', names.UPTIME );
		// `_dmesg` publishes error/warn/debug counts for the stats header.
		const dmesg = interpreter.makeNode( 'Dmesg', names.DMESG );
		const completion = interpreter.makeNode(
			'Completion',
			names.COMPLETION
		);

		// One RemoteIpc per worker (SseIn+HttpOut+Heartbeat); one live stream.
		const readers = new Set( [ reader, ...workers ] );
		const remotes = [];
		for ( const wr of readers ) {
			// baseUrl/nonce resolve from the localized global, not tokens.
			const remote = interpreter.makeNode( 'RemoteIpc', wr, [ wr ] );
			remote.target = names.OUTPUT;
			remote.client = getCommandClient();
			// The active worker's connect handshake drives the pid display.
			remote.onConnected = () => setSsePid( remote.pid() );
			// Reset pid on a steal so a send won't wrap the stale pid.
			remote.onClose = () => setSsePid( null );
			remotes.push( remote );
		}

		// Bare mount: list RemoteIpc in reinitNames (else Reset sticks).
		Core.reinitNames = [
			...( Core.reinitNames || [] ),
			...remotes.map( ( r ) => r.name ),
		];

		// `_cwd`.target IS the cwd; polls to `_cwd`, Router stamps TO.
		const cwdNode = new Node();
		cwdNode.name = names.CWD;
		cwdNode.sink = interpreter;
		// Seed cwd to the default path so polls route before the gate runs.
		cwdNode.target = reader;

		// Anonymous React Shell; sinks into the `_shell` Tap → interpreter.
		const consoleShell = new ShellNode();
		consoleShell.path = reader;
		consoleShell.sink = shellTap;

		setSsePid( null );

		// Canvas poll on one Router TIMER (1s): all emissions ride in ONE POST.
		metadata.sink = interpreter;
		uptime.sink = interpreter;
		dmesg.sink = interpreter;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		dmesg.target = names.CWD;
		// @longform
		// Absolute: ONE `_http` per graph, so the tick's commands batch into a
		// single POST whatever TO each carries. The old form reached through
		// RemoteIpcNode.active, which could change between before and after —
		// hence a steal guard for a steal that cannot happen.
		router.beforeTimerNotify = () => http.lock();
		router.afterTimerNotify = () => http.flush();
		// Poll nodes hitchhike the _router TIMER (fireCb runs each tick).
		metadata.setTimer();
		uptime.setTimer();
		dmesg.setTimer();

		// Paint the declared topology before SSE/dump_metadata arrives.
		if ( topology ) {
			const topologySeed = fetchTopologyTsl( topology ).then(
				async ( resp ) => {
					/**
					 * Seed the COMPOSED graph. A topology that mostly `include`s
					 * others owns few nodes of its own, so seeding the parsed file
					 * alone paints a sliver and the rest pops in on the next
					 * dump_metadata — the staged paint autofit can't survive.
					 * `get` ships the expansion; expand() is the fallback.
					 */
					const parsedGraph = withResolvedConfigEdges(
						parseTsl( resp?.tsl || '' ),
						resp?.resolved_config_edges
					);
					const baseline =
						resp?.expanded ??
						( await fetchExpandedIncludes( parsedGraph.includes ) );
					primeExpandedIncludes( parsedGraph.includes, baseline );
					return { parsedGraph, baseline };
				}
			);
			const catalog = Promise.resolve()
				.then( () => {
					if ( 'function' !== typeof loadCatalog ) {
						throw new Error(
							'PHP class catalog loader is unavailable.'
						);
					}
					return loadCatalog();
				} )
				.then( ( loadedCatalog ) => {
					if ( ! Array.isArray( loadedCatalog?.classes ) ) {
						throw new Error( 'Invalid classes.list response.' );
					}
					return loadedCatalog;
				} );
			Promise.all( [ topologySeed, catalog ] )
				.then( ( [ { parsedGraph, baseline }, loadedCatalog ] ) => {
					if ( seedCancelled ) {
						return;
					}
					// Anchor `_repl` in the seed so autofit includes it.
					const seeded = augmentWithVirtualEdges(
						withReplAnchor(
							applyLoadedBaseline(
								parsedGraph,
								baseline,
								loadedCatalog.classes
							)
						),
						loadedCatalog.classes
					);
					// Resolve LIVE metadata; skip if a reply already filled it.
					const node = Core.node( names.METADATA );
					const live =
						node?.rawMap && Object.keys( node.rawMap ).length > 0;
					// Seed only at a worker scope (else wrong graph).
					const onWorker = scopeFromCwd(
						Core.node( names.CWD )?.target ?? ''
					).isWorker;
					if ( node && seeded.nodes.length && ! live && onWorker ) {
						node.setState( 'metadata', seeded );
					}
				} )
				.catch( ( error ) => {
					if ( ! seedCancelled ) {
						setSeedError( error );
					}
				} );
		}

		setShell( consoleShell );
		// The stream-gating effect owns the EventSource; cd-off can quiet it.

		return () => {
			seedCancelled = true;
			// Each node owns teardown; unregister before removeNode.
			dumper.unregister( 'transcript', transcriptListenerId );
			dumper.removeNode();
			metadata.removeNode();
			uptime.removeNode();
			dmesg.removeNode();
			completion.removeNode();
			for ( const remote of remotes ) {
				remote.removeNode();
			}
			cwdNode.removeNode();
			// Backbone last: stops router TIMER, removes interpreter/router.
			teardownSpine();
			setSsePid( null );
			setShell( null );
		};
		// `workersKey` is the stable projection of `workers` (id churn).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		topology,
		partition,
		enabled,
		workersKey,
		generation,
		fetchTopologyTsl,
		loadCatalog,
	] );

	// Stream open only while mounted, cwd is a worker, and the tab is visible.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const reader = `${ topology }.p${ partition }`;
		if ( streamEnabled && isPageVisible ) {
			Core.node( reader )?.connect();
		} else {
			RemoteIpcNode.active?.close();
			setSsePid( null );
		}
		return undefined;
	}, [ streamEnabled, isPageVisible, topology, partition, enabled ] );

	let status = 'open';
	if ( ! enabled ) {
		status = 'closed';
	} else if ( null === ssePid ) {
		status = 'connecting';
	}

	return { status, ssePid, shell, seedError };
}
