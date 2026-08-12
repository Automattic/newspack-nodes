import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
import { splitStatements } from '../runtime/shell-node';
import { makeSkinHost } from '../topology-console/core/skinCommands';
import { DumperNode } from '../runtime/dumper-node';
import { StdoutNode } from '../runtime/stdout-node';
import { OutgoingGateNode } from '../topology-console/core/outgoingGate';
import { useGraphGeneration, useNodeState } from '../runtime/react';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_BYTESTREAM,
	applyComposeFields,
} from '../runtime/message';
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

/**
 * The gate the overlay's Shell sinks into: the `_shell` Tap when one is up,
 * else the bare interpreter. It carries the Compose modal's fields out.
 *
 * @param {Object} interpreter Fallback sink when no Tap is mounted.
 * @param {Object} fieldsRef   Ref holding the Compose fields for this statement.
 * @return {Object} The gate node.
 */
function makeGate( interpreter, fieldsRef ) {
	const gate = new OutgoingGateNode();
	gate.sink = Core.node( names.CONSOLE_TAP ) || interpreter;
	gate.beforeSend = ( m ) => applyComposeFields( m, fieldsRef.current );
	return gate;
}

/**
 * Mount `_stdout` and hand the Shell the host references its skin builtins
 * need. Builtin output bypasses `_output`: the Dumper renders MESSAGES, and a
 * builtin prints text, so `_stdout` turns that text into transcript lines.
 *
 * @param {Object}   shell     Shell owned by DebugOverlay.
 * @param {Object}   dumper    The `_output` Dumper owning the transcript.
 * @param {Function} onSetSkin Applies a resolved skin slug.
 * @return {Object} The mounted `_stdout` node.
 */
function wireStdout( shell, dumper, onSetSkin ) {
	const stdout =
		Core.node( names.STDOUT ) ||
		new StdoutNode( { write: ( text ) => dumper.appendText( text ) } );
	stdout.name = names.STDOUT;
	shell.host = makeSkinHost( {
		skins: THEMES,
		currentSkin: getStoredTheme,
		applySkin: ( slug ) => onSetSkin( slug ),
		print: ( text ) => dumper.appendText( text ),
	} );
	return stdout;
}

// Build overlay infra on the backbone render-phase (no dispatch-time race).
function buildInfra( shell, debugLevelRef, onSetSkin, fieldsRef ) {
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	// Idempotent under StrictMode's double-invoke: reuse an existing Dumper.
	const existing = Core.node( names.OUTPUT );
	if ( existing ) {
		shell.sink = makeGate( interpreter, fieldsRef );
		wireStdout( shell, existing, onSetSkin );
		return {
			dumper: existing,
			teardown: () => {
				existing.removeNode();
				Core.node( names.STDOUT )?.removeNode();
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
	// Publish the restored level so the Verbose toggle reads it like any slice.
	dumper.setDebugLevel( debugLevelRef.current );
	// Persist only. The React read is useNodeState below, as in the console.
	const listenerId = 'useDebugRepl/transcript';
	dumper.register( 'transcript', listenerId, ( next ) => {
		saveTranscript( next || EMPTY_TRANSCRIPT );
		return true;
	} );
	dumper.register( 'debug_level', listenerId, ( next ) => {
		saveDebugLevel( next );
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
	shell.sink = makeGate( interpreter, fieldsRef );
	const stdout = wireStdout( shell, dumper, onSetSkin );
	const teardown = () => {
		dumper.unregister( 'transcript', listenerId );
		dumper.unregister( 'debug_level', listenerId );
		stdout.removeNode();
		// metadata.removeNode() -> stop_timer unregisters from _router TIMER.
		dumper.removeNode();
		completion?.removeNode();
		metadata?.removeNode();
		cwdNode?.removeNode();
	};
	return { dumper, teardown };
}

/**
 * Mount a Dumper at `_output` (plus `_stdout`) for the page's
 * CommandInterpreter, and fill the passed-in Shell (owned by DebugOverlay) with
 * typed REPL lines, which it turns into messages bound for the local realm.
 *
 * @param {boolean}  active      When false the Dumper is torn down (no transcript).
 * @param {Object}   shell       Shell instance owned by DebugOverlay; sink wired to the local interpreter.
 * @param {Function} [onSetSkin] Apply a skin slug — drives the `set_skin` builtin.
 * @return {{ transcript: Array, sendLine: Function, append: Function, clear: Function, cwd: string, setPath: Function, ready: boolean, debugLevel: number }}
 *   Reactive transcript plus a `sendLine( line )` that fills each statement
 *   into the Shell;
 *   `append`/`clear` write the transcript directly, `cwd` mirrors Shell.path
 *   and `setPath` changes it, `ready` is true once the overlay infra nodes are
 *   mounted, and `debugLevel` is the persisted REPL verbosity.
 */
export function useDebugRepl( active = true, shell, onSetSkin = () => {} ) {
	// Stable refs so re-renders don't rebuild the Shell or remap the Dumper.
	const shellRef = useRef( null );
	const dumperRef = useRef( null );
	// Seeded from localStorage so verbosity survives a reload [87].
	const debugLevelRef = useRef( loadDebugLevel() );
	// Last-persisted debug_state; sendLine writes only on change [87].
	const lastDebugStateRef = useRef( loadDebugState() );
	// Ref so the []-dep dispatchStatement calls the live skin applier.
	const onSetSkinRef = useRef( onSetSkin );
	onSetSkinRef.current = onSetSkin;
	// Compose fields for the statement in flight, read by the outgoing gate.
	const fieldsRef = useRef( null );
	// The Dumper owns the transcript; read it where every other slice is read.
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;
	// Same for the verbosity dial the `debug_level` builtin moves.
	const debugLevel =
		useNodeState( names.OUTPUT, 'debug_level' ) ?? debugLevelRef.current;
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
		const infra = buildInfra(
			shell,
			debugLevelRef,
			( slug ) => onSetSkinRef.current( slug ),
			fieldsRef
		);
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
			// No clear needed: the Dumper goes, so useNodeState reads empty.
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
			setReady( false );
		};
	}, [ active, shell, generation, buildNow ] );

	const append = useCallback( ( entry ) => {
		dumperRef.current?.append( entry );
	}, [] );

	const clear = useCallback( () => {
		dumperRef.current?.clear();
	}, [] );

	// Run one statement through the Shell — the one door (ADR-1).
	const dispatchStatement = useCallback( ( statement, fields ) => {
		const s = shellRef.current;
		const dumper = dumperRef.current;
		if ( ! s || ! dumper ) {
			return;
		}
		// Echo input verbatim; blanks stay silent.
		if ( '' !== statement.trim() ) {
			dumper.append( { kind: 'sent', text: statement, prompt: '/' } );
		}
		// Applied on the way out by the gate this hook owns.
		fieldsRef.current = fields;
		const line = newMessage();
		line[ TYPE ] = TM_BYTESTREAM;
		line[ VALUE ] = statement;
		s.fill( line );
	}, [] );

	const sendLine = useCallback(
		( line, fields ) => {
			const shellNode = shellRef.current;
			// A held continuation owns the whole next line (no ';' splitting).
			const stmts = shellNode?.hasPending()
				? [ line ]
				: splitStatements( line );
			for ( const stmt of stmts ) {
				dispatchStatement( stmt, fields );
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
			// `trace` mutates the interpreter's debug_state; persist [87].
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
