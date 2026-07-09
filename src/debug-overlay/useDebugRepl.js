import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
import { splitStatements } from '../runtime/shell-node';
import { dispatchLocalCommand } from '../topology-console/core/dispatchLocalCommand';
import { DumperNode } from '../runtime/dumper-node';
import { useGraphGeneration } from '../runtime/react';
import { LOCAL, FROM, TO, VALUE } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import { THEMES, getStoredTheme } from '../topology-console/themes';
import {
	loadTranscript,
	saveTranscript,
	loadDebugLevel,
	saveDebugLevel,
	loadDebugState,
	saveDebugState,
} from '../topology-console/core/consolePersistence';

const EMPTY_TRANSCRIPT = [];

// Construct the overlay's infra ON the page's existing backbone and return the
// live nodes + a teardown. Runs render-phase (before the canvas paints), so the
// graph is complete before auto-layout and shell.sink is bound before any typed
// line can dispatch — no useEffect creates these nodes, no dispatch-time race.
function buildInfra( shell, debugLevelRef, onTranscript ) {
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	// Idempotent under StrictMode's double-invoked useState initializer: if the
	// infra is already registered, reuse the existing Dumper instead of colliding
	// on the reserved _output name.
	const existing = Core.node( names.OUTPUT );
	if ( existing ) {
		shell.sink = Core.node( names.CONSOLE_TAP ) || interpreter;
		return {
			dumper: existing,
			teardown: () => {
				existing.removeNode();
				Core.node( names.COMPLETION )?.removeNode();
				Core.node( names.METADATA )?.removeNode();
				Core.node( names.CWD )?.removeNode();
			},
		};
	}
	// `_output` Dumper is a backbone-class node (needs its debugLevelRef), so it
	// stays new+named; the siblings come through the interpreter's make_node.
	const dumper = new DumperNode();
	dumper.debugLevelRef = debugLevelRef;
	dumper.name = names.OUTPUT;
	dumper.sink = interpreter;
	const listenerId = 'useDebugRepl/transcript';
	dumper.register( 'transcript', listenerId, ( next ) => {
		onTranscript( next || EMPTY_TRANSCRIPT );
		saveTranscript( next || EMPTY_TRANSCRIPT ); // persist recent transcript [87].
		return true;
	} );
	// Seed the recent transcript + the browser interpreter's debug_state from the
	// last session [87], so reopening the console restores where you left off.
	dumper.restore( loadTranscript() );
	if ( interpreter ) {
		interpreter.debugState = loadDebugState();
	}
	let completion;
	let metadata;
	let cwdNode;
	if ( interpreter ) {
		// Tab completion: `_completion` answers help/ls queries off the cwd.
		completion = interpreter.makeNode( 'Completion', names.COMPLETION );
		// Canvas-poll: Metadata fires dump_metadata at _cwd each TIMER tick,
		// publishes the parsed graph via setState('metadata') for the canvas.
		metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		metadata.target = names.CWD;
		// Hitchhike the _router TIMER: notify_timer calls metadata.fireCb -> fire;
		// metadata.removeNode -> stop_timer unwinds it.
		metadata.setTimer();
		// `_cwd` is the routing indirection — every scope-relative command's TO
		// stamps through this node, which re-stamps the live cwd. Path menu /
		// REPL `cd` just sets `_cwd.target`.
		cwdNode = interpreter.makeNode( 'Node', names.CWD );
		cwdNode.target = shell.path;
	}
	// Bind shell.sink to the always-present `_shell` Tap (an exospine-backbone
	// fixture) as part of the build, so a fast open-and-type can't find it null —
	// dispatch never null-resolves. `_shell` forwards to the interpreter; routing
	// through it keeps every typed command observable via `connect _shell`.
	shell.sink = Core.node( names.CONSOLE_TAP ) || interpreter;
	const teardown = () => {
		dumper.unregister( 'transcript', listenerId );
		// metadata.removeNode() -> stop_timer -> unregister from the _router's
		// TIMER (TimerNode self-manages the lifecycle; no hand-rolled unregister).
		dumper.removeNode();
		completion?.removeNode();
		metadata?.removeNode();
		cwdNode?.removeNode();
	};
	return { dumper, teardown };
}

/**
 * Mount a Dumper at `_output` for the page's CommandInterpreter, and use the
 * passed-in Shell (owned by DebugOverlay) to parse + dispatch typed REPL lines
 * into the local realm.
 *
 * @param {boolean}  active      When false the Dumper is torn down (no transcript).
 * @param {Object}   shell       Shell instance owned by DebugOverlay; sink wired to the local interpreter.
 * @param {Function} [onSetSkin] Apply a skin slug — drives the `set_skin` builtin.
 * @return {{ transcript: Array, sendLine: Function, clear: Function }} Reactive
 *   transcript + a `sendLine( line )` that runs the line through Shell and the
 *   matching subset of TopologyConsole's local-scope dispatch.
 */
export function useDebugRepl( active = true, shell, onSetSkin = () => {} ) {
	// Stable refs so re-renders don't rebuild the Shell or remap the Dumper.
	const shellRef = useRef( null );
	const dumperRef = useRef( null );
	// Seeded from localStorage so verbosity survives a reload [87].
	const debugLevelRef = useRef( loadDebugLevel() );
	// The browser interpreter's last-persisted debug_state, so sendLine only writes
	// storage when a REPL command actually changed it [87].
	const lastDebugStateRef = useRef( loadDebugState() );
	// Held in a ref so the []-dep dispatchStatement always calls the live skin
	// applier without rebuilding the callback.
	const onSetSkinRef = useRef( onSetSkin );
	onSetSkinRef.current = onSetSkin;
	// Transcript mirror — driven by a `transcript` subscription on the Dumper so
	// every append/clear re-renders the prompt subscribers. Defaults to empty so
	// the first render before infra is built shows a stable empty list.
	// Single source: the Dumper holds the transcript and drives this mirror via its
	// `transcript` subscription. buildInfra restores the persisted transcript into
	// the Dumper, which notifies this setter — so we start empty here, not from
	// storage, to avoid seeding the same data twice [87].
	const [ transcript, setTranscript ] = useState( EMPTY_TRANSCRIPT );
	// cwd reflects the live Shell.path; re-rendered after every dispatch so the
	// Header path selector + _cwd.target both follow REPL `cd` commands.
	const [ cwd, setCwd ] = useState( '' );
	const [ , bumpRemount ] = useState( 0 );
	// True once the infra nodes (_output/_completion/_metadata/_cwd) are mounted.
	const [ ready, setReady ] = useState( false );
	// The full-rebuild signal: a bump tears down + rebuilds the overlay's infra
	// off the fresh backbone so "Reset Graph" reconstructs the overlay's half too.
	const generation = useGraphGeneration();

	// Build-before-render: construct the infra (graph nodes + shell.sink bind) in
	// this useState lazy-initializer so it runs render-phase, BEFORE the canvas
	// paints + auto-layouts — never in a useEffect. Reactive state (ready/cwd)
	// flips in the effect below, which also tears the infra down on cleanup and
	// rebuilds it across active/shell/generation changes.
	const infraRef = useRef( null );
	const buildNow = useCallback( () => {
		const infra = buildInfra( shell, debugLevelRef, setTranscript );
		dumperRef.current = infra.dumper;
		shellRef.current = shell;
		infraRef.current = infra;
	}, [ shell ] );
	useState( () => {
		if ( active ) {
			buildNow();
		}
	} );

	useEffect( () => {
		if ( ! active ) {
			setTranscript( EMPTY_TRANSCRIPT );
			setReady( false );
			return undefined;
		}
		// The useState initializer built the first instance before render; on a
		// subsequent active/shell/generation change the previous effect's cleanup
		// tore it down, so rebuild here off the (possibly fresh) backbone.
		if ( ! infraRef.current ) {
			buildNow();
		}
		setCwd( shell.path );
		setReady( true );
		bumpRemount( ( n ) => n + 1 );
		return () => {
			infraRef.current?.teardown();
			dumperRef.current = null;
			shellRef.current = null;
			infraRef.current = null;
			setTranscript( EMPTY_TRANSCRIPT );
			setReady( false );
		};
	}, [ active, shell, generation, buildNow ] );

	const append = useCallback( ( entry ) => {
		dumperRef.current?.append( entry );
	}, [] );

	const clear = useCallback( () => {
		dumperRef.current?.clear();
	}, [] );

	// Run one statement through the Shell and act on the three return shapes the
	// console's local-scope dispatch handles (no attached worker, no SSE).
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
			// shell.sink is bound at build time (build-before-render); a null sink
			// means the page genuinely has no interpreter — surface, don't drop.
			if ( ! s.sink ) {
				const verb = parsed[ VALUE ]?.name || '?';
				Core.stderr(
					`useDebugRepl: no command interpreter — REPL command dropped (${ verb })\n`
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
			onDebugLevel: saveDebugLevel, // persist verbosity across reloads [87].
			setSkin: onSetSkinRef.current,
			skins: THEMES,
			currentSkin: getStoredTheme(),
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
			// A `debug_state` verb mutates the browser interpreter directly; persist
			// the new value when it changed so it survives a reload [87].
			const ci = Core.node( names.COMMAND_INTERPRETER );
			const ds = ci ? ci.debugState ?? 0 : 0;
			if ( ds !== lastDebugStateRef.current ) {
				lastDebugStateRef.current = ds;
				saveDebugState( ds );
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
