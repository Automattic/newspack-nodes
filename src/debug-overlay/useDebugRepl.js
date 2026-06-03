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
import { dispatchLocalCommand } from '../topology-console/core/dispatchLocalCommand';
import { DumperNode } from '../runtime/dumper-node';
import { CompletionNode } from '../runtime/completion-node';
import { MetadataNode } from '../runtime/metadata-node';
import { useGraphGeneration } from '../runtime/react';
import { LOCAL, FROM, TO, VALUE } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';

const EMPTY_TRANSCRIPT = [];

/**
 * Mount a Dumper at `_output` for the page's CommandInterpreter, and use the
 * passed-in Shell (owned by DebugOverlay) to parse + dispatch typed REPL lines
 * into the local realm.
 *
 * @param {boolean} active When false the Dumper is torn down (no transcript).
 * @param {Object}  shell  Shell instance owned by DebugOverlay; sink wired to the local interpreter.
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
	// remount counter increments on EVERY (re)mount to force the post-mount
	// re-render — that's what lets sibling useNodeState subscriptions re-bind to
	// the nodes (re)registered in this hook's useEffect. A boolean flag would
	// only fire on the first mount (false→true) and no-op on a Reset-Graph
	// rebuild, stranding those subscriptions on the removed old nodes (the bug
	// that silently killed tab completion after the first reset).
	const [ cwd, setCwd ] = useState( '' );
	const [ , bumpRemount ] = useState( 0 );
	// True once this hook's infra nodes (_output/_completion/_metadata/_cwd) are
	// mounted. The composite readiness in DebugOverlay gates layout on this so
	// coreToGraph() never sees a partial graph missing the overlay's own nodes.
	const [ ready, setReady ] = useState( false );
	// The full-rebuild signal: a bump re-runs this effect (cleanup tears down the
	// overlay's infra nodes, the effect rebuilds them off the fresh backbone) so
	// "Reset Graph" reconstructs the overlay's half of the graph too.
	const generation = useGraphGeneration();

	useEffect( () => {
		if ( ! active ) {
			setTranscript( EMPTY_TRANSCRIPT );
			setReady( false );
			return undefined;
		}
		// Dumper accumulates entries + publishes `transcript` for React subscribers.
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRef;
		dumper.setName( names.OUTPUT );
		dumper.sink = interpreter;
		// Tab completion: `_completion` answers help/ls queries off the cwd.
		const completion = new CompletionNode();
		completion.setName( names.COMPLETION );
		completion.sink = interpreter;
		// Canvas-poll: Metadata fires dump_metadata at _cwd each TIMER tick,
		// publishes the parsed graph via setState('metadata') for the canvas.
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
		metadata.sink = interpreter;
		metadata.target = names.CWD;
		// Hitchhike the _router TIMER: notify_timer calls metadata.fireCb -> fire;
		// metadata.removeNode -> stop_timer unwinds it.
		metadata.setTimer();
		// `_cwd` is the routing indirection — every scope-relative command's TO
		// stamps through this node, which re-stamps the live cwd. Path menu /
		// REPL `cd` just sets `_cwd.target`.
		const cwdNode = new Node();
		cwdNode.setName( names.CWD );
		cwdNode.sink = interpreter;
		cwdNode.target = shell.path;
		// Shell is owned by DebugOverlay; we just adopt the passed-in instance
		// (its path + sink are already configured) and store it on the ref so
		// dispatchStatement can reach it.
		dumperRef.current = dumper;
		shellRef.current = shell;
		setCwd( shell.path );
		bumpRemount( ( n ) => n + 1 );
		const listenerId = 'useDebugRepl/transcript';
		dumper.register( 'transcript', listenerId, ( next ) => {
			setTranscript( next || EMPTY_TRANSCRIPT );
			return true;
		} );
		// All infra nodes are mounted — coreToGraph() now sees the complete graph.
		setReady( true );
		return () => {
			dumper.unregister( 'transcript', listenerId );
			// metadata.removeNode() -> stop_timer -> unregister from the _router's
			// TIMER (TimerNode self-manages the lifecycle; no hand-rolled unregister).
			dumper.removeNode();
			completion.removeNode();
			metadata.removeNode();
			cwdNode.removeNode();
			dumperRef.current = null;
			shellRef.current = null;
			setTranscript( EMPTY_TRANSCRIPT );
			setReady( false );
		};
	}, [ active, shell, generation ] );

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
			// A null shell.sink swallows the dispatch via the `?.` below — the
			// production bug it masked: DebugOverlay's shell.sink useEffect ran
			// while the dashboard's interpreter was still null in Core, the
			// lookup stayed null forever, and every wire command (`ls` /
			// `dump_node` / …) silently produced zero /command POSTs and zero
			// diagnostic. Surface it on Core.stderr so the next time this fires
			// the operator sees what dropped. The fix is upstream (re-bind in
			// DebugOverlay's effect deps); this is the visible canary.
			if ( ! s.sink ) {
				const verb = parsed[ VALUE ]?.name || '?';
				Core.stderr(
					`useDebugRepl: shell.sink is null — REPL command dropped (${ verb })\n`
				);
				return;
			}
			// dispatch (not sink.fill) so useGraphReset's onDispatch tap sees the
			// verb — a REPL rewire dirties the graph exactly like a GUI rewire.
			s.dispatch( parsed );
			return;
		}
		if ( 'error' === parsed.kind ) {
			dumper.append( { kind: 'error', text: parsed.text } );
			return;
		}
		dispatchLocalCommand( {
			parsed,
			append: ( entry ) => dumper.append( entry ),
			clear: () => dumper.clear(),
			debugLevelRef,
		} );
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
		() => ( { transcript, sendLine, append, clear, cwd, setPath, ready } ),
		[ transcript, sendLine, append, clear, cwd, setPath, ready ]
	);
}
