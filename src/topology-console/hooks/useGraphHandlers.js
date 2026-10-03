import { markLocal } from '../../runtime/command-auth';
import { useMemo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import {
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_EOF,
	TM_COMMAND,
	TM_ERROR,
	TM_REQUEST,
	TM_RESPONSE,
	TM_NOREPLY,
	TM_STRUCT,
} from '../../runtime/message';
import { formatMessageEnvelope } from '../../runtime/dumper-node';
import { sseRefusal } from '../core/outgoingGate';
import { generateNodeName } from '../utils/consoleGraph';
import { quoteToken, scanTokens } from '../../runtime/shell-node';
import names from '../../runtime/reserved-node-names.json';
import { Core } from '../../runtime/core';
import { canonicalReverseCwd } from '../../runtime/metadata-node';

/** @typedef {{ kind: string, text: string, prompt?: string }} TranscriptEntry */

/** The catalog a caller passing none gets: one array, so the memo holds. */
const NO_CLASSES = [];

/** The default SSE predicate, admitting every TO, as the overlay needs. */
const ADMIT_ALL = () => true;

/**
 * The refusal when no connected gate can carry a send.
 *
 * @return {string} The refusal, translated when called.
 */
const noSession = () =>
	__( 'No console session yet; retry once connected.', 'newspack-nodes' );

/**
 * Whether an Inspector action belongs to a UI button rather than the REPL: an
 * invoke naming its own `replyTo`. Its traffic shows only under `debug_ui`, so
 * the REPL stays as it is for it.
 *
 * @param {string} action  The Inspector action.
 * @param {*}      payload Its payload; an invoke's carries `replyTo`.
 * @return {boolean} True for a UI-bound invoke.
 */
function isUiBound( action, payload ) {
	return 'invoke' === action && !! payload?.replyTo;
}

/**
 * Routes one command line. Both consumers point this at their own `sendLine`.
 *
 * @typedef {(line: string) => void} Dispatch
 */

/**
 * Runs one Inspector verb. `payload` is the verb's argument — a phrase for
 * `send`, a level for `trace`, and the `{ verb, kind, args, struct, replyTo }`
 * record for `invoke`, `args` its tokens and `struct` a structured request's
 * map.
 *
 * @typedef {(action: string, nodeId: string, payload?: (string|number|Object)) => void} InspectorAction
 */

/**
 * The Compose modal's form, every text field as typed. A blank FROM, ID, KEY or
 * Timestamp keeps what the mint stamps; `value` feeds every type but TM_COMMAND
 * and TM_EOF, and `name`, `arguments` and `payload` feed TM_COMMAND alone.
 *
 * @typedef  {Object}  ComposeForm
 * @property {number}  type      The TM_* type chosen.
 * @property {boolean} response  ORs TM_RESPONSE onto TYPE.
 * @property {boolean} error     ORs TM_ERROR onto TYPE.
 * @property {boolean} noreply   ORs TM_NOREPLY onto TYPE.
 * @property {string}  from      FROM; blank is this session's reply path.
 * @property {string}  to        TO, relative to the Shell's cwd.
 * @property {string}  id        ID.
 * @property {string}  key       KEY.
 * @property {string}  timestamp TIMESTAMP in Unix seconds.
 * @property {string}  value     VALUE; JSON for TM_STRUCT.
 * @property {string}  name      The command's verb.
 * @property {string}  arguments The command's arguments, split by the prompt's tokenizer (quotes group; no $interpolation or # comments).
 * @property {string}  payload   The command's payload; blank leaves it out.
 */

/**
 * The NewNodeModal payload a palette drop stages.
 *
 * @typedef  {Object} DropStage
 * @property {string} shellName   Dropped class, as the palette names it.
 * @property {string} defaultName Name the modal offers, free of collisions.
 * @property {Array}  argSchema   The class's argument schema; empty when it takes none.
 * @property {number} x           Drop site, already projected into SVG space.
 * @property {number} y           Drop site, already projected into SVG space.
 */

/**
 * The gesture handlers, each one dispatch away from the graph it mutates.
 *
 * @typedef  {Object} GraphHandlers
 * @property {(from: string, to: string) => void}                          onConnect         Draw an edge, then patch the FROM node's target.
 * @property {(from: string, to: string) => void}                          onRemoveEdge      Erase an edge, then drop `to` from the FROM node's target.
 * @property {(id: string) => void}                                        onRemoveNode      Remove a node and take it off the canvas.
 * @property {(drop: { shellName: string, x: number, y: number }) => void} onDropNode        Stage a palette drop for NewNodeModal.
 * @property {InspectorAction}                                             onInspectorAction Run one Inspector verb against a node.
 * @property {(form: ComposeForm) => ?string}                              onCompose         Mint and send the Compose modal's message; the refusal, or null once sent.
 */

/**
 * The reply path an invoke stamps as FROM.
 *
 * @param {string} [replyTo] The caller's reply node; `_ui` alone for none.
 * @return {string} `_output` for a REPL-bound invoke, else a path via `_ui`.
 */
function uiReplyPath( replyTo ) {
	if ( ! replyTo ) {
		return names.OUTPUT;
	}
	return names.UI === replyTo ? names.UI : `${ names.UI }/${ replyTo }`;
}

/**
 * A copy of a signed message for the transcript: the signer's `auth` block
 * comes off VALUE, so no nonce, sig or handle reaches a transcript the overlay
 * persists, while TIMESTAMP stays the one the wire carries.
 *
 * @param {Array} message A signed positional message.
 * @return {Array} The copy, without `VALUE.auth`.
 */
function unsigned( message ) {
	const shown = [ ...message ];
	const value = message[ VALUE ];
	if ( value && 'object' === typeof value && 'auth' in value ) {
		shown[ VALUE ] = { ...value };
		delete shown[ VALUE ].auth;
	}
	return shown;
}

/**
 * Mint the Compose modal's message, unsigned: the chosen type with the ticked
 * bits ORed on, and the envelope stamped by `shell.envelope()`, the one stamp
 * the Shell's own builtins use. The composer is a test bench, so every field
 * goes out exactly as typed — padding, a non-numeric Timestamp, an empty Name
 * — and only an empty field is blank and keeps its default. The server's
 * refusal is the test.
 *
 * VALUE follows the type. A command is `{ name, arguments, payload }`: its
 * arguments split by the prompt's tokenizer (quotes group; no $interpolation
 * or # comments) and refused on an unclosed quote, its payload left out when
 * empty, so it matches a typed command on the wire. A struct is the parsed
 * JSON, refused when it does not parse; TM_EOF keeps the mint's empty VALUE;
 * every other type sends the text exactly as typed.
 *
 * @param {ComposeForm} form  The modal's form.
 * @param {Object}      shell The session Shell, whose `envelope()` stamps it.
 * @return {{ message?: Array, forged?: boolean, error?: string }} The unsigned message and whether `envelope()` forged its TIMESTAMP, or why it was refused.
 */
function composeMessage( form, shell ) {
	/** @type {*} */
	let value = '';
	if ( TM_COMMAND === form.type ) {
		const scanned = scanTokens( form.arguments );
		if ( scanned.openQuote ) {
			return {
				error: __( 'Arguments: unclosed quote', 'newspack-nodes' ),
			};
		}
		value = {
			name: form.name,
			arguments: scanned.tokens.map( ( token ) => token.value ),
		};
		if ( '' !== form.payload ) {
			value.payload = form.payload;
		}
	} else if ( TM_STRUCT === form.type ) {
		try {
			value = JSON.parse( form.value );
		} catch ( e ) {
			return {
				error: sprintf(
					// translators: %s: the JSON parser's message.
					__( 'Value is not JSON: %s', 'newspack-nodes' ),
					e.message
				),
			};
		}
	} else if ( TM_EOF !== form.type ) {
		value = form.value;
	}
	const message = newMessage();
	const forged = shell.envelope( message, form.to, {
		from: form.from,
		key: form.key,
		id: form.id,
		timestamp: form.timestamp,
	} );
	message[ TYPE ] =
		form.type |
		( form.response ? TM_RESPONSE : 0 ) |
		( form.error ? TM_ERROR : 0 ) |
		( form.noreply ? TM_NOREPLY : 0 );
	message[ VALUE ] = value;
	return { message, forged };
}

/**
 * One handler set for the canvas and Inspector gestures, shared by the debug
 * overlay and the topology console: connect, disconnect, remove, palette drop,
 * the Inspector's dump / command / tail / send / trace verbs, invoke, and the
 * Compose modal's send.
 *
 * Every gesture but `invoke` and a compose becomes a command line handed to
 * `dispatch`, which both consumers point at their own `sendLine`. That is the
 * path the REPL prompt uses, and it owns the transcript echo, the cwd mirror
 * and the `debug_state` persist; a second dispatch path would let a gesture
 * such as `trace` skip all three.
 *
 * A compose mints its own message through `shell.envelope()`, asks `sseGuard`,
 * and signs it; then `sendMinted()`, the send tail it shares with `invoke`,
 * echoes it and fills `shell.sink`, the console's outgoing gate — never the
 * Shell itself, whose `fill()` parses any string TM_BYTESTREAM as a typed
 * line. The echo is the signed copy less the signer's own `auth`, a snapshot
 * taken before the send, as a typed statement's is, because the Router peels
 * TO in place and a local reply must land below its echo; no nonce, sig or
 * handle reaches a transcript the overlay persists. A refusal — no Shell, a
 * gate with no sink, an unclosed quote, malformed JSON, no SSE session — goes
 * back to the modal with nothing echoed or sent. A send that raises was
 * echoed and may have run, so the tail writes its error to the transcript and
 * the modal reports it, staying open with focus: the REPL opens only after a
 * send that returns.
 *
 * An Inspector action decides REPL visibility before it sends, through the
 * pure `isUiBound()`, so a gesture whose send raises still opens the REPL. An
 * invoke sends through the same tail and never drops in silence: no Shell, a
 * gate with no sink, no signing session, a refused SSE send and a send that
 * raises are each reported once, in the transcript for a REPL-bound invoke and
 * as a TM_ERROR on the reply path for a UI-bound one.
 *
 * `invoke` builds its own message, because a command line expresses none of
 * what it decides: whether the verb goes to the node or to its `:config`
 * sibling (the catalog's `is_interpreter` flag), whether the message is a
 * TM_COMMAND or a TM_REQUEST, how `shell.envelope()` scopes it to the attached
 * worker's cwd, and whether `sseGuard` refuses it for want of a live stream.
 * The `_output` Dumper mints and signs the command — the minter signs, never
 * the ingress (ADR-15) — and hands back null while a session is being
 * re-established, which refuses the gesture rather than send it unsigned. The
 * reply is addressed rather than correlated: the server answers TO the FROM
 * `replyFrom()` stamped (ADR-7), which is why a caller owning its own reply
 * node passes `replyTo` instead of an operation id.
 *
 * Naming a `replyTo` also marks the invoke UI-bound: a button working through
 * the REPL's verbs, not a command the operator asked to watch. Its reply comes
 * back through the `_ui` relay — FROM `_ui/<replyTo>`, or bare `_ui` for a
 * button that reads no reply — and neither the echo nor the reply reaches the
 * transcript unless `debug_ui` is on. Its refusal takes the same path, filled
 * straight into `_command_interpreter` because the gate may be what refused.
 * An invoke without one is REPL-bound and always shows.
 *
 * Every mutation also patches `_metadata`'s raw map, so the canvas repaints
 * before the next poll. The patch mirrors the server rather than guessing:
 * `connect_node` APPENDS on a Tee, so the patch appends too, and replacing
 * there would erase the fan-out's other edges until the next poll put them
 * back.
 *
 * @param {Object}                           args
 * @param {?Object}                          args.shell          Session Shell. `invoke` and a compose fill its sink, scope through its `prefix()` and `replyFrom()`, and read `shell.path` for the echo prompt; without one both do nothing.
 * @param {{ nodes: Array, edges: Array }}   args.graph          The live graph. `invoke` reads the target node's class from it, and a palette drop derives a name that does not collide.
 * @param {Array}                            args.catalogClasses Class catalog entries, matched on `shell_name`: `is_interpreter` picks the invoke target, and `arguments` becomes the drop modal's schema.
 * @param {Dispatch}                         args.dispatch       Routes each non-invoke gesture.
 * @param {(entry: TranscriptEntry) => void} args.append         Appends one transcript entry — the invoke and compose echoes, and the refusal `sseGuard` produces.
 * @param {() => void}                       args.onReplSend     The one rule for when the REPL shows: told after every Inspector action but a UI-bound invoke, and after a sent compose. A canvas gesture echoes its line but never tells it.
 * @param {(drop: DropStage) => void}        args.onDropStage    Stages a palette drop; the consumer's commit dispatches the `make_node`.
 * @param {(to: string) => boolean}          [args.sseGuard]     Returns false to refuse an invoke or a compose, defaulting to always-allow; an invoke's refusal goes to the transcript, or for a UI-bound invoke to its `replyTo` as a TM_ERROR, and a compose's goes back to the modal. Only an attached-worker reply rides the stream, so the overlay keeps the default.
 * @return {GraphHandlers} The gesture handlers.
 */
export function useGraphHandlers( {
	shell,
	graph,
	catalogClasses = NO_CLASSES,
	dispatch,
	append,
	onReplSend,
	onDropStage,
	sseGuard = ADMIT_ALL,
} ) {
	return useMemo( () => {
		// Patch the local metadata so the canvas repaints before the poll.
		const patch = ( name, p ) =>
			name && Core.node( names.METADATA )?.optimisticPatch( name, p );
		// The echo of one send, at the prompt it was sent from.
		const echoed = ( text ) => ( {
			kind: 'sent',
			text,
			prompt: `/${ shell.path }`,
		} );
		/**
		 * The one send tail for a message already minted and signed: append
		 * its echo, fill the gate, and report a send that raises — it may have
		 * run, as a Tap delivers and then raises — as an error line. A gate
		 * with no sink refuses before anything is written.
		 *
		 * @param {Array}                            message The message to send.
		 * @param {TranscriptEntry}                  entry   Its echo.
		 * @param {(entry: TranscriptEntry) => void} write   Where echo and error go.
		 * @return {?{ text: string, logged: boolean }} The refusal, and whether
		 *   `write` already carries its error line; null once sent.
		 */
		const sendMinted = ( message, entry, write = append ) => {
			if ( ! shell?.sink?.connected ) {
				return { text: noSession(), logged: false };
			}
			write( entry );
			try {
				shell.sink.fill( message );
			} catch ( e ) {
				write( { kind: 'error', text: e.message } );
				const text = sprintf(
					// translators: %s: what the send raised.
					__( 'Sent; the send raised: %s', 'newspack-nodes' ),
					e.message
				);
				return { text, logged: true };
			}
			return null;
		};
		/**
		 * Report an invoke that did not send cleanly. A REPL-bound invoke
		 * writes the refusal to the transcript unless the send tail already
		 * did; a UI-bound one answers its button where the reply would land,
		 * delivered locally because the gate may be what refused.
		 *
		 * @param {Object}  payload The invoke's payload: `verb` and `replyTo`.
		 * @param {string}  text    The refusal.
		 * @param {boolean} logged  Whether the transcript already carries it.
		 */
		const refuseInvoke = ( payload, text, logged = false ) => {
			if ( ! isUiBound( 'invoke', payload ) ) {
				if ( ! logged ) {
					append( { kind: 'error', text } );
				}
				return;
			}
			const err = newMessage();
			err[ TYPE ] = TM_COMMAND | TM_ERROR;
			err[ TO ] = uiReplyPath( payload.replyTo );
			err[ VALUE ] = { name: payload.verb, payload: `${ text }\n` };
			Core.node( names.COMMAND_INTERPRETER )?.fill( err );
		};
		// Invoke a verb on a node, minting its own message.
		const invoke = ( nodeId, payload ) => {
			if ( ! shell ) {
				refuseInvoke( payload, noSession() );
				return;
			}
			const { verb, kind, args = [], struct, replyTo } = payload;
			// The catalog flag decides, not a search for `:config`.
			const node = ( graph?.nodes || [] ).find(
				( n ) => n.id === nodeId
			);
			const cls = node
				? catalogClasses.find( ( c ) => c.shell_name === node.class )
				: null;
			const isInterpreter = !! ( cls && cls.is_interpreter );
			const commandTarget =
				'request' === kind || isInterpreter
					? nodeId
					: `${ nodeId }:config`;
			const to = shell.prefix( commandTarget );
			// Only an attached worker's reply needs the SSE session.
			if ( ! sseGuard( to ) ) {
				refuseInvoke( payload, sseRefusal() );
				return;
			}
			let m;
			let echo;
			if ( 'request' === kind && undefined !== struct ) {
				// Mirror `request_struct`, keying the map by verb.
				m = newMessage();
				m[ TYPE ] = TM_REQUEST | TM_STRUCT;
				m[ VALUE ] = { [ verb ]: struct };
				markLocal( m );
				echo = `request_struct ${ nodeId } ${ quoteToken(
					JSON.stringify( m[ VALUE ] )
				) }`;
			} else if ( 'request' === kind ) {
				// Mirror the Shell: mark LOCAL; a request is unsigned.
				m = newMessage();
				m[ TYPE ] = TM_REQUEST;
				m[ VALUE ] = [ verb, ...args ].join( ' ' );
				markLocal( m );
				echo = `request_node ${ nodeId } ${ m[ VALUE ] }`;
			} else {
				// `_output` mints it; the args are already tokens.
				m = Core.node( names.OUTPUT )?.command( verb, args );
				if ( ! m ) {
					// Unsigned: the re-auth this asked for is under way.
					refuseInvoke( payload, noSession() );
					return;
				}
				echo = [
					'command_node',
					commandTarget,
					verb,
					...args.map( quoteToken ),
				].join( ' ' );
			}
			// A caller owning a reply node names it (ADR-7).
			shell.envelope( m, commandTarget, {
				from: shell.replyFrom( uiReplyPath( replyTo ) ),
			} );
			const refused = sendMinted(
				m,
				echoed( echo ),
				isUiBound( 'invoke', payload )
					? ( entry ) => Core.node( names.OUTPUT )?.appendUi( entry )
					: append
			);
			if ( refused ) {
				refuseInvoke( payload, refused.text, refused.logged );
			}
		};
		// One Inspector verb: a command line, or invoke's own mint.
		const act = ( action, nodeId, payload ) => {
			if ( 'dump' === action ) {
				dispatch( `dump_node ${ nodeId }` );
			} else if ( 'dump_config' === action ) {
				dispatch( `dump_config ${ nodeId }` );
			} else if ( 'command' === action ) {
				// A raw command line, sent as typed.
				dispatch( String( payload ).trim() );
			} else if ( 'tail' === action ) {
				// A bare connect_node appends the reply path as a target.
				dispatch( `connect_node ${ nodeId }` );
				const meta = Core.node( names.METADATA )?.rawMap;
				const pwd = canonicalReverseCwd( meta?._header?.pwd );
				if ( pwd ) {
					const current = meta?.[ nodeId ]?.target;
					let next = [ pwd ];
					if ( Array.isArray( current ) ) {
						next = current.includes( pwd )
							? current
							: [ ...current, pwd ];
					}
					patch( nodeId, { target: next } );
				}
			} else if ( 'disconnect' === action ) {
				// A bare disconnect drops only this reply path from a Tee.
				dispatch( `disconnect_node ${ nodeId }` );
				const meta = Core.node( names.METADATA )?.rawMap;
				const pwd = canonicalReverseCwd( meta?._header?.pwd );
				const current = meta?.[ nodeId ]?.target;
				if ( pwd && Array.isArray( current ) ) {
					patch( nodeId, {
						target: current.filter( ( t ) => t !== pwd ),
					} );
				}
			} else if ( 'cmd' === action ) {
				dispatch( `command_node ${ nodeId } ${ payload }` );
			} else if ( 'send' === action ) {
				dispatch( `send_node ${ nodeId } ${ payload }` );
			} else if ( 'request' === action ) {
				dispatch( `request_node ${ nodeId } ${ payload }` );
			} else if ( 'tell' === action ) {
				dispatch( `tell_node ${ nodeId } ${ payload }` );
			} else if ( 'send_struct' === action ) {
				// Quote the JSON so the tokenizer keeps it one token [#32].
				const json = quoteToken( payload );
				dispatch( `send_struct ${ nodeId } ${ json }` );
			} else if ( 'send_eof' === action ) {
				dispatch( `send_eof ${ nodeId }` );
			} else if ( 'register' === action || 'unregister' === action ) {
				// Payload is `<target> <event>`; nodeId is the source.
				dispatch( `${ action } ${ nodeId } ${ payload }` );
			} else if ( 'trace' === action ) {
				const level = 'number' === typeof payload ? payload : 1;
				dispatch( `trace ${ nodeId } ${ level }` );
				// Reflect the level now; `*` fans out in ONE publish.
				if ( '*' === nodeId ) {
					Core.node( names.METADATA )?.optimisticPatchAll( {
						debug_state: level,
					} );
				} else {
					patch( nodeId, { debug_state: level } );
				}
			} else if ( 'invoke' === action && payload ) {
				invoke( nodeId, payload );
			}
		};
		return {
			onConnect: ( from, to ) => {
				dispatch( `connect_node ${ from } ${ to }` );
				// Tee's connect_node appends; replacing drops its edges.
				const current = Core.node( names.METADATA )?.rawMap?.[ from ]
					?.target;
				/** @type {string|Array} */
				let next = to;
				if ( Array.isArray( current ) ) {
					next = current.includes( to )
						? current
						: [ ...current, to ];
				}
				patch( from, { target: next } );
			},
			onRemoveEdge: ( from, to ) => {
				dispatch( `disconnect_node ${ from } ${ to }` );
				// Mirror the server: drop `to` from a Tee array, else clear.
				const current = Core.node( names.METADATA )?.rawMap?.[ from ]
					?.target;
				if ( Array.isArray( current ) ) {
					patch( from, {
						target: current.filter( ( t ) => t !== to ),
					} );
				} else if ( current === to ) {
					patch( from, { target: '' } );
				}
			},
			onRemoveNode: ( id ) => {
				dispatch( `remove_node ${ id }` );
				patch( id, null );
			},
			onDropNode: ( { shellName, x, y } ) => {
				// A live drop opens NewNodeModal to edit its name and args.
				const defaultName = generateNodeName( graph, shellName );
				const cls = catalogClasses.find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				onDropStage( { shellName, defaultName, argSchema, x, y } );
			},
			onInspectorAction: ( action, nodeId, payload ) => {
				// Decided first, so a send that raises still shows the REPL.
				if ( ! isUiBound( action, payload ) ) {
					onReplSend();
				}
				act( action, nodeId, payload );
			},
			onCompose: ( form ) => {
				if ( ! shell ) {
					return noSession();
				}
				const { message, forged, error } = composeMessage(
					form,
					shell
				);
				if ( error ) {
					return error;
				}
				if ( ! sseGuard( message[ TO ] ) ) {
					return sseRefusal();
				}
				const typedAuth = message[ VALUE ]?.auth;
				markLocal( message, forged );
				// Strip only an auth the signer added; a typed one is the test.
				const signed = message[ VALUE ]?.auth !== typedAuth;
				// Echo before the send, as a statement is: the Router peels TO.
				const refused = sendMinted(
					message,
					echoed(
						formatMessageEnvelope(
							signed ? unsigned( message ) : message
						)
					)
				);
				if ( refused ) {
					return refused.text;
				}
				// The REPL opens only for a send that returned.
				onReplSend();
				return null;
			},
		};
	}, [
		shell,
		graph,
		catalogClasses,
		dispatch,
		append,
		onReplSend,
		onDropStage,
		sseGuard,
	] );
}
