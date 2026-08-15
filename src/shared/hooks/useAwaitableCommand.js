/**
 * useAwaitableCommand — a verb a sequential caller awaits, sent on the batch.
 *
 * Some flows are genuinely sequential: a deep link resolves a request id, then
 * looks up the URL that id names, then selects it. Those want to await, and
 * rewriting them as published state would turn one readable function into a
 * state machine spread across three files.
 *
 * What they must NOT do is mint their own POST to get an answer, which is what
 * the Request node did — its own request, on its own schedule, outside the
 * router's lock/flush bracket. Here the command rides the tick like every
 * other, the reply lands on the node that asked, and the promise is only how
 * the caller waits. Prefer `useCommandOnce` and published state; reach for this
 * when the caller is a sequence rather than a render.
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import { useCommandOnce } from './useCommandOnce';

/**
 * The rejection a refusal mints, carrying the flag that says the SERVER
 * answered — a caller holding a deep-link intent stops retrying on one.
 *
 * @typedef {Error & { fromServer: boolean }} ReplyError
 */

/**
 * @param {string} message The refusal text.
 * @return {ReplyError} The rejection.
 */
function replyError( message ) {
	const error = /** @type {ReplyError} */ ( new Error( message ) );
	error.fromServer = true;
	return error;
}

/**
 * @param {Object} o         Options, as `useCommandOnce` takes them.
 * @param {string} o.command The verb to send.
 * @param {string} [o.ci]    The server CI mount the verb lives on.
 * @param {string} [o.scope] Names this verb's own nodes.
 * @return {(args: string[]) => Promise<*>} Sends on the next tick; resolves
 *   with the reply's payload, or rejects with its refusal.
 */
export function useAwaitableCommand( { command, ci, scope } ) {
	// @longform
	// One waiter per send, in the order `useCommandOnce` answers them. The
	// order holds because EVERY entry earns a reply: a POST that never landed
	// is answered with a TM_ERROR per entry, addressed back to its minter, so
	// there is no dropped send to slide the queue out of step.
	const waitersRef = useRef( [] );

	const { run } = useCommandOnce( {
		command,
		ci,
		scope,
		onDone: ( { result, error } ) => {
			const waiter = waitersRef.current.shift();
			if ( ! waiter ) {
				return;
			}
			if ( error ) {
				waiter.reject( replyError( error ) );
				return;
			}
			waiter.resolve( result );
		},
	} );

	// Tell a caller the graph went away; a hung promise runs no catch.
	useEffect(
		() => () => {
			const waiting = waitersRef.current;
			waitersRef.current = [];
			waiting.forEach( ( { reject } ) =>
				reject( replyError( 'the graph was torn down' ) )
			);
		},
		[]
	);

	return useCallback(
		( args = [] ) =>
			new Promise( ( resolve, reject ) => {
				waitersRef.current.push( { resolve, reject } );
				run( args );
			} ),
		[ run ]
	);
}
