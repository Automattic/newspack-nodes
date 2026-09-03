/**
 * The topology console's per-session browser node graph: the nodes it mounts,
 * how a command reaches a worker, and how the answer gets back.
 *
 * SEND. A Shell statement sinks through the console's outgoing gate into
 * `_shell`, then `_command_interpreter`, then `_router`. The Router peels the
 * worker's name off TO and hands the command to that worker's RemoteIpc, which
 * bundles a leading `connect_worker_input` and POSTs the pair through the
 * shared `_http`.
 *
 * RECEIVE. Each RemoteIpc owns an SseIn child that forwards parsed frames to
 * `_router`, which peels the reply node's name and delivers to `_output` (the
 * Dumper), `_metadata`, `_uptime` or `_dmesg`. Nothing here correlates a
 * reply: the server answers TO=FROM, so the address a node minted is what
 * brings its own answer home (ADR-7).
 *
 * Flow is steered by each node's `target`, never by pointing a `sink` at an
 * arbitrary node (ADR-7). All three pollers target `_cwd`, whose own `target`
 * IS the cwd, so a `cd` re-aims the three of them by moving one string.
 *
 * The pollers hold no clock of their own. Each arms its cadence on the shared
 * wall-clock grid the `_router` TIMER drives (ADR-17), so harmonic cadences
 * meet on one tick and everything minted there leaves in one batched POST.
 *
 * Every class this file resolves by NAME through `makeNode` is a substrate
 * builtin, present in every bundle's class table. A view class from another
 * bundle is not, and has to be handed over as the class itself (ADR-16).
 *
 * Node names come from `reserved-node-names.json`, canonical for PHP and JS.
 */

/**
 * The catalog a caller that passes none gets.
 *
 * One stable object rather than a fresh literal per render: `catalog.classes`
 * is a dependency of the seed effect below, and a new array each render would
 * re-run that effect on every pass.
 */
const NO_CATALOG = { classes: [], loading: false, error: null };

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

/**
 * What a document arriving with no include expansion is composed against: no
 * nodes, no edges, no include tree, no hulls.
 */
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

/** Stands in for a cleared transcript, so persistence stores `[]`, not null. */
const EMPTY_TRANSCRIPT = [];

/**
 * Mount the console's node graph for one session and keep it standing while
 * `enabled`.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`, so `cd /{worker}`
 * routes straight to it and no node demultiplexes replies for several workers
 * (ADR-7). Only one SSE stream is live at a time, because slots are a finite
 * host-wide pool: the active worker's RemoteIpc steals it on a send or a
 * connect.
 *
 * The view nodes come down on unmount and on entering edit mode. The backbone
 * beneath them stands for as long as the console is mounted.
 *
 * @param {Object}            params
 * @param {string}            params.topology        Topology name.
 * @param {number}            params.partition       Partition number.
 * @param {boolean}           params.enabled         Mount the graph; false is edit mode.
 * @param {string[]}          [params.workers]       Active worker readers (`['aggregator.p0', …]`); one RemoteIpc per entry.
 * @param {boolean}           [params.streamEnabled] Open the active worker's SSE stream (cwd is a worker). The graph stays mounted regardless; this only gates the EventSource, so cd-ing off a worker stops streaming without rebuilding. Default true.
 * @param {{current: number}} params.debugLevelRef   Ref holding the Dumper's verbosity dial.
 * @param {Object}            [params.catalog]       The PHP class catalog slice — `{ classes, loading, error }`. The seed waits on it: without a class's schema a custom fan-out seeds the wrong edges.
 * @return {{status: string, ssePid: ?number, shell: ?ShellNode, seedError: ?Object, outgoing: ?OutgoingGateNode}}
 *   `status` is `open`, `connecting` while no SSE pid has landed, or `closed`
 *   in edit mode. `shell` is the anonymous Shell a REPL fills and `outgoing`
 *   its gate. `seedError` is whatever the pre-metadata seed threw — unnarrowed,
 *   because its consumer folds it into a union with two REST error shapes.
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

	// A hidden tab throttles the heartbeat until the slot TTLs out.
	const isPageVisible = usePageVisibility();

	// Reset Graph bumps the generation, which re-runs the effects below.
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
	// interpreter down under them leaves their commands sinking into a removed
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

		// The shared rule-#2 backbone: _command_interpreter sinks into _router.
		const {
			interpreter,
			shell: shellTap,
			teardown: teardownSpine,
		} = mountExospine();
		// Interpreter ships the PHP verb set as built-ins (no overrides).

		// Rule #2: the Dumper sinks into the interpreter and stamps no target.
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRefRef.current;
		dumper.name = names.OUTPUT;
		dumper.sink = interpreter;
		// Persist on every change; restore what the last session left.
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
		// Built for its name alone: React reads `_completion`'s candidates.
		const completion = interpreter.makeNode(
			'Completion',
			names.COMPLETION
		);

		// One RemoteIpc per worker, each owning an SseIn; one live stream.
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

		// Polls address `_cwd`; its `target` is the cwd and re-stamps TO.
		const cwdNode = new Node();
		cwdNode.name = names.CWD;
		cwdNode.sink = interpreter;
		// Seed cwd to the default path so polls route before the gate runs.
		cwdNode.target = reader;

		const outgoingGate = new OutgoingGateNode();
		outgoingGate.sink = shellTap;

		// Anonymous React Shell, sinking into the gate ahead of `_shell`.
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

		// The Router's grid drives all three; a shared tick is ONE POST.
		metadata.sink = interpreter;
		uptime.sink = interpreter;
		dmesg.sink = interpreter;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		dmesg.target = names.CWD;
		// A bare setTimer() arms each poller at its own cadence, not 1s.
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
		// `workersKey` projects `workers` stably; the array's identity churns.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ topology, partition, enabled, workersKey, generation ] );

	/**
	 * Paint the declared topology before the first `dump_metadata` reply lands.
	 *
	 * Seed the COMPOSED graph. A topology that mostly `include`s others owns few
	 * nodes of its own, so seeding the parsed file alone paints a sliver and the
	 * rest pops in on the next `dump_metadata` — a staged paint no autofit
	 * survives. `topologies get` ships the expansion that composition needs.
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

		/**
		 * Compose the document with its expansion, then seed `_metadata`.
		 *
		 * `async` with nothing to await: it turns a synchronous throw —
		 * `withResolvedConfigEdges` on a document whose `<ns:key>` targets
		 * arrived unresolved — into the rejection the `catch` below reports
		 * as `seedError`.
		 */
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
