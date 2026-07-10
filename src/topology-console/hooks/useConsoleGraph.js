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
import { withReplAnchor } from '../utils/draftGraph';
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
 * @return {{status: string, ssePid: ?number, shell: ?ShellNode}} Connection state +
 *   the anonymous Shell (the console drives typed input through it).
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
	workers = [],
	streamEnabled = true,
	debugLevelRef,
} ) {
	const [ ssePid, setSsePid ] = useState( null );
	const [ shell, setShell ] = useState( null );

	// Hidden tab throttles the heartbeat → slot TTLs out; gate on visibility.
	const isPageVisible = usePageVisibility();

	// Reset Graph bumps generation → re-runs the effect, rebuilding a broken graph.
	const generation = useGraphGeneration();

	// Direct `topologies get` for the mount TSL seed; stable identity.
	const fetchTopologyTsl = useTopology();

	// Stash debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	// Stable key over the worker list so the effect rebuilds RemoteIpc on change.
	const workersKey = workers.join( ',' );

	useEffect( () => {
		if ( ! enabled ) {
			setSsePid( null );
			setShell( null );
			return undefined;
		}

		const data =
			( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
		const restUrl = data.restUrl || '/wp-json/';
		const nonce = data.nonce || '';
		const reader = `${ topology }.p${ partition }`;

		// The shared rule-#2 backbone: _command_interpreter → _router.
		const {
			interpreter,
			router,
			shell: shellTap,
			teardown: teardownSpine,
		} = mountExospine();
		// Interpreter ships the full PHP verb set as built-ins (no local overrides).

		// Reply nodes sink into the interpreter (rule #2); Dumper stays bare.
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRefRef.current;
		dumper.name = names.OUTPUT;
		dumper.sink = interpreter;
		// Persist+restore the transcript, else teardown drops it on switch/reload.
		const transcriptListenerId = 'useConsoleGraph/transcript';
		dumper.register( 'transcript', transcriptListenerId, ( next ) => {
			saveHubTranscript( next || EMPTY_TRANSCRIPT );
			return true;
		} );
		dumper.restore( loadHubTranscript() );
		// Substrate soft-nodes via make_node: name + sink=interpreter + args in one.
		const metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		const uptime = interpreter.makeNode( 'Uptime', names.UPTIME );
		// `_dmesg` publishes error/warn/debug counts for the process-stats header.
		const dmesg = interpreter.makeNode( 'Dmesg', names.DMESG );
		const completion = interpreter.makeNode(
			'Completion',
			names.COMPLETION
		);

		// One RemoteIpc per worker (SseIn+HttpOut+Heartbeat); one stream at a time.
		const readers = new Set( [ reader, ...workers ] );
		const remotes = [];
		for ( const wr of readers ) {
			const remote = interpreter.makeNode(
				'RemoteIpc',
				wr,
				`${ wr } ${ restUrl } ${ nonce }`
			);
			remote.target = names.OUTPUT;
			remote.client = getCommandClient();
			// The active worker's connect handshake drives the session pid display.
			remote.onConnected = () => setSsePid( remote.pid() );
			// Reset pid on a steal so a send doesn't wrap the old link's stale pid.
			remote.onClose = () => setSsePid( null );
			remotes.push( remote );
		}

		// Bare mount: list RemoteIpc channels in reinitNames (else Reset sticks).
		Core.reinitNames = [
			...( Core.reinitNames || [] ),
			...remotes.map( ( r ) => r.name ),
		];

		// `_cwd`.target IS the cwd; polls address `_cwd`, Router re-stamps into TO.
		const cwdNode = new Node();
		cwdNode.name = names.CWD;
		cwdNode.sink = interpreter;
		// Seed cwd to the default path so polls route before the gate effect runs.
		cwdNode.target = reader;

		// Anonymous React Shell; sinks into the backbone `_shell` Tap → interpreter.
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
		// Flush the SAME node locked in `before` (a steal must not strand it).
		let tickLocked = null;
		router.beforeTimerNotify = () => {
			tickLocked = RemoteIpcNode.active ?? null;
			tickLocked?.httpOut?.lock();
		};
		router.afterTimerNotify = () => {
			tickLocked?.httpOut?.flush();
			tickLocked = null;
		};
		// Poll nodes hitchhike the _router TIMER (fireCb runs each tick).
		metadata.setTimer();
		uptime.setTimer();
		dmesg.setTimer();

		// Paint the declared topology at once, before SSE/dump_metadata arrives.
		if ( topology ) {
			fetchTopologyTsl( topology )
				.then( ( resp ) => {
					// Anchor `_repl` in the seed so autofit includes it from first paint.
					const seeded = withReplAnchor(
						parseTsl( resp?.tsl || '' )
					);
					// Resolve LIVE metadata by name; skip if a reply already filled it.
					const node = Core.node( names.METADATA );
					const live =
						node?.rawMap && Object.keys( node.rawMap ).length > 0;
					// Seed only at a worker scope (else it paints the wrong graph).
					const onWorker = scopeFromCwd(
						Core.node( names.CWD )?.target ?? ''
					).isWorker;
					if ( node && seeded.nodes.length && ! live && onWorker ) {
						node.setState( 'metadata', seeded );
					}
				} )
				.catch( () => {
					// Best-effort seed; the live poll fills the canvas regardless.
				} );
		}

		setShell( consoleShell );
		// The stream-gating effect owns the EventSource; cd-off can quiet it.

		return () => {
			// Each node owns teardown; unregister before removeNode/teardownSpine.
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
			// Backbone last: stops the router TIMER, removes interpreter/router/_shell.
			teardownSpine();
			setSsePid( null );
			setShell( null );
		};
		// `workersKey` is the stable projection of `workers` (id churn otherwise).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ topology, partition, enabled, workersKey, generation ] );

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

	return { status, ssePid, shell };
}
