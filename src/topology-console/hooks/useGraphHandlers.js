import { useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_REQUEST,
} from '../../runtime/message';
import { generateNodeName } from '../utils/draftGraph';
import names from '../../runtime/reserved-node-names.json';
import { Core } from '../../runtime/core';
import { canonicalReplyPivot } from '../../runtime/metadata-node';

/**
 * Shared canvas/Inspector command handlers for the debug overlay and topology
 * console: connect / remove / disconnect / send / trace / invoke / drop. The
 * non-invoke verbs become command lines routed through the injected `dispatch`
 * (overlay: `shell.sendCommand` via `sendVerb`; console: `sendLine`); `invoke`
 * builds the raw TM_COMMAND / TM_REQUEST itself because it needs the
 * is_interpreter→target decision, the request/command split, the prefix/replyFrom
 * wrapping, and the SSE-session guard — none of which a command line can express.
 *
 * `prefix`/`replyFrom` default to identity (the overlay is local: cwd '' makes the
 * Shell's own prefix identity anyway); the console injects `shell.prefix` /
 * `shell.replyFrom` so an invoke routes to the worker-pivot cwd. `sseGuard(to)`
 * returns false to block a worker-pivot invoke before a live stream exists
 * (the overlay leaves it at the always-allow default). `onDropStage` stages the
 * NewNodeModal payload; the consumer's commit dispatches the make_node.
 *
 * @param {Object}   args
 * @param {?Object}  args.shell          Session Shell (its sink fills the invoke message).
 * @param {Object}   args.graph          Live graph ({ nodes, edges }); invoke resolves a node's class.
 * @param {Array}    args.catalogClasses Class catalog entries (shell_name + is_interpreter).
 * @param {Function} args.dispatch       (echoLine, name, args) — routes a verb command line.
 * @param {Function} args.append         Append one transcript entry (invoke echo + sse error).
 * @param {Function} args.onDropStage    Stage the NewNodeModal payload on a palette drop.
 * @param {Function} [args.prefix]       Wrap the invoke TO (defaults to identity).
 * @param {Function} [args.replyFrom]    Wrap the invoke FROM (defaults to identity).
 * @param {Function} [args.sseGuard]     (to) → false to block + error an invoke (defaults to always-allow).
 * @return {{ onConnect: Function, onRemoveNode: Function, onDropNode: Function, onInspectorAction: Function }} The handlers.
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
		// After a mutation, optimistically patch the local metadata so the canvas
		// updates immediately instead of waiting for the throttled full poll (a
		// dump_metadata round-trip would race the gesture command to a worker). The
		// next full poll reconciles. `patch === null` drops the node.
		const patch = ( name, p ) =>
			name && Core.node( names.METADATA )?.optimisticPatch( name, p );
		return {
			onConnect: ( from, to ) => {
				dispatch(
					`connect_node ${ from } ${ to }`,
					'connect_node',
					`${ from } ${ to }`
				);
				// A connect APPENDS a target server-side, so for a Tee fan-out
				// (array target) append here too — replacing it with the single
				// new `to` would drop the Tee's other edges from the canvas until
				// the next dump_metadata reasserts them. Single-target nodes
				// (string/empty) just take the new target.
				const current = Core.node( names.METADATA )?.rawMap?.[ from ]
					?.target;
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
				// disconnect_node value-filters the target server-side; mirror it —
				// drop `to` from a Tee fan-out array, or clear a single-target string.
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
				// Live-mode drops always go through the NewNodeModal so the user can
				// override the auto-generated name (and add args when the class
				// declares them). The consumer's commit dispatches the make_node.
				const defaultName = generateNodeName( graph, shellName );
				const cls = ( catalogClasses || [] ).find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				onDropStage( { shellName, defaultName, argSchema, x, y } );
			},
			onInspectorAction: ( action, nodeId, payload ) => {
				if ( 'dump' === action ) {
					dispatch( `dump_node ${ nodeId }`, 'dump_node', nodeId );
				} else if ( 'dump_config' === action ) {
					dispatch(
						`dump_config ${ nodeId }`,
						'dump_config',
						nodeId
					);
				} else if ( 'command' === action ) {
					// Raw server command (no node) — the no-node inspector buttons.
					// payload is the full command line; the verb is its first token.
					const verb = String( payload ).split( /\s+/ )[ 0 ];
					dispatch( payload, verb, '' );
				} else if ( 'tail' === action ) {
					// connect_node with NO target appends the issuing FROM — this
					// session's reply pivot, reported authoritatively as the _header
					// pwd. Append it to the Tee's fan-out array (don't replace, or the
					// other edges vanish until the next poll); the bare value also
					// covers the in-browser tee (pwd === `_output`).
					dispatch(
						`connect_node ${ nodeId }`,
						'connect_node',
						nodeId
					);
					const meta = Core.node( names.METADATA )?.rawMap;
					const pwd = canonicalReplyPivot( meta?._header?.pwd );
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
					// disconnect_node with NO target resolves to the issuing FROM and
					// value-filters JUST that pivot — so optimistically remove only
					// this session's pwd, preserving the Tee's other fan-out edges.
					dispatch(
						`disconnect_node ${ nodeId }`,
						'disconnect_node',
						nodeId
					);
					const meta = Core.node( names.METADATA )?.rawMap;
					const pwd = canonicalReplyPivot( meta?._header?.pwd );
					const current = meta?.[ nodeId ]?.target;
					if ( pwd && Array.isArray( current ) ) {
						patch( nodeId, {
							target: current.filter( ( t ) => t !== pwd ),
						} );
					}
				} else if ( 'send' === action ) {
					dispatch(
						`send_node ${ nodeId } ${ payload }`,
						'send_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( 'trace' === action ) {
					const level = 'number' === typeof payload ? payload : 1;
					dispatch(
						`debug_state ${ nodeId } ${ level }`,
						'debug_state',
						`${ nodeId } ${ level }`
					);
					// Reflect the new trace level at once so the Trace button flips
					// without waiting out the (5s+) dump_metadata poll.
					patch( nodeId, { debug_state: level } );
				} else if ( 'invoke' === action && payload ) {
					if ( ! shell ) {
						return;
					}
					const { verb, kind, positional } = payload;
					// Key on the catalog's per-class is_interpreter flag (NOT a
					// Core.node(`:config`) presence check — in remote scope the
					// browser's Core never holds server-side `:config` siblings, so
					// that check always fell back to nodeId and misrouted verbs on
					// non-interpreter PHP nodes). A request is always answered by the
					// node itself, so it never targets the `:config` sibling.
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
					const m = newMessage();
					m[ TO ] = prefix( commandTarget );
					m[ FROM ] = replyFrom( names.OUTPUT );
					m[ LOCAL ] = true;
					// Only a worker-pivot target's reply rides the async stream; a
					// local-graph invocation interprets in-browser without a pid.
					if ( ! sseGuard( m[ TO ] ) ) {
						append( {
							kind: 'error',
							text: __(
								'[no sse_pid yet] retry once CONNECTED',
								'newspack-nodes'
							),
						} );
						return;
					}
					let echo;
					if ( 'request' === kind ) {
						m[ TYPE ] = TM_REQUEST;
						m[ VALUE ] = positional
							? `${ verb } ${ positional }`
							: verb;
						echo = `request_node ${ nodeId } ${ verb }${
							positional ? ' ' + positional : ''
						}`;
					} else {
						m[ TYPE ] = TM_COMMAND;
						m[ VALUE ] = {
							name: verb,
							arguments: positional || '',
						};
						echo = `command_node ${ commandTarget } ${ verb }${
							positional ? ' ' + positional : ''
						}`;
					}
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
