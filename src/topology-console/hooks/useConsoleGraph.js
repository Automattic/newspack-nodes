/**
 * useConsoleGraph — mounts the per-session in-browser node graph (WIRING-PLAN
 * §2/§4 spine). Send: Shell → _command_interpreter → _router ─[peel _http]→
 * _http (HttpOut → POST /command). Receive: _sse (SseIn) → _router ─[peel
 * reply-node]→ _output (Dumper) | _metadata | _uptime. Mounted while `enabled`;
 * torn down on unmount or edit mode. Node names come from the shared-canonical
 * reserved-node-names.json.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { Router } from '../../runtime/router';
import { CommandInterpreter } from '../../runtime/command_interpreter';
import { SseIn } from '../nodes/sseIn';
import { HttpOut } from '../nodes/httpOut';
import { Dumper } from '../nodes/dumper';
import { Metadata } from '../nodes/metadata';
import { Uptime } from '../nodes/uptime';
import { Completion } from '../nodes/completion';
import { Shell } from '../nodes/shell';
import { getCommandClient } from '../utils/commandClient';
import names from '../../runtime/reserved-node-names.json';

// Slot keep-alive: poke `workers/heartbeat` to refresh this session's SSE slot
// TTL. The slot is refreshed EXCLUSIVELY by the client (the server's check_slot
// never refreshes); without this poke the slot TTLs out and the browser
// reconnects every ~minute. Poke at half the TTL so one missed poke survives.
const SLOT_TTL_S = 10;
const SLOT_HEARTBEAT_MS = 5000;

// Every named node this graph mounts — unregistered on teardown.
const GRAPH_NODE_NAMES = [
	names.ROUTER,
	names.COMMAND_INTERPRETER,
	names.OUTPUT,
	names.METADATA,
	names.UPTIME,
	names.COMPLETION,
	names.HTTP,
	names.SSE,
];

/**
 * @param {Object}  params
 * @param {string}  params.topology      Topology name.
 * @param {number}  params.partition     Partition number.
 * @param {boolean} params.enabled       Mount the graph (false = edit mode).
 * @param {Object}  params.debugLevelRef React ref holding the Dumper verbosity dial.
 * @return {{status: string, ssePid: ?number, shell: ?Shell}} Connection state +
 *   the anonymous Shell (the console drives typed input through it).
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
	debugLevelRef,
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

		// Shared spine: Router + CommandInterpreter.
		const router = new Router();
		router.setName( names.ROUTER );

		const ci = new CommandInterpreter();
		ci.setName( names.COMMAND_INTERPRETER );
		ci.sink = router;
		// The CI ships the full PHP verb set as built-ins (make_node, dump_node,
		// dump_metadata, stats, uptime, list_nodes/ls, …) — no local overrides. `ls`
		// defaults to CI siblings (Tachikoma); `ls -a` lists every node, and the
		// column flags (-c/-s/-t) work because the full `_cmdList` runs.

		// Receive-side reply nodes (Router peels TO and delivers to these).
		const dumper = new Dumper( {
			debugLevelRef: debugLevelRefRef.current,
		} );
		dumper.setName( names.OUTPUT );
		const metadata = new Metadata();
		metadata.setName( names.METADATA );
		const uptime = new Uptime();
		uptime.setName( names.UPTIME );
		const completion = new Completion();
		completion.setName( names.COMPLETION );

		// HTTP boundary: Router peels _http and delivers here (TO={reader}).
		const httpOut = new HttpOut( { client: getCommandClient() } );
		httpOut.setName( names.HTTP );

		// SSE in: each parsed Message flows to the Router (NOT the Dumper).
		const sse = new SseIn( {
			subscribe: [ reader ],
			baseUrl: data.restUrl || '/wp-json/',
			nonce: data.nonce || '',
		} );
		sse.setName( names.SSE );
		sse.sink = router;
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
		let slotPoke = null;
		sse.register( 'connected', 'useConsoleGraph', ( payload ) => {
			const pid =
				payload && 'number' === typeof payload.pid ? payload.pid : null;
			setSsePid( pid );
			// Keep this session's SSE slot alive. The slot was acquired at THIS
			// partition (the subscription resolves to it), so the poke must carry
			// `partition` — without it the worker-partition slot TTLs out and the
			// browser reconnects every ~minute. (check_slot never refreshes; only
			// the client's poke does.)
			const slot =
				payload && Number.isInteger( payload.slot )
					? payload.slot
					: null;
			if ( slotPoke ) {
				clearInterval( slotPoke );
				slotPoke = null;
			}
			if ( null !== slot && slot >= 0 ) {
				slotPoke = setInterval( () => {
					getCommandClient()
						.send( {
							to: 'workers',
							verb: 'heartbeat',
							args: `${ slot } ${ SLOT_TTL_S } ${ partition }`,
						} )
						.catch( () => {} );
				}, SLOT_HEARTBEAT_MS );
			}
			return true;
		} );

		// Live-canvas poll on a single Router TIMER (1s). Each tick locks HttpOut,
		// notifies subscribers (Metadata every tick, Uptime on its 5s throttle) —
		// which emit their poll commands through the CI — then flushes HttpOut so
		// the whole tick's emissions ride in ONE POST. pollTo gates emission; the
		// TopologyConsole gating effect sets it (null = suppressed → empty flush).
		metadata.sink = ci;
		uptime.sink = ci;
		metadata.pollTo = consoleShell.path;
		uptime.pollTo = consoleShell.path;
		router.beforeTimerNotify = () => httpOut.lock();
		router.afterTimerNotify = () => httpOut.flush();
		router.register( 'TIMER', names.METADATA, () => metadata.onTimer() );
		router.register( 'TIMER', names.UPTIME, () => uptime.onTimer() );

		setShell( consoleShell );
		sse.start();
		router.startTimer( 1000 );

		return () => {
			router.stopTimer();
			if ( slotPoke ) {
				clearInterval( slotPoke );
			}
			sse.unregister( 'connected', 'useConsoleGraph' );
			sse.close();
			for ( const name of GRAPH_NODE_NAMES ) {
				Core.unregisterNode( name );
			}
			setSsePid( null );
			setShell( null );
		};
	}, [ topology, partition, enabled ] );

	let status = 'open';
	if ( ! enabled ) {
		status = 'closed';
	} else if ( null === ssePid ) {
		status = 'connecting';
	}

	return { status, ssePid, shell };
}
