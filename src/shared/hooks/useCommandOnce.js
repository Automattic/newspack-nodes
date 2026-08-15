/**
 * useCommandOnce — a MUTATION on the batched-poll graph.
 *
 * Save, delete and activate each used to mint their own POST from a React
 * callback and hand back a Promise, which put every mutation outside the
 * router's lock/flush bracket — its own request, on its own schedule. This
 * rides the tick like everything else: `run( args )` parks the arguments, the
 * next fan-out takes them and sends ONE command, and the reply lands on this
 * hook's own result node.
 *
 * A mutation is not a poll, and the difference is the whole design. The
 * Fetcher's fire-time getter TAKES the pending arguments — clearing them as it
 * reads — so the send happens on exactly one tick and every tick after it has
 * nothing to say.
 *
 * `retry` opts a READ back into asking again. What it retries is a request that
 * went MISSING — dropped on the wire, or sent while the session was being
 * renewed — which is what leaves a page loaded halfway. It is NOT retrying a
 * refusal: a refusal is an answer, and asking again forever would put a command
 * per second on the wire for a topology that does not exist. A write never
 * retries at all, because an unanswered write may already have been applied.
 *
 * `retry` also decides what a SECOND `run()` means. A read supersedes: opening
 * one topology and then another must not fetch the first, whose answer nobody
 * wants. A write queues: two rows removed in the same second are two commands
 * that both have to go, and replacing the first would drop it silently.
 *
 * A retried read waits `RETRY_AFTER_MS` between asks rather than re-asking on
 * every tick. The verb behind one can be a log scan, and a reply slower than
 * the tick would otherwise be asked for again — and again — while the first is
 * still being answered, each duplicate landing as another `onDone`.
 *
 *   useCommandOnce( {
 *     scope:   'topologies:save',            // names this mutation's own nodes
 *     target:  '_shell/_http/topologies',    // the server CI mount
 *     command: 'save',
 *   } );
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { CommandInterpreterNode, useNodeState } from '@newspack-nodes/runtime';
import { useBatchedPoll } from './useBatchedPoll';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { CommandResultNode } from '../nodes/command-result-node';

CommandInterpreterNode.registerNodeClasses( {
	CommandResult: CommandResultNode,
} );

/** Every router tick; batched, a mutation costs no request of its own. */
const TICK_MS = 1000;

/** How long a retried READ waits before asking again. */
const RETRY_AFTER_MS = 5000;

/** How long a WRITE waits for a reply before giving its slot up. */
const DEADLINE_MS = 30000;

/**
 * @param {Object}   o          Options.
 * @param {string}   o.scope    Names this mutation's own nodes. One hook per verb:
 *                              two mutations sharing a result node would be one
 *                              node doing two jobs, which is what addressing exists
 *                              to make unnecessary.
 * @param {string}   o.target   Egress path the Fetcher targets (`_shell/_http/<ci>`).
 * @param {string}   o.command  The verb to send.
 * @param {Function} [o.onDone] `( { result, error, args } ) => void`, fired once
 *                              per reply. The call sites were `try { await … }
 *                              catch`, and everything after the await — the
 *                              toast, the mode change, the catalog reload —
 *                              goes here. `args` are the ones that produced it,
 *                              so a confirmation can name what it confirmed.
 * @param {boolean}  [o.retry]  True for an idempotent READ: keep sending until a
 *                              reply of any kind lands. A write must leave this
 *                              false — a resend could apply it twice.
 * @return {{run: (args: string[]) => void, result: ?Object, error: ?string, errorData: ?Object, answeredArgs: ?string[], pending: boolean, seq: number}}
 *   `run()` parks the arguments for the next tick. `result` is the last reply's
 *   payload (null while none or after a refusal), `error` the last refusal's
 *   text with `errorData` whatever else it carried, `answeredArgs` the
 *   arguments that reply answered, and `seq` counts replies so a repeat of an
 *   identical answer still registers.
 */
export function useCommandOnce( {
	scope,
	target,
	command,
	onDone,
	retry = false,
} ) {
	const view = `${ scope }:result`;

	// The one command in flight, `{ args, askedAt }`, or null between sends.
	const slotRef = useRef( null );
	// Writes still to send; a read supersedes and never queues.
	const queueRef = useRef( [] );
	const [ answeredArgs, setAnsweredArgs ] = useState( null );
	const onDoneRef = useRef( onDone );
	onDoneRef.current = onDone;
	const retryRef = useRef( retry );
	retryRef.current = retry;
	const [ sending, setSending ] = useState( false );

	// Settle the slot and tell the caller, whatever the answer was.
	const settle = useCallback( ( args, answer ) => {
		slotRef.current = null;
		setAnsweredArgs( args );
		setSending( 0 < queueRef.current.length );
		onDoneRef.current?.( { ...answer, args } );
	}, [] );

	const { pollNow } = useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ scope }:fetch`,
				receiver: `${ scope }:in`,
				command,
				argsFn: () => {
					const now = Date.now();
					let slot = slotRef.current;
					// @longform
					// A write that drew no reply gives up its slot: a verb
					// whose result is the empty string answers nothing at all,
					// and a slot held forever leaves `pending` stuck and every
					// later reply paired with the wrong arguments.
					if ( slot && ! retryRef.current ) {
						if ( now - slot.askedAt < DEADLINE_MS ) {
							return null;
						}
						settle( slot.args, {
							result: null,
							error: `no reply to ${ command } within ${
								DEADLINE_MS / 1000
							}s`,
							errorData: null,
						} );
						slot = null;
					}
					if ( ! slot ) {
						const [ next ] = queueRef.current;
						if ( ! next ) {
							return null;
						}
						queueRef.current = queueRef.current.slice( 1 );
						slot = { args: next, askedAt: 0 };
						slotRef.current = slot;
					} else if ( now - slot.askedAt < RETRY_AFTER_MS ) {
						// A read waits out its window before asking again.
						return null;
					}
					slot.askedAt = now;
					return slot.args;
				},
				view,
				viewClass: 'CommandResult',
				tee,
				target,
			} ),
		timerName: `${ scope }:timer`,
		teeName: `${ scope }:tee`,
		intervalMs: TICK_MS,
		// Part of a page, never its graph; the owner keeps Reset Graph.
		passenger: true,
	} );

	const model = useNodeState( view, 'result' );
	const seq = model?.seq ?? 0;
	const answeredRef = useRef( 0 );

	// One call per reply; `answeredRef` is what makes it once, not per render.
	useEffect( () => {
		// A seq BELOW the watermark is a rebuilt node, not a stale reply.
		if ( seq < answeredRef.current ) {
			answeredRef.current = 0;
		}
		if ( 0 === seq || seq <= answeredRef.current ) {
			return;
		}
		answeredRef.current = seq;
		const slot = slotRef.current;
		// An answer to a settled question; nobody is waiting on it.
		if ( ! slot ) {
			return;
		}
		// @longform
		// A transport refusal is not the server's answer: the batch never
		// reached the verb, so a read keeps its slot and asks again once the
		// window passes. A write does not, because a POST that failed midway
		// may still have applied — its caller is told.
		if ( retryRef.current && model.undelivered ) {
			return;
		}
		settle( slot.args, {
			result: model.ok ? model.payload : null,
			error: model.error ?? null,
			errorData: model.errorData ?? null,
		} );
	}, [ seq, model, settle ] );

	const run = useCallback(
		( args ) => {
			const tokens = Array.isArray( args ) ? args : [];
			if ( retryRef.current ) {
				// Supersede: the outstanding ask's answer is wanted by nobody.
				slotRef.current = null;
				queueRef.current = [ tokens ];
			} else {
				queueRef.current = [ ...queueRef.current, tokens ];
			}
			setSending( true );
			// A click waits for a tick, not for the heartbeat to come round.
			pollNow();
		},
		[ pollNow ]
	);

	return {
		run,
		answeredArgs,
		result: model?.ok ? model.payload : null,
		error: model?.error ?? null,
		errorData: model?.errorData ?? null,
		pending: sending,
		seq,
	};
}
