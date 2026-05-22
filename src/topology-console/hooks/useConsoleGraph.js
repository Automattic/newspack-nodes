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
import { Shell } from '../nodes/shell';
import { getCommandClient } from '../utils/commandClient';
import names from '../../runtime/reserved-node-names.json';

// SSE cadence query param (server fixes its own; SseIn needs a value).
const STREAM_INTERVAL_MS = 5000;

// Every named node this graph mounts — unregistered on teardown.
const GRAPH_NODE_NAMES = [
	names.ROUTER,
	names.COMMAND_INTERPRETER,
	names.OUTPUT,
	names.METADATA,
	names.UPTIME,
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

		// Receive-side reply nodes (Router peels TO and delivers to these).
		const dumper = new Dumper( {
			debugLevelRef: debugLevelRefRef.current,
		} );
		dumper.setName( names.OUTPUT );
		const metadata = new Metadata();
		metadata.setName( names.METADATA );
		const uptime = new Uptime();
		uptime.setName( names.UPTIME );

		// HTTP boundary: Router peels _http and delivers here (TO={reader}).
		const httpOut = new HttpOut( { client: getCommandClient() } );
		httpOut.setName( names.HTTP );

		// SSE in: each parsed Message flows to the Router (NOT the Dumper).
		const sse = new SseIn( {
			subscribe: [ reader ],
			interval: STREAM_INTERVAL_MS,
			baseUrl: data.restUrl || '/wp-json/',
			nonce: data.nonce || '',
		} );
		sse.setName( names.SSE );
		sse.sink = router;

		// Anonymous, React-driven Shell. cwd = _http/{reader} so a typed line
		// routes through _http to the worker; replies pivot back via FROM.
		const consoleShell = new Shell();
		consoleShell.path = `${ names.HTTP }/${ reader }`;
		consoleShell.ssePid = sse.pid();
		consoleShell.sink = ci;

		// Track the connected pid: drives both React state and the Shell pivot.
		setSsePid( sse.pid() );
		sse.register( 'connected', 'useConsoleGraph', ( payload ) => {
			const pid =
				payload && 'number' === typeof payload.pid ? payload.pid : null;
			setSsePid( pid );
			consoleShell.ssePid = pid;
			return true;
		} );

		setShell( consoleShell );
		sse.start();

		return () => {
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
