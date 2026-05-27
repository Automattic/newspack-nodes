/**
 * useConsoleGraph — mounts the per-session in-browser node graph (WIRING-PLAN
 * §2/§4 spine). Send: Shell → _command_interpreter → _router ─[peel _http]→
 * _http (HttpOut → POST /command). Receive: _sse (SseIn) → _router ─[peel
 * reply-node]→ _output (Dumper) | _metadata | _uptime | _heartbeat. The
 * _metadata / _uptime / _heartbeat poll nodes emit on the Router TIMER (batched
 * into one POST per tick); _heartbeat keeps the SSE slot alive. Mounted while
 * `enabled`; torn down on unmount or edit mode. Node names come from the
 * shared-canonical reserved-node-names.json.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import { mountExospine } from '../../runtime/exospine';
import { SseIn } from '../nodes/sseIn';
import { HttpOut } from '../nodes/httpOut';
import { Dumper } from '../nodes/dumper';
import { Metadata } from '../nodes/metadata';
import { Uptime } from '../nodes/uptime';
import { Completion } from '../nodes/completion';
import { Heartbeat } from '../nodes/heartbeat';
import { Shell } from '../nodes/shell';
import { getCommandClient } from '../utils/commandClient';
import names from '../../runtime/reserved-node-names.json';

// The reply/poll nodes this graph mounts atop the exospine — unregistered on
// teardown. The backbone (`_command_interpreter` + `_router`) is owned and torn
// down by mountExospine's teardown(), so it is NOT listed here.
const GRAPH_NODE_NAMES = [
	names.OUTPUT,
	names.METADATA,
	names.UPTIME,
	names.COMPLETION,
	names.HEARTBEAT,
	names.HTTP,
	names.SSE,
	names.CWD,
];

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
 * @param {number}  params.resetKey      Bump to tear down + rebuild the graph.
 * @return {{status: string, ssePid: ?number, shell: ?Shell}} Connection state +
 *   the anonymous Shell (the console drives typed input through it).
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
	streamEnabled = true,
	debugLevelRef,
	// Bumping this re-runs the graph effect: cleanup tears down the spine, the
	// effect rebuilds it fresh. Lets the "reset" control recover a self-broken
	// browser graph without a full page reload.
	resetKey = 0,
} ) {
	const [ ssePid, setSsePid ] = useState( null );
	const [ shell, setShell ] = useState( null );

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
		const { ci, router, teardown: teardownSpine } = mountExospine();
		// The CI ships the full PHP verb set as built-ins (make_node, dump_node,
		// dump_metadata, stats, uptime, list_nodes/ls, …) — no local overrides. `ls`
		// defaults to CI siblings (Tachikoma); `ls -a` lists every node, and the
		// column flags (-c/-s/-t) work because the full `_cmdList` runs.

		// Receive-side reply nodes (Router peels TO and delivers to these).
		// Reply/boundary nodes are terminal (they render or POST in fill(), never
		// forwarding through sink) — but rule #2 still wires their sink to the CI
		// so the declared topology is uniform: every node sinks into the CI, and
		// _router is the only node left bare.
		const dumper = new Dumper( {
			debugLevelRef: debugLevelRefRef.current,
		} );
		dumper.setName( names.OUTPUT );
		dumper.sink = ci;
		const metadata = new Metadata();
		metadata.setName( names.METADATA );
		const uptime = new Uptime();
		uptime.setName( names.UPTIME );
		const completion = new Completion();
		completion.setName( names.COMPLETION );
		completion.sink = ci;
		// Slot keep-alive: a silent poll node that pokes `workers/heartbeat` on the
		// Router TIMER (batched into the canvas poll's POST) to refresh this
		// session's SSE slot TTL — the slot is refreshed EXCLUSIVELY by the client.
		const heartbeat = new Heartbeat();
		heartbeat.setName( names.HEARTBEAT );

		// `_cwd` is a plain Node whose `target` IS the current working directory.
		// The poll nodes address `_cwd`; Router peels it, the base Node.fill
		// re-stamps the live cwd into TO (or leaves TO empty for the local root),
		// then forwards to the CI. One indirection routes every scope: cd / the
		// Path menu just set `_cwd.target`.
		const cwdNode = new Node();
		cwdNode.setName( names.CWD );
		cwdNode.sink = ci;
		// Seed the cwd to the session's default path (its own worker, the same path
		// the Shell mounts at below) so the polls route before the TopologyConsole
		// gating effect first runs; that effect keeps `_cwd.target` in sync on cd.
		cwdNode.target = `${ names.SSE }/${ reader }`;

		// HTTP boundary: Router peels _http and delivers here (TO={reader}).
		const httpOut = new HttpOut( { client: getCommandClient() } );
		httpOut.setName( names.HTTP );
		httpOut.sink = ci;

		// SSE in: each parsed Message flows to the Router (NOT the Dumper).
		const sse = new SseIn( {
			subscribe: [ reader ],
			baseUrl: data.restUrl || '/wp-json/',
			nonce: data.nonce || '',
		} );
		sse.setName( names.SSE );
		// Rule #2: the SSE node sinks into the CI (which forwards non-command /
		// non-empty-TO traffic to the router); steering is the SSE node's target.
		sse.sink = ci;
		// `_sse` is the session boundary: incoming replies/broadcasts route by TO
		// (target=_output so broadcasts reach the transcript); an outgoing
		// `cd /_sse/…` command gets its reply-node FROM wrapped with the live pid.
		sse.target = names.OUTPUT;

		// Anonymous, React-driven Shell. Default cwd is the private session path
		// `_sse/{reader}` — routes through `_sse`, which wraps the reply privately.
		// (`cd /_http/{reader}` opts into broadcast.) Static: the pid lives only in
		// the wrapped FROM, not the path.
		const consoleShell = new Shell();
		consoleShell.path = `${ names.SSE }/${ reader }`;
		consoleShell.sink = ci;

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
		// which emit their poll commands through the CI — then flushes HttpOut so
		// the whole tick's emissions ride in ONE POST. The canvas polls target
		// `_cwd` (which re-stamps the live cwd, routing every scope through one
		// indirection); the heartbeat pokes the REST `workers` CI via `_sse`.
		metadata.sink = ci;
		uptime.sink = ci;
		heartbeat.sink = ci;
		metadata.target = names.CWD;
		uptime.target = names.CWD;
		heartbeat.target = `${ names.SSE }/workers`;
		router.beforeTimerNotify = () => httpOut.lock();
		router.afterTimerNotify = () => httpOut.flush();
		router.register( 'TIMER', names.METADATA, () => metadata.onTimer() );
		router.register( 'TIMER', names.UPTIME, () => uptime.onTimer() );
		router.register( 'TIMER', names.HEARTBEAT, () => heartbeat.onTimer() );

		setShell( consoleShell );
		// The EventSource is opened/closed by the stream-gating effect below (it
		// depends on `streamEnabled`, which the graph build must not), so cd-ing off
		// a worker can quiet the stream without tearing the whole graph down.
		router.startTimer( 1000 );

		return () => {
			heartbeat.clearSlot();
			sse.unregister( 'connected', 'useConsoleGraph' );
			sse.close();
			for ( const name of GRAPH_NODE_NAMES ) {
				Core.unregisterNode( name );
			}
			// The backbone last: stops the router TIMER and removes CI + router.
			teardownSpine();
			setSsePid( null );
			setShell( null );
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ topology, partition, enabled, resetKey ] );

	// SSE stream gating: open the EventSource only while the graph is mounted AND
	// the cwd is a worker (streamEnabled). Closing on cd-off-worker drops the pid
	// and the heartbeat slot (the keepalive goes quiet, so the server reclaims the
	// slot at TTL); cd-ing back reopens and re-acquires via the `connected` event.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const sse = Core.node( names.SSE );
		if ( ! sse ) {
			return undefined;
		}
		if ( streamEnabled ) {
			sse.start();
		} else {
			sse.close();
			Core.node( names.HEARTBEAT )?.clearSlot();
			setSsePid( null );
		}
		return undefined;
	}, [ streamEnabled, topology, partition, enabled ] );

	let status = 'open';
	if ( ! enabled ) {
		status = 'closed';
	} else if ( null === ssePid ) {
		status = 'connecting';
	}

	return { status, ssePid, shell };
}
