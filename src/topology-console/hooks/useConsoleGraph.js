/**
 * useConsoleGraph — mounts the per-session in-browser node graph (SseConnector
 * → SessionSink; CommandOut) for the console's live SSE-in + command-out path.
 * Mounted while `enabled`; torn down on unmount or edit mode.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { SseConnector } from '../../runtime/sse_connector';
import { SessionSink } from '../nodes/SessionSink';
import { CommandOut } from '../nodes/CommandOut';
import { getCommandClient } from '../utils/commandClient';

// Registered node names TopologyConsole reads via useNodeState / useNodeFill.
const SESSION_NODE = 'session';
const COMMAND_OUT_NODE = 'command-out';
const SSE_NODE = '_console_sse';

// SSE cadence query param (server fixes its own; SseConnector needs a value).
const STREAM_INTERVAL_MS = 5000;

/**
 * @param {Object}  params
 * @param {string}  params.topology      Topology name.
 * @param {number}  params.partition     Partition number.
 * @param {boolean} params.enabled       Mount the graph (false = edit mode).
 * @param {Object}  params.debugLevelRef React ref holding the Dumper verbosity dial.
 * @return {{status: string, ssePid: ?number, sessionNode: ?SessionSink, commandOutName: string}}
 *   Connection state, the live session node (for append/clear), and the
 *   command-out node name (for useNodeFill).
 */
export function useConsoleGraph( {
	topology,
	partition,
	enabled,
	debugLevelRef,
} ) {
	const [ ssePid, setSsePid ] = useState( null );
	const [ sessionNode, setSessionNode ] = useState( null );

	// Stash the latest debugLevelRef so the effect wires it without re-subscribing.
	const debugLevelRefRef = useRef( debugLevelRef );
	debugLevelRefRef.current = debugLevelRef;

	useEffect( () => {
		if ( ! enabled ) {
			setSsePid( null );
			setSessionNode( null );
			return undefined;
		}

		const data =
			( typeof window !== 'undefined' && window.NewspackNodesData ) || {};

		const session = new SessionSink( {
			debugLevelRef: debugLevelRefRef.current,
		} );
		session.setName( SESSION_NODE );

		const connector = new SseConnector( {
			subscribe: [ `${ topology }.p${ partition }` ],
			interval: STREAM_INTERVAL_MS,
			baseUrl: data.restUrl || '/wp-json/',
			nonce: data.nonce || '',
		} );
		connector.setName( SSE_NODE );
		// Node exposes the sink as a plain property (no setSink helper).
		connector.sink = session;

		const commandOut = new CommandOut( {
			topology,
			partition,
			connector,
			client: getCommandClient(),
		} );
		commandOut.setName( COMMAND_OUT_NODE );

		// Reset to "connecting" (clears a prior worker's pid), then track connected.
		setSsePid( connector.pid() );
		connector.register( 'connected', 'useConsoleGraph', ( payload ) => {
			setSsePid(
				payload && 'number' === typeof payload.pid ? payload.pid : null
			);
			return true;
		} );

		setSessionNode( session );
		connector.start();

		return () => {
			connector.unregister( 'connected', 'useConsoleGraph' );
			connector.close();
			Core.unregisterNode( SSE_NODE );
			Core.unregisterNode( SESSION_NODE );
			Core.unregisterNode( COMMAND_OUT_NODE );
			setSsePid( null );
			setSessionNode( null );
		};
	}, [ topology, partition, enabled ] );

	let status = 'open';
	if ( ! enabled ) {
		status = 'closed';
	} else if ( null === ssePid ) {
		status = 'connecting';
	}

	return { status, ssePid, sessionNode, commandOutName: COMMAND_OUT_NODE };
}
