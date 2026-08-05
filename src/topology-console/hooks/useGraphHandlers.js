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
 * `shell.replyFrom` so an invoke routes to the attached worker's cwd. `sseGuard(to)`
 * returns false to block an attached-worker invoke before a live stream exists
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
 * @return {{ onConnect: Function, onRemoveEdge: Function, onRemoveNode: Function, onDropNode: Function, onInspectorAction: Function }} The handlers.
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
		// Optimistically patch local metadata; canvas updates before the poll.
		const patch = ( name, p ) =>
			name && Core.node( names.METADATA )?.optimisticPatch( name, p );
		return {
			onConnect: ( from, to ) => {
				dispatch(
					`connect_node ${ from } ${ to }`,
					'connect_node',
					`${ from } ${ to }`
				);
				// connect appends; use append — replace drops Tee edges.
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
				// Mirror disconnect: drop `to` from Tee array, else clear it.
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
				// Live drops go through NewNodeModal to rename/add args.
				const defaultName = generateNodeName( graph, shellName );
				const cls = ( catalogClasses || [] ).find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				onDropStage( { shellName, defaultName, argSchema, x, y } );
			},
			onInspectorAction: ( action, nodeId, payload, flags ) => {
				// Compose reply flags ride as optional 4th arg (omitted else).
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
					// Command: split payload into verb (first token) + args.
					const line = String( payload ).trim();
					const sp = line.indexOf( ' ' );
					const verb = -1 === sp ? line : line.slice( 0, sp );
					const args = -1 === sp ? '' : line.slice( sp + 1 ).trim();
					dispatch( line, verb, args );
				} else if ( 'tail' === action ) {
					// Bare connect appends reply FROM; append, don't replace.
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
					// Bare disconnect drops this reply path; keep Tee's edges.
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
					// Quote+escape JSON to survive the tokenizer [#32].
					const json = quoteToken( payload );
					dispatchVerb(
						`send_struct ${ nodeId } ${ json }`,
						'send_struct',
						`${ nodeId } ${ json }`
					);
				} else if ( 'send_eof' === action ) {
					dispatchVerb( `send_eof ${ nodeId }`, 'send_eof', nodeId );
				} else if ( 'register' === action || 'unregister' === action ) {
					// payload `<target> <event>`; verb adds register <source>.
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
					// Reflect the level now; `*` fans in ONE publish.
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
					// Route by catalog is_interpreter, not `:config` (remote).
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
					// Only attached-worker replies ride stream; local, no pid.
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
						// TYPE first: a later-typed message goes unsigned.
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
