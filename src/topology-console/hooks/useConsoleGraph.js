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
import { scopeFromCwd } from '../utils/scope';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import names from '../../runtime/reserved-node-names.json';

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

	// A long-hidden tab throttles the heartbeat TIMER, so the SSE slot TTLs out and
	// the stream dies. Gate the stream on visibility (same pattern as the dashboards):
	// close while hidden, reopen on refocus.
	const isPageVisible = usePageVisibility();

	// Reset Graph bumps the generation; including it here re-runs the graph effect
	// (cleanup tears down the spine, the effect rebuilds it fresh off the canonical
	// wiring) — recovering a self-broken browser graph without a page reload.
	const generation = useGraphGeneration();

	// Direct `topologies get` fetch (the same one edit mode uses) for the mount
	// TSL seed below; stable identity, so the build effect can call it freely.
	const fetchTopologyTsl = useTopology();

	// Stash the latest debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	// Stable key over the worker list so the effect rebuilds the RemoteIpc set when
	// the active-worker list changes (a topology started/stopped elsewhere).
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
			teardown: teardownSpine,
		} = mountExospine();
		// The interpreter ships the full PHP verb set as built-ins (make_node, dump_node,
		// dump_metadata, stats, uptime, list_nodes/ls, …) — no local overrides. `ls`
		// defaults to interpreter siblings (Tachikoma); `ls -a` lists every node, and the
		// column flags (-c/-s/-t) work because the full `_cmdList` runs.

		// Receive-side reply nodes (Router peels TO and delivers to these).
		// Reply/boundary nodes are terminal (they render in fill(), never
		// forwarding through sink) — but rule #2 still wires their sink to the interpreter
		// so the declared topology is uniform: every node sinks into the interpreter, and
		// _router is the only node left bare.
		// Dumper stays bare new+named — it needs the debugLevelRef before sink.
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRefRef.current;
		dumper.name = names.OUTPUT;
		dumper.sink = interpreter;
		// Substrate soft-nodes (registered in includeNodes) via make_node:
		// name + sink=interpreter + arguments in one call.
		const metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		const uptime = interpreter.makeNode( 'Uptime', names.UPTIME );
		const completion = interpreter.makeNode(
			'Completion',
			names.COMPLETION
		);

		// One RemoteIpc per active worker, named `{topology}.p{N}`. Each composes a
		// SseIn (receive), an HttpOut (POST /command), and a Heartbeat (slot
		// keepalive) plus the connected→slot bridge. `cd /{worker}` routes straight
		// to it; only one stream is live at a time (the active RemoteIpc steals it).
		// The session's own worker is guaranteed present even if the active-worker
		// list hasn't caught up yet, so the default cwd always has a channel.
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
			// The active worker's connected payload drives the session pid display.
			remote.onConnected = ( payload ) =>
				setSsePid(
					payload && 'number' === typeof payload.pid
						? payload.pid
						: null
				);
			// A steal closes the old active link before the new one handshakes;
			// reset the displayed pid so a B-bound send doesn't wrap A's stale pid
			// into the reply FROM. The new worker's onConnected repopulates it.
			remote.onClose = () => setSsePid( null );
			remotes.push( remote );
		}

		// `_cwd` is a plain Node whose `target` IS the current working directory.
		// The poll nodes address `_cwd`; Router peels it, the base Node.fill
		// re-stamps the live cwd into TO (or leaves TO empty for the local root),
		// then forwards to the interpreter. One indirection routes every scope: cd / the
		// Path menu just set `_cwd.target`.
		const cwdNode = new Node();
		cwdNode.name = names.CWD;
		cwdNode.sink = interpreter;
		// Seed the cwd to the session's default path (its own worker, the same path
		// the Shell mounts at below) so the polls route before the TopologyConsole
		// gating effect first runs; that effect keeps `_cwd.target` in sync on cd.
		cwdNode.target = reader;

		// Named Tap node for the console Shell to route typed input through.
		const consoleTap = interpreter.makeNode( 'Tap', names.CONSOLE_TAP );
		consoleTap.sink = interpreter;

		// Anonymous, React-driven Shell. Default cwd is the session's own worker
		// `{reader}` — routes straight to that worker's RemoteIpc, which wraps the
		// reply privately. Static: the pid lives only in the wrapped FROM, not the path.
		const consoleShell = new ShellNode();
		consoleShell.path = reader;
		consoleShell.sink = consoleTap;

		setSsePid( null );

		// Live-canvas poll on a single Router TIMER (1s). Each tick locks the ACTIVE
		// RemoteIpc's HttpOut, notifies subscribers (Metadata every tick, Uptime on
		// its 5s throttle) — which emit their poll commands through the interpreter →
		// the cwd worker's RemoteIpc → its HttpOut — then flushes it so the whole
		// tick's emissions ride in ONE POST. The canvas polls target `_cwd` (which
		// re-stamps the live cwd, routing every scope through one indirection).
		metadata.sink = interpreter;
		uptime.sink = interpreter;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		// Capture the node locked in `before` and flush THAT SAME node in `after`:
		// a tick that steals `active` to a new worker mid-notify must not strand the
		// old link's HttpOut locked (lock OLD, flush NEW would).
		let tickLocked = null;
		router.beforeTimerNotify = () => {
			tickLocked = RemoteIpcNode.active ?? null;
			tickLocked?.httpOut?.lock();
		};
		router.afterTimerNotify = () => {
			tickLocked?.httpOut?.flush();
			tickLocked = null;
		};
		// Each poll node hitchhikes the _router TIMER (set_timer() with no args):
		// the router's notify_timer calls their fireCb -> fire directly each tick.
		metadata.setTimer();
		uptime.setTimer();

		// Paint the topology's declared structure immediately: the same direct
		// `topologies get` edit mode uses (independent of the SSE stream), parsed
		// via parseTsl and published as the metadata graph — so the schematic shows
		// while the SSE connect, the first TIMER tick, and the dump_metadata
		// round-trip are still in flight. The first real dump_metadata reply then
		// overwrites it with the live-enriched graph.
		if ( topology ) {
			fetchTopologyTsl( topology )
				.then( ( resp ) => {
					const seeded = parseTsl( resp?.tsl || '' );
					// Resolve the LIVE metadata node by name (not the closed-over
					// build instance): a rebuild may have replaced it while this was
					// in flight. Skip if a dump_metadata reply already populated the
					// graph (the round-trip can beat this async seed on a warm worker).
					const node = Core.node( names.METADATA );
					const live =
						node?.rawMap && Object.keys( node.rawMap ).length > 0;
					// Seed a topology only at a worker scope: at `/` (or `_http`) the canvas shows the in-browser graph, so seeding would paint the wrong graph and stomp its layout.
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
		// The EventSource is opened/closed by the stream-gating effect below (it
		// depends on `streamEnabled`, which the graph build must not), so cd-ing off
		// a worker can quiet the stream without tearing the whole graph down.

		return () => {
			// Each node owns its teardown: removeNode() clears registrations/sink and,
			// for the Timer poll nodes, stop_timer -> unregister from the _router's
			// TIMER set — so a closure can't outlive the node. The RemoteIpcs close
			// their streams + tear down their children (and clear the active claim).
			// Before teardownSpine so the router still exists when those nodes unregister.
			dumper.removeNode();
			metadata.removeNode();
			uptime.removeNode();
			completion.removeNode();
			consoleTap.removeNode();
			for ( const remote of remotes ) {
				remote.removeNode();
			}
			// The RemoteIpcs share these reserved-name singletons and deliberately
			// leave them registered on their own teardown ("for the graph to tear
			// down"). The graph IS here — remove them while the router still exists
			// (the Heartbeat unregisters from its TIMER set), so the next tab's
			// `makeNode( 'HttpOut', '_http' )` can't collide with an orphan.
			Core.node( names.HTTP )?.removeNode();
			Core.node( names.HEARTBEAT )?.removeNode();
			cwdNode.removeNode();
			// The backbone last: stops the router TIMER and removes interpreter + router.
			teardownSpine();
			setSsePid( null );
			setShell( null );
		};
		// `workersKey` is the stable string projection of `workers`; depending on the
		// array identity would rebuild the graph on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ topology, partition, enabled, workersKey, generation ] );

	// SSE stream gating: open the active worker's stream only while the graph is
	// mounted, the cwd is a worker (streamEnabled), AND the tab is visible. Closing
	// on cd-off-worker OR tab-hide drops the pid and the heartbeat slot (the
	// keepalive goes quiet, so the server reclaims the slot at TTL); cd-ing back or
	// refocusing reopens via the next poll/cd's fill→connect.
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
