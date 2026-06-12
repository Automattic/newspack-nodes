/**
 * useConsoleGraph — mounts the per-session in-browser node graph (WIRING-PLAN
 * §2/§4 spine). Send: Shell → _command_interpreter → _router ─[peel _http]→
 * _http (HttpOut → POST /command). Receive: _sse (SseInNode) → _router ─[peel
 * reply-node]→ _output (Dumper) | _metadata | _uptime | _heartbeat. The
 * _metadata / _uptime / _heartbeat poll nodes emit on the Router TIMER (batched
 * into one POST per tick); _heartbeat keeps the SSE slot alive. Mounted while
 * `enabled`; torn down on unmount or edit mode. Node names come from the
 * shared-canonical reserved-node-names.json.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { useGraphGeneration } from '../../runtime/react';
import { Node } from '../../runtime/node';
import { mountExospine } from '../../runtime/exospine';
import { DumperNode } from '../../runtime/dumper-node';
import { ShellNode } from '../../runtime/shell-node';
import { getCommandClient } from '../utils/commandClient';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import names from '../../runtime/reserved-node-names.json';

/**
 * @param {Object}  params
 * @param {string}  params.topology      Topology name.
 * @param {number}  params.partition     Partition number.
 * @param {boolean} params.enabled       Mount the graph (false = edit mode).
 * @param {boolean} params.streamEnabled Open the SSE stream (cwd is a worker).
 *                                       The graph (nodes) stays mounted regardless; this only gates the EventSource,
 *                                       so cd-ing off a worker stops streaming without rebuilding the graph. Default
 *                                       true (the initial cwd is the session's own worker).
 * @param {Object}  params.debugLevelRef React ref holding the Dumper verbosity dial.
 * @return {{status: string, ssePid: ?number, shell: ?ShellNode}} Connection state +
 *   the anonymous Shell (the console drives typed input through it).
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
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

	// Stash the latest debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	useEffect( () => {
		if ( ! enabled ) {
			setSsePid( null );
			setShell( null );
			return undefined;
		}

		const data =
			( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
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
		// Reply/boundary nodes are terminal (they render or POST in fill(), never
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
		// Slot keep-alive: a silent poll node that pokes `workers/heartbeat` on the
		// Router TIMER (batched into the canvas poll's POST) to refresh this
		// session's SSE slot TTL — the slot is refreshed EXCLUSIVELY by the client.
		const heartbeat = interpreter.makeNode( 'Heartbeat', names.HEARTBEAT );

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
		cwdNode.target = `${ names.SSE }/${ reader }`;

		// HTTP boundary: Router peels _http and delivers here (TO={reader}).
		const httpOut = interpreter.makeNode( 'HttpOut', names.HTTP );
		httpOut.client = getCommandClient();

		// SSE in: each parsed Message flows to the Router (NOT the Dumper).
		// Three-token positional config: `{subscribe} {baseUrl} {nonce}` —
		// subscribe is comma-joined; SseConnector's arguments= setter splits it.
		// Rule #2: the SSE node sinks into the interpreter (which forwards non-command /
		// non-empty-TO traffic to the router); steering is the SSE node's target.
		const sse = interpreter.makeNode(
			'SseIn',
			names.SSE,
			`${ reader } ${ data.restUrl || '/wp-json/' } ${ data.nonce || '' }`
		);
		// `_sse` is the session boundary: incoming replies/broadcasts route by TO
		// (target=_output so broadcasts reach the transcript); an outgoing
		// `cd /_sse/…` command gets its reply-node FROM wrapped with the live pid.
		sse.target = names.OUTPUT;

		// Anonymous, React-driven Shell. Default cwd is the private session path
		// `_sse/{reader}` — routes through `_sse`, which wraps the reply privately.
		// (`cd /_http/{reader}` opts into broadcast.) Static: the pid lives only in
		// the wrapped FROM, not the path.
		const consoleShell = new ShellNode();
		consoleShell.path = `${ names.SSE }/${ reader }`;
		consoleShell.sink = interpreter;

		setSsePid( sse.pid() );
		sse.register( 'connected', 'useConsoleGraph', ( payload ) => {
			const pid =
				payload && 'number' === typeof payload.pid ? payload.pid : null;
			setSsePid( pid );
			// Hand the Heartbeat node the slot it must keep alive. The slot was
			// acquired at THIS partition (the subscription resolves to it), so the
			// poke carries `partition` — without it the worker-partition slot TTLs
			// out and the browser reconnects every ~minute. No slot → clear it.
			const slot =
				payload && Number.isInteger( payload.slot )
					? payload.slot
					: null;
			if ( null !== slot && slot >= 0 ) {
				heartbeat.setSlot( slot, partition );
			} else {
				heartbeat.clearSlot();
			}
			return true;
		} );

		// Live-canvas poll on a single Router TIMER (1s). Each tick locks HttpOut,
		// notifies subscribers (Metadata every tick, Uptime on its 5s throttle) —
		// which emit their poll commands through the interpreter — then flushes HttpOut so
		// the whole tick's emissions ride in ONE POST. The canvas polls target
		// `_cwd` (which re-stamps the live cwd, routing every scope through one
		// indirection); the heartbeat pokes the REST `workers` CI via `_sse`.
		metadata.sink = interpreter;
		uptime.sink = interpreter;
		heartbeat.sink = interpreter;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		heartbeat.target = `${ names.HTTP }/workers`;
		router.beforeTimerNotify = () => httpOut.lock();
		router.afterTimerNotify = () => httpOut.flush();
		// Each poll node hitchhikes the _router TIMER (set_timer() with no args):
		// the router's notify_timer calls their fireCb -> fire directly each tick.
		metadata.setTimer();
		uptime.setTimer();
		heartbeat.setTimer();

		setShell( consoleShell );
		// The EventSource is opened/closed by the stream-gating effect below (it
		// depends on `streamEnabled`, which the graph build must not), so cd-ing off
		// a worker can quiet the stream without tearing the whole graph down.

		return () => {
			heartbeat.clearSlot();
			sse.unregister( 'connected', 'useConsoleGraph' );
			sse.close();
			// Each node owns its teardown: removeNode() clears registrations/sink and,
			// for the Timer poll nodes, stop_timer -> unregister from the _router's
			// TIMER set — so a closure can't outlive the node. Before teardownSpine so
			// the router still exists when those nodes unregister.
			dumper.removeNode();
			metadata.removeNode();
			uptime.removeNode();
			completion.removeNode();
			heartbeat.removeNode();
			httpOut.removeNode();
			sse.removeNode();
			cwdNode.removeNode();
			// The backbone last: stops the router TIMER and removes interpreter + router.
			teardownSpine();
			setSsePid( null );
			setShell( null );
		};
	}, [ topology, partition, enabled, generation ] );

	// SSE stream gating: open the EventSource only while the graph is mounted, the
	// cwd is a worker (streamEnabled), AND the tab is visible. Closing on
	// cd-off-worker OR tab-hide drops the pid and the heartbeat slot (the keepalive
	// goes quiet, so the server reclaims the slot at TTL); cd-ing back or refocusing
	// reopens and re-acquires via the `connected` event. start() is close()-first,
	// so re-running while already open is safe.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const sse = Core.node( names.SSE );
		if ( ! sse ) {
			return undefined;
		}
		if ( streamEnabled && isPageVisible ) {
			sse.start();
		} else {
			sse.close();
			Core.node( names.HEARTBEAT )?.clearSlot();
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
