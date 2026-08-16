// Stable, so an omitted catalog is not a fresh identity every render.
const NO_CATALOG = { classes: [], loading: false, error: null };

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
import { StdoutNode } from '../../runtime/stdout-node';
import { OutgoingGateNode } from '../core/outgoingGate';
import { ShellNode } from '../../runtime/shell-node';
import { RemoteIpcNode } from '../../runtime/remote-ipc-node';
import { useTopology } from './useCatalogs';
import { graphFromTsl } from '../utils/draftToGraph';
import { DraftInterpreterNode } from '../../runtime/draft-interpreter-node';
import { primeExpandedIncludes } from './useExpandedIncludes';

const EMPTY_EXPANSION = { nodes: [], edges: [], tree: {}, hulls: {} };
import { withReplAnchor, withResolvedConfigEdges } from '../utils/consoleGraph';
import { augmentWithVirtualEdges } from '../utils/virtualEdges';
import { scopeFromCwd } from '../utils/scope';
import { makeSkinHost } from '../core/skinCommands';
import { THEMES, getStoredTheme, applySkin } from '../themes';
import {
	loadHubTranscript,
	saveHubTranscript,
} from '../core/consolePersistence';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import names from '../../runtime/reserved-node-names.json';
import { ROUTER_TICK_MS } from '../../runtime/router-node';

const EMPTY_TRANSCRIPT = [];

/**
 * @param {Object}   params
 * @param {string}   params.topology      Topology name.
 * @param {number}   params.partition     Partition number.
 * @param {boolean}  params.enabled       Mount the graph (false = edit mode).
 * @param {string[]} params.workers       Active worker readers (`['aggregator.p0', …]`); one RemoteIpc per entry.
 * @param {boolean}  params.streamEnabled Open the active worker's SSE stream (cwd is a worker). The graph stays mounted regardless; this only gates the EventSource, so cd-ing off a worker stops streaming without rebuilding. Default true.
 * @param {Object}   params.debugLevelRef React ref holding the Dumper verbosity dial.
 * @param {Object}   params.catalog       The PHP class catalog slice — `{ classes, loading, error }`.
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
	catalog = NO_CATALOG,
} ) {
	const [ ssePid, setSsePid ] = useState( null );
	const [ shell, setShell ] = useState( null );
	// The unnamed outgoing gate; STATE, so a rebuild reaches its consumer.
	const [ outgoing, setOutgoing ] = useState( null );
	const [ seedError, setSeedError ] = useState( null );

	// Hidden tab throttles the heartbeat → slot TTLs out; gate on visibility.
	const isPageVisible = usePageVisibility();

	// Reset Graph bumps generation → re-runs the effect, rebuilding the graph.
	const generation = useGraphGeneration();

	// The mount TSL seed, as its own slice; painted by the effect below.
	const { open: openSeedTopology, topology: seedTopology } = useTopology( {
		scope: 'seed',
		enabled,
	} );
	useEffect( () => {
		openSeedTopology( enabled ? topology : '' );
	}, [ topology, enabled, openSeedTopology ] );

	// Stash debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	// Stable key over the worker list; the effect rebuilds RemoteIpc on change.
	const workersKey = workers.join( ',' );

	// @longform
	// The backbone is the PAGE's, not the stream's: it stands for as long as
	// the console is mounted, and only a graph-generation bump replaces it.
	// Edit mode stops the stream and drops every view node, but a save, a
	// delete and an include expansion all happen in edit mode — tearing the
	// interpreter down under them left their commands sinking into a removed
	// node, silently.
	useEffect( () => {
		const { teardown } = mountExospine();
		return teardown;
	}, [ generation ] );

	useEffect( () => {
		if ( ! enabled ) {
			// Cleanup nulls the graph state; a seed error has no other owner.
			setSeedError( null );
			return undefined;
		}
		const reader = `${ topology }.p${ partition }`;

		// The shared rule-#2 backbone: _command_interpreter → _router.
		const {
			interpreter,
			shell: shellTap,
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
		// Builtin output bypasses `_output`; `_stdout` makes it lines.
		const stdout = new StdoutNode( {
			write: ( text ) => dumper.appendText( text ),
		} );
		stdout.name = names.STDOUT;
		// Rule #2: terminal, but sunk like PHP's TTY_Out_Node.
		stdout.sink = interpreter;
		// Substrate soft-nodes via make_node: name + sink + args in one.
		const metadata =
			/** @type {import('../../runtime/metadata-node').MetadataNode} */ (
				interpreter.makeNode( 'Metadata', names.METADATA )
			);
		const uptime =
			/** @type {import('../../runtime/uptime-node').UptimeNode} */ (
				interpreter.makeNode( 'Uptime', names.UPTIME )
			);
		// `_dmesg` publishes error/warn/debug counts for the stats header.
		const dmesg =
			/** @type {import('../../runtime/dmesg-node').DmesgNode} */ (
				interpreter.makeNode( 'Dmesg', names.DMESG )
			);
		const completion = interpreter.makeNode(
			'Completion',
			names.COMPLETION
		);

		// One RemoteIpc per worker (SseIn+HttpOut+Heartbeat); one live stream.
		const readers = new Set( [ reader, ...workers ] );
		const remotes = [];
		for ( const wr of readers ) {
			// baseUrl/nonce resolve from the localized global, not tokens.
			const remote = /** @type {RemoteIpcNode} */ (
				interpreter.makeNode( 'RemoteIpc', wr, [ wr ] )
			);
			remote.target = names.OUTPUT;
			// The active worker's connect handshake drives the pid display.
			remote.onConnected = () => setSsePid( remote.pid() );
			// Reset pid on a steal so a send won't wrap the stale pid.
			remote.onClose = () => setSsePid( null );
			remotes.push( remote );
		}

		// `_cwd`.target IS the cwd; polls to `_cwd`, Router stamps TO.
		const cwdNode = new Node();
		cwdNode.name = names.CWD;
		cwdNode.sink = interpreter;
		// Seed cwd to the default path so polls route before the gate runs.
		cwdNode.target = reader;

		const outgoingGate = new OutgoingGateNode();
		outgoingGate.sink = shellTap;

		// Anonymous React Shell; sinks into the gate → Tap → interpreter.
		const consoleShell = new ShellNode();
		consoleShell.path = reader;
		consoleShell.sink = outgoingGate;
		// The skins are the host's: stylesheet and storage both.
		consoleShell.host = makeSkinHost( {
			skins: THEMES,
			currentSkin: getStoredTheme,
			applySkin,
			print: ( text ) => dumper.appendText( text ),
		} );

		setSsePid( null );

		// Canvas poll on one Router TIMER (1s): all emissions ride in ONE POST.
		metadata.sink = interpreter;
		uptime.sink = interpreter;
		dmesg.sink = interpreter;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		dmesg.target = names.CWD;
		// Poll nodes hitchhike the _router TIMER (fireCb runs each tick).
		metadata.setTimer();
		uptime.setTimer();
		dmesg.setTimer();

		setShell( consoleShell );
		setOutgoing( outgoingGate );

		return () => {
			// Each node owns teardown; unregister before removeNode.
			dumper.unregister( 'transcript', transcriptListenerId );
			dumper.removeNode();
			stdout.removeNode();
			metadata.removeNode();
			uptime.removeNode();
			dmesg.removeNode();
			completion.removeNode();
			for ( const remote of remotes ) {
				remote.removeNode();
			}
			cwdNode.removeNode();
			// The backbone effect above owns the spine; this is a no-op.
			teardownSpine();
			setSsePid( null );
			setShell( null );
			setOutgoing( null );
		};
		// `workersKey` is the stable projection of `workers` (id churn).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ topology, partition, enabled, workersKey, generation ] );

	/**
	 * Paint the declared topology before SSE/dump_metadata arrives.
	 *
	 * Seed the COMPOSED graph. A topology that mostly `include`s others owns few
	 * nodes of its own, so seeding the parsed file alone paints a sliver and the
	 * rest pops in on the next dump_metadata — a staged paint autofit can't
	 * survive. `get` ships the expansion; `expand()` is the fallback.
	 */
	useEffect( () => {
		// Without `fans_out` a custom fan-out seeds wrong edges, confidently.
		if (
			! enabled ||
			! topology ||
			seedTopology?.name !== topology ||
			catalog.loading ||
			catalog.error
		) {
			return undefined;
		}
		let cancelled = false;
		setSeedError( null );

		const paint = async () => {
			const { tsl, expanded } = seedTopology;
			const resolvedConfigEdges = seedTopology.resolved_config_edges;
			const includes = DraftInterpreterNode.includesOf( tsl );
			// @longform `topologies get` always ships the expansion; VIEW
			// mode is read-only, so a document that somehow arrives without
			// one paints unmarked rather than blocking the graph.
			const baseline = expanded ?? EMPTY_EXPANSION;
			primeExpandedIncludes( includes, baseline );
			if ( cancelled ) {
				return;
			}
			// graphFromTsl composed it; only virtual edges remain.
			const parsedGraph = withReplAnchor(
				withResolvedConfigEdges(
					graphFromTsl(
						tsl,
						baseline,
						catalog.classes,
						resolvedConfigEdges
					),
					resolvedConfigEdges
				)
			);
			const seeded = augmentWithVirtualEdges(
				parsedGraph,
				catalog.classes
			);
			// LIVE metadata; skip if a reply already filled it.
			const node = Core.node( names.METADATA );
			const live = node?.rawMap && Object.keys( node.rawMap ).length > 0;
			// Seed only at a worker scope (else wrong graph).
			const onWorker = scopeFromCwd(
				Core.node( names.CWD )?.target ?? ''
			).isWorker;
			if ( node && seeded.nodes.length && ! live && onWorker ) {
				node.setState( 'metadata', seeded );
			}
		};

		paint().catch( ( error ) => {
			if ( ! cancelled ) {
				setSeedError( error );
			}
		} );

		return () => {
			cancelled = true;
		};
	}, [
		enabled,
		topology,
		seedTopology,
		catalog.classes,
		catalog.loading,
		catalog.error,
		generation,
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

	// @longform Pollers hitchhike the router tick — dump_metadata, uptime,
	// dmesg, topologies list. Gating each arm site is one site away from a
	// leak; gating the tick they share stops them together and resumes them in
	// step. NOT gated on `enabled`: that is false in edit mode, where the
	// catalog poller deliberately stays mounted, so honouring it would leave
	// the leak open on the one path guaranteed to still be polling — and a
	// router stopped while hidden would never re-arm.
	useEffect( () => {
		const router = Core.node( names.ROUTER );
		if ( ! router ) {
			return undefined;
		}
		if ( isPageVisible ) {
			router.setTimer( ROUTER_TICK_MS );
		} else {
			router.stopTimer();
			// stopTimer zeroes interval_ms; a bare setTimer() inherits it.
			router.interval_ms = ROUTER_TICK_MS;
		}
		return undefined;
	}, [ isPageVisible, generation ] );

	let status = 'open';
	if ( ! enabled ) {
		status = 'closed';
	} else if ( null === ssePid ) {
		status = 'connecting';
	}

	return { status, ssePid, shell, seedError, outgoing };
}
