import { markLocal } from '../../runtime/command-auth';
import { useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_REQUEST,
} from '../../runtime/message';
import { generateNodeName } from '../utils/consoleGraph';
import { quoteToken, tokenize } from '../../runtime/shell-node';
import names from '../../runtime/reserved-node-names.json';
import { Core } from '../../runtime/core';
import { canonicalReverseCwd } from '../../runtime/metadata-node';

/** @typedef {import('../../runtime/message').ComposeFields} ComposeFields */

/** @typedef {{ kind: string, text: string, prompt?: string }} TranscriptEntry */

/**
 * Routes one verb as a command line. Both consumers point this at their own
 * `sendLine`; `flags` rides only when the Compose pane supplies reply flags.
 *
 * @typedef {(line: string, verb: string, args: string, flags?: ComposeFields) => void} Dispatch
 */

/**
 * Runs one Inspector verb. `payload` is the verb's argument — a phrase for
 * `send`, a level for `trace`, the `{ verb, kind, positional, replyTo }` record
 * for `invoke` — and `flags` the Compose pane's reply flags.
 *
 * @typedef {(action: string, nodeId: string, payload?: (string|number|Object), flags?: ComposeFields) => void} InspectorAction
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
 */

/**
 * One handler set for the canvas and Inspector gestures, shared by the debug
 * overlay and the topology console: connect, disconnect, remove, palette drop,
 * the Inspector's dump / command / tail / send / trace verbs, and invoke.
 *
 * Every gesture but `invoke` becomes a command line handed to `dispatch`, which
 * both consumers point at their own `sendLine`. That is the path the REPL
 * prompt uses, and it owns the transcript echo, the Compose fields, the cwd
 * mirror and the `debug_state` persist; a second dispatch path would let a
 * gesture such as `trace` skip all four.
 *
 * `invoke` builds its own message, because a command line expresses none of
 * what it decides: whether the verb goes to the node or to its `:config`
 * sibling (the catalog's `is_interpreter` flag), whether the message is a
 * TM_COMMAND or a TM_REQUEST, how `prefix` and `replyFrom` scope it to the
 * attached worker's cwd, and whether `sseGuard` refuses it for want of a live
 * stream. The `_output` Dumper mints and signs the command — the minter signs,
 * never the ingress (ADR-15) — and hands back null while a session is being
 * re-established, which drops the gesture rather than send it unsigned. The
 * reply is addressed rather than correlated: the server answers TO the FROM
 * `replyFrom` stamped (ADR-7), which is why a caller owning its own reply node
 * passes `replyTo` instead of an operation id.
 *
 * Every mutation also patches `_metadata`'s raw map, so the canvas repaints
 * before the next poll. The patch mirrors the server rather than guessing:
 * `connect_node` APPENDS on a Tee, so the patch appends too, and replacing
 * there would erase the fan-out's other edges until the next poll put them
 * back.
 *
 * @param {Object}                           args
 * @param {?Object}                          args.shell          Session Shell. `invoke` fills its sink and reads `shell.path` for the echo prompt; without one `invoke` does nothing.
 * @param {{ nodes: Array, edges: Array }}   args.graph          The live graph. `invoke` reads the target node's class from it, and a palette drop derives a name that does not collide.
 * @param {Array}                            args.catalogClasses Class catalog entries, matched on `shell_name`: `is_interpreter` picks the invoke target, and `arguments` becomes the drop modal's schema.
 * @param {Dispatch}                         args.dispatch       Routes each non-invoke gesture.
 * @param {(entry: TranscriptEntry) => void} args.append         Appends one transcript entry — the invoke echo, and the refusal `sseGuard` produces.
 * @param {(drop: DropStage) => void}        args.onDropStage    Stages a palette drop; the consumer's commit dispatches the `make_node`.
 * @param {(to: string) => string}           [args.prefix]       Wraps the invoke TO, defaulting to identity.
 * @param {(node: string) => string}         [args.replyFrom]    Wraps the invoke FROM, defaulting to identity.
 * @param {(to: string) => boolean}          [args.sseGuard]     Returns false to refuse an invoke and append an error, defaulting to always-allow. Only an attached-worker reply rides the stream, so the overlay keeps the default.
 * @return {GraphHandlers} The gesture handlers.
 */
export function useGraphHandlers( {
	shell,
	graph,
	catalogClasses = [],
	dispatch,
	append,
	onDropStage,
	prefix = ( x ) => x,
	replyFrom = ( x ) => x,
	sseGuard = () => true,
} ) {
	return useMemo( () => {
		// Patch the local metadata so the canvas repaints before the poll.
		const patch = ( name, p ) =>
			name && Core.node( names.METADATA )?.optimisticPatch( name, p );
		return {
			onConnect: ( from, to ) => {
				dispatch(
					`connect_node ${ from } ${ to }`,
					'connect_node',
					`${ from } ${ to }`
				);
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
				dispatch(
					`disconnect_node ${ from } ${ to }`,
					'disconnect_node',
					`${ from } ${ to }`
				);
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
				dispatch( `remove_node ${ id }`, 'remove_node', id );
				patch( id, null );
			},
			onDropNode: ( { shellName, x, y } ) => {
				// A live drop opens NewNodeModal to edit its name and args.
				const defaultName = generateNodeName( graph, shellName );
				const cls = ( catalogClasses || [] ).find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				onDropStage( { shellName, defaultName, argSchema, x, y } );
			},
			onInspectorAction: ( action, nodeId, payload, flags ) => {
				// Compose reply flags ride as a 4th argument, omitted if none.
				const dispatchVerb = ( line, verb, args ) =>
					flags
						? dispatch( line, verb, args, flags )
						: dispatch( line, verb, args );
				if ( 'dump' === action ) {
					dispatch( `dump_node ${ nodeId }`, 'dump_node', nodeId );
				} else if ( 'dump_config' === action ) {
					dispatch(
						`dump_config ${ nodeId }`,
						'dump_config',
						nodeId
					);
				} else if ( 'command' === action ) {
					// A raw command line, split into verb and arguments.
					const line = String( payload ).trim();
					const sp = line.indexOf( ' ' );
					const verb = -1 === sp ? line : line.slice( 0, sp );
					const args = -1 === sp ? '' : line.slice( sp + 1 ).trim();
					dispatch( line, verb, args );
				} else if ( 'tail' === action ) {
					// A bare connect_node appends the reply path as a target.
					dispatch(
						`connect_node ${ nodeId }`,
						'connect_node',
						nodeId
					);
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
					dispatch(
						`disconnect_node ${ nodeId }`,
						'disconnect_node',
						nodeId
					);
					const meta = Core.node( names.METADATA )?.rawMap;
					const pwd = canonicalReverseCwd( meta?._header?.pwd );
					const current = meta?.[ nodeId ]?.target;
					if ( pwd && Array.isArray( current ) ) {
						patch( nodeId, {
							target: current.filter( ( t ) => t !== pwd ),
						} );
					}
				} else if ( 'cmd' === action ) {
					dispatchVerb(
						`command_node ${ nodeId } ${ payload }`,
						'command_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( 'send' === action ) {
					dispatchVerb(
						`send_node ${ nodeId } ${ payload }`,
						'send_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( 'request' === action ) {
					dispatchVerb(
						`request_node ${ nodeId } ${ payload }`,
						'request_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( 'tell' === action ) {
					dispatchVerb(
						`tell_node ${ nodeId } ${ payload }`,
						'tell_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( 'send_struct' === action ) {
					// Quote the JSON so the tokenizer keeps it one token [#32].
					const json = quoteToken( payload );
					dispatchVerb(
						`send_struct ${ nodeId } ${ json }`,
						'send_struct',
						`${ nodeId } ${ json }`
					);
				} else if ( 'send_eof' === action ) {
					dispatchVerb( `send_eof ${ nodeId }`, 'send_eof', nodeId );
				} else if ( 'register' === action || 'unregister' === action ) {
					// Payload is `<target> <event>`; nodeId is the source.
					dispatch(
						`${ action } ${ nodeId } ${ payload }`,
						action,
						`${ nodeId } ${ payload }`
					);
				} else if ( 'trace' === action ) {
					const level = 'number' === typeof payload ? payload : 1;
					dispatch(
						`trace ${ nodeId } ${ level }`,
						'trace',
						`${ nodeId } ${ level }`
					);
					// Reflect the level now; `*` fans out in ONE publish.
					if ( '*' === nodeId ) {
						Core.node( names.METADATA )?.optimisticPatchAll( {
							debug_state: level,
						} );
					} else {
						patch( nodeId, { debug_state: level } );
					}
				} else if ( 'invoke' === action && payload ) {
					if ( ! shell ) {
						return;
					}
					const { verb, kind, positional, replyTo } = payload;
					// The catalog flag decides, not a search for `:config`.
					const node = ( graph?.nodes || [] ).find(
						( n ) => n.id === nodeId
					);
					const cls =
						node && catalogClasses
							? catalogClasses.find(
									( c ) => c.shell_name === node.class
							  )
							: null;
					const isInterpreter = !! ( cls && cls.is_interpreter );
					const commandTarget =
						'request' === kind || isInterpreter
							? nodeId
							: `${ nodeId }:config`;
					const to = prefix( commandTarget );
					// Only an attached worker's reply needs the SSE session.
					if ( ! sseGuard( to ) ) {
						append( {
							kind: 'error',
							text: __(
								'[no sse_pid yet] retry once CONNECTED',
								'newspack-nodes'
							),
						} );
						return;
					}
					let m;
					let echo;
					if ( 'request' === kind ) {
						// Mirror the Shell: mark LOCAL; a request is unsigned.
						m = newMessage();
						m[ TYPE ] = TM_REQUEST;
						m[ VALUE ] = positional
							? `${ verb } ${ positional }`
							: verb;
						markLocal( m );
						echo = `request_node ${ nodeId } ${ verb }${
							positional ? ' ' + positional : ''
						}`;
					} else {
						// `_output` mints it; tokenize at the producer.
						m = Core.node( names.OUTPUT )?.command(
							verb,
							tokenize( positional || '' )
						);
						if ( ! m ) {
							return; // unauthenticated; re-auth is under way
						}
						echo = `command_node ${ commandTarget } ${ verb }${
							positional ? ' ' + positional : ''
						}`;
					}
					m[ TO ] = to;
					// A caller owning a reply node names it (ADR-7).
					m[ FROM ] = replyFrom( replyTo || names.OUTPUT );
					append( {
						kind: 'sent',
						text: echo,
						prompt: `/${ shell.path }`,
					} );
					shell.sink?.fill( m );
				}
			},
		};
	}, [
		shell,
		graph,
		catalogClasses,
		dispatch,
		append,
		onDropStage,
		prefix,
		replyFrom,
		sseGuard,
	] );
}
