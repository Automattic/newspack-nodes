import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
import { Shell, splitStatements } from '../topology-console/nodes/shell';
import { Dumper } from '../topology-console/nodes/dumper';
import { LOCAL, FROM, TO } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';

const EMPTY_TRANSCRIPT = [];

/**
 * Construct a Shell + Dumper pair clipped onto the page's own CommandInterpreter
 * so the debug overlay can dispatch arbitrary REPL lines into the local realm.
 *
 * @param {boolean} active When false the Shell/Dumper are torn down (no transcript).
 * @return {{ transcript: Array, sendLine: Function, clear: Function }} Reactive
 *   transcript + a `sendLine( line )` that runs the line through Shell and the
 *   matching subset of TopologyConsole's local-scope dispatch.
 */
export function useDebugRepl( active = true ) {
	// Stable refs so re-renders don't rebuild the Shell or remap the Dumper.
	const shellRef = useRef( null );
	const dumperRef = useRef( null );
	const debugLevelRef = useRef( 0 );
	// Transcript mirror — driven by a `transcript` subscription on the Dumper so
	// every append/clear re-renders the prompt subscribers. Defaults to empty so
	// the first render before the effect runs shows a stable empty list.
	const [ transcript, setTranscript ] = useState( EMPTY_TRANSCRIPT );

	useEffect( () => {
		if ( ! active ) {
			setTranscript( EMPTY_TRANSCRIPT );
			return undefined;
		}
		// Dumper accumulates entries + publishes `transcript` for React subscribers.
		const dumper = new Dumper( { debugLevelRef } );
		dumper.setName( names.OUTPUT );
		// Shell parses typed lines into Messages and fills them into the local CI.
		const shell = new Shell();
		shell.path = '';
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		dumperRef.current = dumper;
		shellRef.current = shell;
		const listenerId = 'useDebugRepl/transcript';
		dumper.register( 'transcript', listenerId, ( next ) => {
			setTranscript( next || EMPTY_TRANSCRIPT );
			return true;
		} );
		return () => {
			dumper.unregister( 'transcript', listenerId );
			dumper.removeNode();
			dumperRef.current = null;
			shellRef.current = null;
			setTranscript( EMPTY_TRANSCRIPT );
		};
	}, [ active ] );

	const append = useCallback( ( entry ) => {
		dumperRef.current?.append( entry );
	}, [] );

	const clear = useCallback( () => {
		dumperRef.current?.clear();
	}, [] );

	// Run one statement through the Shell and act on the three return shapes the
	// console's local-scope dispatch handles (no worker pivot, no SSE).
	const dispatchStatement = useCallback( ( statement ) => {
		const shell = shellRef.current;
		const dumper = dumperRef.current;
		if ( ! shell || ! dumper ) {
			return;
		}
		const parsed = shell.parse( statement );
		if ( '' !== statement.trim() ) {
			dumper.append( {
				kind: 'sent',
				text: statement,
				prompt: '/',
			} );
		}
		if ( null === parsed ) {
			return;
		}
		if ( Array.isArray( parsed ) ) {
			// FROM routes the reply back to our Dumper.
			if ( ! parsed[ FROM ] ) {
				parsed[ FROM ] = names.OUTPUT;
			}
			if ( undefined === parsed[ LOCAL ] ) {
				parsed[ LOCAL ] = true;
			}
			// Ignore TO that's non-empty? Overlay is local-only; trust Shell.
			if ( undefined === parsed[ TO ] ) {
				parsed[ TO ] = '';
			}
			shell.sink?.fill( parsed );
			return;
		}
		if ( 'error' === parsed.kind ) {
			dumper.append( { kind: 'error', text: parsed.text } );
			return;
		}
		if ( 'local' !== parsed.kind ) {
			return;
		}
		if ( 'clear' === parsed.name ) {
			dumper.clear();
			return;
		}
		if ( 'echo' === parsed.name ) {
			dumper.append( { kind: 'recv', text: parsed.text } );
			return;
		}
		if ( 'status' === parsed.name ) {
			for ( const line of parsed.lines ) {
				dumper.append( { kind: 'recv', text: line } );
			}
			return;
		}
		if ( 'debug_level' === parsed.name ) {
			if ( null === parsed.level ) {
				debugLevelRef.current = debugLevelRef.current > 0 ? 0 : 1;
			} else {
				debugLevelRef.current = Math.max(
					0,
					Math.min( 2, parsed.level )
				);
			}
			dumper.append( {
				kind: 'info',
				text: `debug_level: ${ debugLevelRef.current }`,
			} );
			return;
		}
		if ( 'show_parse' === parsed.name ) {
			dumper.append( {
				kind: 'info',
				text: `show_parse: ${ parsed.on ? 'on' : 'off' }`,
			} );
		}
	}, [] );

	const sendLine = useCallback(
		( line ) => {
			for ( const stmt of splitStatements( line ) ) {
				dispatchStatement( stmt );
			}
		},
		[ dispatchStatement ]
	);

	return useMemo(
		() => ( { transcript, sendLine, append, clear } ),
		[ transcript, sendLine, append, clear ]
	);
}
