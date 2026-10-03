/**
 * The debug overlay's REPL: a hook that mounts the overlay's own service nodes
 * onto the page's exospine backbone and turns each typed line into messages the
 * local node graph routes.
 *
 * The backbone hands every dashboard page a `_command_interpreter` sinking into
 * `_router`. The overlay adds five nodes on top: `_output`, the Dumper that owns
 * the transcript; `_stdout`, where the Shell's builtins print text;
 * `_completion` for tab completion; and `_metadata` with `_cwd`, the canvas poll
 * and the path it polls at.
 *
 * The graph stays the source of truth. React keeps no second copy of the
 * transcript or the verbosity dial — the transcript is a Dumper field read
 * through `useNodeField`, the dial a state slot read through `useNodeState` —
 * while
 * localStorage carries the transcript, the debug level and the interpreter's
 * `debug_state` across a reload.
 */

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
import {
	useGraphGeneration,
	useNodeField,
	useNodeState,
} from '../runtime/react';
import { newMessage, TYPE, VALUE, TM_BYTESTREAM } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import { THEMES, getStoredTheme } from '../topology-console/themes';
import {
	loadTranscript,
	saveTranscript,
	loadDebugLevel,
	saveDebugLevel,
	loadDebugUi,
	saveDebugUi,
	loadDebugState,
	saveDebugState,
} from '../topology-console/core/consolePersistence';

/**
 * The empty-transcript fallback, hoisted so every render that finds no Dumper
 * reads the SAME array. A fresh `[]` per render would change the returned
 * memo's identity and re-render the whole panel on every tick.
 */
const EMPTY_TRANSCRIPT = [];

/**
 * Build the gate every overlay send passes: the Shell's statements, the invoke
 * gesture's mints and the Compose modal's messages. It sinks into the `_shell`
 * Tap when the backbone has one, else the bare interpreter. The Tap is
 * preferred because every command in the graph is observed there; the
 * interpreter is the fallback for a page whose Tap is gone.
 *
 * The gate is unnamed, so nothing can address it and the overlay's reference is
 * the only way in. That is what makes its forward tap a safe place for the
 * Reset Graph chip to watch, since nothing routed can reach it.
 *
 * @param {Object} interpreter Fallback sink when no `_shell` Tap is mounted.
 * @return {OutgoingGateNode} The gate, sunk and ready for `shell.sink`.
 */
function makeGate( interpreter ) {
	const gate = new OutgoingGateNode();
	gate.sink = Core.node( names.CONSOLE_TAP ) || interpreter;
	return gate;
}

/**
 * Mount `_stdout` and hand the Shell the host references its skin builtins
 * need. Builtin output bypasses `_output`: the Dumper renders MESSAGES, and a
 * builtin prints text, so `_stdout` turns that text into transcript lines.
 *
 * An already-registered `_stdout` is reused rather than replaced, which is what
 * keeps StrictMode's double-invoked initializer from colliding on the name.
 *
 * @param {Object}   shell     Shell owned by the overlay's Inspector tab.
 * @param {Object}   dumper    The `_output` Dumper owning the transcript.
 * @param {Function} onSetSkin Applies a resolved skin slug.
 * @return {StdoutNode} The mounted `_stdout` node.
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

/**
 * Aim `_http`'s unaddressed-reply target. `_output` exists only while a console
 * is open, so the black hole holds the target the rest of the time: a target
 * naming an unregistered node turns every unaddressed server reply into a
 * NOT_AVAILABLE bounce the graph has nowhere to put.
 *
 * @param {string} target Node name to stamp an unaddressed reply with.
 */
function aimHttp( target ) {
	const http = Core.node( names.HTTP );
	if ( http ) {
		http.target = target;
	}
}

/**
 * Mount the overlay's service nodes onto the backbone, bind the Shell's
 * outgoing sink, and hand back the Dumper plus the teardown that removes
 * exactly what was mounted.
 *
 * Called from a render-phase lazy initializer, so the whole graph exists before
 * the panel's first paint. A node built in an effect would leave the first
 * typed line with no sink to dispatch into.
 *
 * The Dumper is constructed directly rather than through `makeNode`, for two
 * reasons. `makeNode` carries only string argument tokens, and `debugLevelRef`
 * is a live React ref. The transcript also has to exist on a page with no
 * interpreter, which is exactly where the three `makeNode` nodes below cannot
 * be built.
 *
 * `_metadata` targets `_cwd` rather than a path, so a REPL `cd` re-points one
 * node and every poll follows it — targets resolve at fill time (ADR-7). An
 * empty cwd leaves `_cwd.target` empty, which stamps no TO and keeps the poll
 * in the local realm.
 *
 * @param {Object}   shell         Shell owned by the overlay's Inspector tab.
 * @param {Object}   debugLevelRef Ref carrying the restored REPL verbosity; the
 *                                 Dumper reads it per delivered message.
 * @param {Function} onSetSkin     Applies a resolved skin slug.
 * @return {{ dumper: Object, gate: OutgoingGateNode, teardown: Function }} The
 *   `_output` Dumper, the gate bound as `shell.sink`, and a teardown that drops
 *   its persistence listeners and removes every node this build mounted.
 */
function buildInfra( shell, debugLevelRef, onSetSkin ) {
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	// Idempotent under StrictMode's double-invoke: reuse an existing Dumper.
	const existing = Core.node( names.OUTPUT );
	if ( existing ) {
		shell.sink = makeGate( interpreter );
		wireStdout( shell, existing, onSetSkin );
		aimHttp( names.OUTPUT );
		return {
			dumper: existing,
			gate: shell.sink,
			teardown: () => {
				aimHttp( names.NULL );
				existing.removeNode();
				Core.node( names.STDOUT )?.removeNode();
				Core.node( names.COMPLETION )?.removeNode();
				Core.node( names.METADATA )?.removeNode();
				Core.node( names.CWD )?.removeNode();
			},
		};
	}
	const dumper = new DumperNode();
	dumper.debugLevelRef = debugLevelRef;
	dumper.name = names.OUTPUT;
	dumper.sink = interpreter;
	// Publish the restored level so the Verbose toggle reads it like any slice.
	dumper.setDebugLevel( debugLevelRef.current );
	dumper.setDebugUi( loadDebugUi() );
	// These listeners only persist; React reads the Dumper through the hooks.
	const listenerId = 'useDebugRepl/transcript';
	dumper.register( 'transcript', listenerId, () => {
		saveTranscript( dumper.transcript );
		return true;
	} );
	dumper.register( 'debug_level', listenerId, ( next ) => {
		saveDebugLevel( next );
		return true;
	} );
	dumper.register( 'debug_ui', listenerId, ( next ) => {
		saveDebugUi( next );
		return true;
	} );
	// Seed the transcript and interpreter debug_state from storage [87].
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
		// The canvas poll: Metadata fires dump_metadata at _cwd each tick.
		metadata = interpreter.makeNode( 'Metadata', names.METADATA );
		metadata.target = names.CWD;
		// Hitchhike the _router TIMER; removeNode unwinds via stop_timer.
		metadata.setTimer();
		// One indirection: a poll addressed to `_cwd` re-stamps the live cwd.
		cwdNode = interpreter.makeNode( 'Node', names.CWD );
		cwdNode.target = shell.path;
	}
	// Bind shell.sink here, so a line typed on open never finds it null.
	shell.sink = makeGate( interpreter );
	const stdout = wireStdout( shell, dumper, onSetSkin );
	aimHttp( names.OUTPUT );
	const teardown = () => {
		aimHttp( names.NULL );
		dumper.unregister( 'transcript', listenerId );
		dumper.unregister( 'debug_level', listenerId );
		dumper.unregister( 'debug_ui', listenerId );
		stdout.removeNode();
		// metadata.removeNode() stops its timer, unregistering it from _router.
		dumper.removeNode();
		completion?.removeNode();
		metadata?.removeNode();
		cwdNode?.removeNode();
	};
	return { dumper, gate: shell.sink, teardown };
}

/**
 * Mount the overlay's service nodes for the page's CommandInterpreter, and fill
 * the passed-in Shell with typed REPL lines, which it turns into messages bound
 * for the local realm.
 *
 * The infra is rebuilt whenever `active`, `shell` or the graph generation
 * changes, so the overlay's "Reset Graph" reconstructs these nodes on the fresh
 * backbone alongside everyone else's.
 *
 * @param {boolean}  active      When false nothing is built, and standing infra
 *                               is torn down — which empties the transcript
 *                               along with the Dumper that owned it.
 * @param {Object}   shell       Shell instance owned by the overlay's Inspector
 *                               tab; its sink is bound here, to the local
 *                               interpreter.
 * @param {Function} [onSetSkin] Apply a skin slug — drives the `set_skin`
 *                               builtin.
 * @return {{ transcript: Array, sendLine: (line: string) => void, gate: ?OutgoingGateNode, append: Function, clear: Function, cwd: string, setPath: Function, ready: boolean, debugLevel: number }}
 *   The reactive transcript, plus a `sendLine( line )` that splits the line
 *   and fills each statement into the Shell; `gate` is the Shell's sink, null
 *   until mounted, for the Reset Graph tap; `append` and `clear` write the
 *   transcript directly, `cwd` mirrors `shell.path` and `setPath` changes it,
 *   `ready` is true once the infra nodes are mounted, and `debugLevel` is the
 *   persisted REPL verbosity.
 */
export function useDebugRepl( active = true, shell, onSetSkin = () => {} ) {
	// Stable refs so re-renders don't rebuild the Shell or remap the Dumper.
	const shellRef = useRef( null );
	const dumperRef = useRef( null );
	// Seeded from localStorage so verbosity survives a reload [87].
	const debugLevelRef = useRef( loadDebugLevel() );
	// Last-persisted debug_state; sendLine writes only on change [87].
	const lastDebugStateRef = useRef( loadDebugState() );
	// A ref, so the memoized build always calls the live skin applier.
	const onSetSkinRef = useRef( onSetSkin );
	onSetSkinRef.current = onSetSkin;
	// The Dumper owns the transcript; read it where every other slice is read.
	const transcript =
		useNodeField( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;
	// Same for the verbosity dial the `debug_level` builtin moves.
	const debugLevel =
		useNodeState( names.OUTPUT, 'debug_level' ) ?? debugLevelRef.current;
	// cwd mirrors shell.path, so the Header and `_cwd` follow a REPL `cd`.
	const [ cwd, setCwd ] = useState( '' );
	// One extra render, so the node hooks resolve the just-mounted Dumper.
	const [ , bumpRemount ] = useState( 0 );
	// The live gate; STATE, so a rebuild reaches useGraphReset's tap.
	const [ gate, setGate ] = useState( null );
	// The infra (_output/_completion/_metadata/_cwd) is mounted with its gate.
	const ready = null !== gate;
	// Full-rebuild signal: a bump rebuilds the infra on a fresh backbone.
	const generation = useGraphGeneration();

	// Holds the built infra so teardown removes exactly what was built.
	const infraRef = useRef( null );
	/**
	 * Build the infra and point every ref at it. One callback because the lazy
	 * initializer below and the mount effect both need the same build, and its
	 * `shell` dependency is what keeps the effect from rebuilding each render.
	 */
	const buildNow = useCallback( () => {
		const infra = buildInfra( shell, debugLevelRef, ( slug ) =>
			onSetSkinRef.current( slug )
		);
		dumperRef.current = infra.dumper;
		shellRef.current = shell;
		infraRef.current = infra;
	}, [ shell ] );
	// A lazy initializer runs before first paint, ahead of any dispatch.
	useState( () => {
		if ( active ) {
			buildNow();
		}
	} );

	useEffect( () => {
		if ( ! active ) {
			// No clear needed: the Dumper goes, so the node hooks read empty.
			return undefined;
		}
		// Rebuild off the (possibly fresh) backbone after the prior teardown.
		if ( ! infraRef.current ) {
			buildNow();
		}
		setCwd( shell.path );
		setGate( infraRef.current.gate );
		bumpRemount( ( n ) => n + 1 );
		return () => {
			infraRef.current?.teardown();
			dumperRef.current = null;
			shellRef.current = null;
			infraRef.current = null;
			setGate( null );
		};
	}, [ active, shell, generation, buildNow ] );

	/**
	 * Write one entry straight into the transcript, bypassing the Shell. This is
	 * how the overlay reports its own events, an invoke echo or an SSE error:
	 * neither was ever a message, so neither has anything to dispatch.
	 *
	 * @param {Object} entry Transcript entry, in the Dumper's own shape.
	 */
	const append = useCallback( ( entry ) => {
		dumperRef.current?.append( entry );
	}, [] );

	/**
	 * Empty the transcript. The Dumper publishes a fresh empty array, so the
	 * persisted snapshot clears through the same listener that saves it.
	 */
	const clear = useCallback( () => {
		dumperRef.current?.clear();
	}, [] );

	/**
	 * Run one statement through the Shell. `fill()` is the Shell's only entry
	 * point (ADR-1), so a typed line and a canvas gesture arrive by the same
	 * door and pick up the same transcript echo.
	 *
	 * @param {string} statement One statement, already split off the line; a
	 *                           blank one dispatches without echoing.
	 */
	const dispatchStatement = useCallback( ( statement ) => {
		const s = shellRef.current;
		const dumper = dumperRef.current;
		if ( ! s || ! dumper ) {
			return;
		}
		// Echo input verbatim; blanks stay silent.
		if ( '' !== statement.trim() ) {
			// The prompt it was typed AT, or `cd` is invisible.
			dumper.append( {
				kind: 'sent',
				text: statement,
				prompt: `/${ s.path }`,
			} );
		}
		const line = newMessage();
		line[ TYPE ] = TM_BYTESTREAM;
		line[ VALUE ] = statement;
		s.fill( line );
	}, [] );

	/**
	 * THE dispatch path: split a typed line into statements, run each one, and
	 * do the bookkeeping a line can trigger — mirror a `cd` onto `_cwd` and the
	 * reactive cwd, and persist the `debug_state` a `trace` moved.
	 *
	 * A held continuation — an open quote or a trailing backslash — owns the
	 * whole next line, so the line is not split on `;`. That semicolon is part
	 * of the statement the user is still typing.
	 *
	 * @param {string} line One raw line from the REPL input.
	 */
	const sendLine = useCallback(
		( line ) => {
			const shellNode = shellRef.current;
			const stmts = shellNode?.hasPending()
				? [ line ]
				: splitStatements( line );
			for ( const stmt of stmts ) {
				dispatchStatement( stmt );
			}
			// Mirror a `cd` onto `_cwd`'s target and the reactive cwd.
			const s = shellRef.current;
			if ( s && s.path !== cwd ) {
				const cwdNode = Core.node( names.CWD );
				if ( cwdNode ) {
					cwdNode.target = s.path;
				}
				// A new directory repaints now, not at the end of the cadence.
				Core.node( names.METADATA )?.markDue();
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

	/**
	 * Change the cwd programmatically, as the Header's PATH selector does.
	 * Sends the `cd` line instead of assigning `shell.path`, so the echo,
	 * `_cwd` and the canvas repaint all follow the one dispatch path.
	 *
	 * @param {string} path Destination path, without the leading slash.
	 */
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
			gate,
			append,
			clear,
			cwd,
			setPath,
			ready,
			debugLevel,
		} ),
		[
			transcript,
			sendLine,
			gate,
			append,
			clear,
			cwd,
			setPath,
			ready,
			debugLevel,
		]
	);
}
