import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
import { Node } from '../runtime/node';
import { splitStatements } from '../topology-console/nodes/shell';
import { Dumper } from '../runtime/dumper';
import { Completion } from '../runtime/completion';
import { Metadata } from '../runtime/metadata';
import { Uptime } from '../runtime/uptime';
import { LOCAL, FROM, TO } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';

const EMPTY_TRANSCRIPT = [];

/**
 * Mount a Dumper at `_output` for the page's CommandInterpreter, and use the
 * passed-in Shell (owned by DebugOverlay) to parse + dispatch typed REPL lines
 * into the local realm.
 *
 * @param {boolean} active When false the Dumper is torn down (no transcript).
 * @param {Object}  shell  Shell instance owned by DebugOverlay; sink wired to the local CI.
 * @return {{ transcript: Array, sendLine: Function, clear: Function }} Reactive
 *   transcript + a `sendLine( line )` that runs the line through Shell and the
 *   matching subset of TopologyConsole's local-scope dispatch.
 */
export function useDebugRepl( active = true, shell ) {
	// Stable refs so re-renders don't rebuild the Shell or remap the Dumper.
	const shellRef = useRef( null );
	const dumperRef = useRef( null );
	const debugLevelRef = useRef( 0 );
	// Transcript mirror — driven by a `transcript` subscription on the Dumper so
	// every append/clear re-renders the prompt subscribers. Defaults to empty so
	// the first render before the effect runs shows a stable empty list.
	const [ transcript, setTranscript ] = useState( EMPTY_TRANSCRIPT );
	// cwd reflects the live Shell.path; re-rendered after every dispatch so the
	// Header path selector + _cwd.target both follow REPL `cd` commands.
	// String-typed init (consumers concatenate it into `/${cwd}`); a separate
	// `mounted` flag forces the post-mount re-render so sibling useNodeState
	// subscriptions bind to nodes registered in this hook's useEffect.
	const [ cwd, setCwd ] = useState( '' );
	const [ , setMounted ] = useState( false );

	useEffect( () => {
		if ( ! active ) {
			setTranscript( EMPTY_TRANSCRIPT );
			return undefined;
		}
		// The host page (a dashboard hook like useAggregatorAdminGraph) may have
		// already mounted some of these I/O nodes onto the same Core registry —
		// there's only one Core per process, so a second `setName('_output')`
		// throws "node name collision". For each node the REPL needs, BORROW
		// the existing one if Core already has it (the dashboard's Dumper /
		// Completion / etc. are functionally identical to ours); only mount +
		// own a node when the slot is empty. Teardown only removes ones we
		// minted; borrowed nodes outlive the overlay.
		const ci = Core.node( names.COMMAND_INTERPRETER );
		const router = Core.node( names.ROUTER );
		const owned = [];
		const acquire = ( name, factory ) => {
			const existing = Core.node( name );
			if ( existing ) {
				return existing;
			}
			const node = factory();
			node.setName( name );
			owned.push( node );
			return node;
		};
		// Dumper accumulates entries + publishes `transcript` for React subscribers.
		const dumper = acquire( names.OUTPUT, () => {
			const d = new Dumper();
			d.debugLevelRef = debugLevelRef;
			d.sink = ci;
			return d;
		} );
		// Tab completion: `_completion` answers help/ls queries off the cwd.
		acquire( names.COMPLETION, () => {
			const c = new Completion();
			c.sink = ci;
			return c;
		} );
		// Canvas-poll: Metadata fires dump_metadata at _cwd each TIMER tick,
		// publishes the parsed graph via setState('metadata') for the canvas.
		// If a Metadata is already mounted by the host page it already has its
		// TIMER registration; only register the timer for one we mint.
		const metadata = acquire( names.METADATA, () => {
			const m = new Metadata();
			m.sink = ci;
			m.target = names.CWD;
			return m;
		} );
		if ( owned.includes( metadata ) ) {
			router?.register( 'TIMER', names.METADATA, () =>
				metadata.onTimer()
			);
		}
		const uptime = acquire( names.UPTIME, () => {
			const u = new Uptime();
			u.sink = ci;
			u.target = names.CWD;
			return u;
		} );
		if ( owned.includes( uptime ) ) {
			router?.register( 'TIMER', names.UPTIME, () => uptime.onTimer() );
		}
		// `_cwd` is the routing indirection — every scope-relative command's TO
		// stamps through this node, which re-stamps the live cwd. Path menu /
		// REPL `cd` just sets `_cwd.target`.
		const cwdNode = acquire( names.CWD, () => {
			const n = new Node();
			n.sink = ci;
			n.target = shell.path;
			return n;
		} );
		// Whether we minted _cwd or borrowed it, the REPL drives its target.
		cwdNode.target = shell.path;
		// Shell is owned by DebugOverlay; we just adopt the passed-in instance
		// (its path + sink are already configured) and store it on the ref so
		// dispatchStatement can reach it.
		dumperRef.current = dumper;
		shellRef.current = shell;
		setCwd( shell.path );
		setMounted( true );
		const listenerId = 'useDebugRepl/transcript';
		dumper.register( 'transcript', listenerId, ( next ) => {
			setTranscript( next || EMPTY_TRANSCRIPT );
			return true;
		} );
		return () => {
			dumper.unregister( 'transcript', listenerId );
			// Only remove nodes we minted; borrowed nodes (already in Core when
			// we acquired them) belong to the host page and must outlive us.
			for ( const node of owned ) {
				node.removeNode();
			}
			dumperRef.current = null;
			shellRef.current = null;
			setTranscript( EMPTY_TRANSCRIPT );
			setMounted( false );
		};
	}, [ active, shell ] );

	const append = useCallback( ( entry ) => {
		dumperRef.current?.append( entry );
	}, [] );

	const clear = useCallback( () => {
		dumperRef.current?.clear();
	}, [] );

	// Run one statement through the Shell and act on the three return shapes the
	// console's local-scope dispatch handles (no worker pivot, no SSE).
	const dispatchStatement = useCallback( ( statement ) => {
		const s = shellRef.current;
		const dumper = dumperRef.current;
		if ( ! s || ! dumper ) {
			return;
		}
		const parsed = s.parse( statement );
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
			s.sink?.fill( parsed );
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
			// Pick up any shell.path change from `cd` and mirror it to _cwd.target
			// and our reactive cwd state. (Shell.parse mutates path in place.)
			const s = shellRef.current;
			if ( s && s.path !== cwd ) {
				const cwdNode = Core.node( names.CWD );
				if ( cwdNode ) {
					cwdNode.target = s.path;
				}
				setCwd( s.path );
			}
		},
		[ dispatchStatement, cwd ]
	);

	// Programmatic path change (e.g. from the Header path menu) — equivalent
	// to typing `cd /<path>` at the prompt.
	const setPath = useCallback(
		( path ) => {
			sendLine( `cd /${ path }` );
		},
		[ sendLine ]
	);

	return useMemo(
		() => ( { transcript, sendLine, append, clear, cwd, setPath } ),
		[ transcript, sendLine, append, clear, cwd, setPath ]
	);
}
