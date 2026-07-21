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

// Build overlay infra on the backbone render-phase (no dispatch-time race).
function buildInfra( shell, debugLevelRef, onTranscript ) {
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	// Idempotent under StrictMode's double-invoke: reuse an existing Dumper.
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
	// `_output` Dumper is backbone-class (needs debugLevelRef), so new+named.
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
	// Seed transcript + interpreter debug_state from last session [87].
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
		// Canvas-poll: Metadata fires dump_metadata at _cwd each tick.
		metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		metadata.target = names.CWD;
		// Hitchhike the _router TIMER; removeNode unwinds via stop_timer.
		metadata.setTimer();
		// `_cwd` routing indirection: scope-relative TO re-stamps the cwd.
		cwdNode = interpreter.makeNode( 'Node', names.CWD );
		cwdNode.target = shell.path;
	}
	// Bind shell.sink to `_shell` Tap at build so open-and-type can't null it.
	shell.sink = Core.node( names.CONSOLE_TAP ) || interpreter;
	const teardown = () => {
		dumper.unregister( 'transcript', listenerId );
		// metadata.removeNode() -> stop_timer unregisters from _router TIMER.
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
	// Reactive mirror of the ref so the Verbose toggle reads the live level.
	const [ debugLevel, setDebugLevel ] = useState( () => loadDebugLevel() );
	// Last-persisted debug_state; sendLine writes only on change [87].
	const lastDebugStateRef = useRef( loadDebugState() );
	// Ref so the []-dep dispatchStatement calls the live skin applier.
	const onSetSkinRef = useRef( onSetSkin );
	onSetSkinRef.current = onSetSkin;
	// Transcript mirror from the Dumper sub; start empty, no double-seed [87].
	const [ transcript, setTranscript ] = useState( EMPTY_TRANSCRIPT );
	// cwd mirrors Shell.path; re-rendered so Header + _cwd follow REPL `cd`.
	const [ cwd, setCwd ] = useState( '' );
	const [ , bumpRemount ] = useState( 0 );
	// True once infra nodes (_output/_completion/_metadata/_cwd) are mounted.
	const [ ready, setReady ] = useState( false );
	// Full-rebuild signal: a bump rebuilds overlay infra off fresh backbone.
	const generation = useGraphGeneration();

	// Build-before-render: build infra in this lazy initializer, before paint.
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
		// Rebuild off the (possibly fresh) backbone after the prior teardown.
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

	// Run one statement through the Shell; handle the three local-scope shapes.
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
			// shell.sink bound; null sink = no interpreter — surface it.
			if ( ! s.sink ) {
				const verb = parsed[ VALUE ]?.name || '?';
				Core.stderr(
					`useDebugRepl: no command interpreter — REPL command dropped (${ verb })\n`
				);
				return;
			}
			// dispatch (not sink.fill) so useGraphReset's tap sees the verb.
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
			onDebugLevel: ( level ) => {
				saveDebugLevel( level ); // persist verbosity across reloads [87].
				setDebugLevel( level ); // reactive mirror for the Verbose toggle.
			},
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
			// Mirror `cd` shell.path change to _cwd.target and reactive cwd.
			const s = shellRef.current;
			if ( s && s.path !== cwd ) {
				const cwdNode = Core.node( names.CWD );
				if ( cwdNode ) {
					cwdNode.target = s.path;
				}
				setCwd( s.path );
			}
			// A `debug_state` verb mutates the interpreter; persist [87].
			const ci = Core.node( names.COMMAND_INTERPRETER );
			const ds = ci ? ci.debugState ?? 0 : 0;
			if ( ds !== lastDebugStateRef.current ) {
				lastDebugStateRef.current = ds;
				saveDebugState( ds );
			}
		},
		[ dispatchStatement, cwd ]
	);

	// Programmatic path change — equivalent to typing `cd /<path>`.
	const setPath = useCallback(
		( path ) => {
			sendLine( `cd /${ path }` );
		},
		[ sendLine ]
	);

	return useMemo(
		() => ( {
			transcript,
			sendLine,
			append,
			clear,
			cwd,
			setPath,
			ready,
			debugLevel,
		} ),
		[ transcript, sendLine, append, clear, cwd, setPath, ready, debugLevel ]
	);
}
