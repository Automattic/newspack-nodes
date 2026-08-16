/**
 * useCommandOnce — one verb on the batched tick, sent exactly once each time.
 *
 * `run( args )` parks the arguments; the next fan-out sends them, and the reply
 * lands on this hook's own result node because the server echoes TO=FROM.
 * Nothing here mints a POST of its own.
 *
 * Several sends may be outstanding together and nothing pairs them up: both
 * interpreters echo the verb and its arguments into the response VALUE, so a
 * reply says which command it answers. That is the whole of the correlation —
 * no queue, no slot, no id (ADR-7).
 *
 * `onDone` runs once per reply because it REGISTERS on the result node rather
 * than reading rendered state: two replies arriving in one batch are two
 * notifications, but one re-render carrying only the last.
 *
 * `retry` marks an idempotent READ. It re-asks a request that went MISSING —
 * never a refusal, which is an answer — and a second `run()` supersedes rather
 * than adding, because nobody wants the first topology's body once a second is
 * opened. A write neither retries nor supersedes: an unanswered write may
 * already have applied, and two rows deleted in the same second are two
 * commands that both have to go.
 */

import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from '@wordpress/element';
import { Core, CommandInterpreterNode } from '@newspack-nodes/runtime';
import { useBatchedPoll } from './useBatchedPoll';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import { CommandResultNode } from '../nodes/command-result-node';

CommandInterpreterNode.registerNodeClasses( {
	CommandResult: CommandResultNode,
} );

/** Every router tick; batched, this costs no request of its own. */
const TICK_MS = 1000;

/** How long a retried READ waits before asking again. */
const RETRY_AFTER_MS = 5000;

/**
 * @param {Object}   o          Options.
 * @param {string}   o.command  The verb to send.
 * @param {string}   [o.ci]     The server CI mount the verb lives on; omit for
 *                              an interpreter builtin, which has none.
 * @param {string}   [o.scope]  Names this verb's own nodes; defaults to
 *                              `<ci>:<command>`, and only needs giving when two
 *                              hooks would otherwise collide on it.
 * @param {Function} [o.onDone] `( { result, error, errorData, args } ) => void`,
 *                              once per reply; `args` are the ones it answered,
 *                              read off the reply itself.
 * @param {boolean}  [o.retry]  True for an idempotent READ; see above.
 * @return {{run: (args: string[]) => void, result: ?Object, error: ?string, errorData: ?Object, answeredArgs: ?string[], answerFor: (subject: string) => ?Object, pending: boolean}}
 *   `answerFor( subject )` says whether a command about that subject is still
 *   out, or what the last reply about it said — the question a row asks instead
 *   of indexing a table.
 */
export function useCommandOnce( {
	command,
	ci = '',
	scope = ci ? `${ ci }:${ command }` : command,
	onDone,
	retry = false,
	...rest
} ) {
	// An unknown option is a mistake: a stale `target` lost every reply.
	const unknown = Object.keys( rest );
	if ( unknown.length ) {
		throw new TypeError(
			`useCommandOnce( { command: '${ command }' } ): no such option ${ unknown.join(
				', '
			) }`
		);
	}
	const target = egressPath( ci );
	const view = `${ scope }:result`;

	// In flight: `askedAt` 0 until sent, and it leaves when a reply names it.
	const outboxRef = useRef( [] );
	const onDoneRef = useRef( onDone );
	onDoneRef.current = onDone;
	const retryRef = useRef( retry );
	retryRef.current = retry;
	const [ sending, setSending ] = useState( false );

	const { pollNow } = useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ scope }:fetch`,
				receiver: `${ scope }:in`,
				command,
				argsFn: () => {
					// Unsent goes now; a read re-asks once its window is up.
					const next = outboxRef.current.find(
						( send ) =>
							0 === send.askedAt ||
							( retryRef.current &&
								Date.now() - send.askedAt >= RETRY_AFTER_MS )
					);
					if ( ! next ) {
						return null;
					}
					next.askedAt = Date.now();
					return next.args;
				},
				view,
				viewClass: CommandResultNode,
				tee,
				target,
			} ),
		timerName: `${ scope }:timer`,
		teeName: `${ scope }:tee`,
		intervalMs: TICK_MS,
		// Part of a page, never its graph; the owner keeps Reset Graph.
		passenger: true,
	} );

	const [ model, setModel ] = useState( null );

	// Handle ONE reply. Read live from the effect, which registers once.
	const onReplyRef = useRef( null );
	onReplyRef.current = ( reply ) => {
		// A transport refusal is no answer: a read keeps asking.
		if ( retryRef.current && reply.undelivered ) {
			return;
		}
		const args = reply.args ?? [];
		// Retire the ask this answers; nothing waiting = already settled.
		const at = outboxRef.current.findIndex(
			( send ) => send.args[ 0 ] === args[ 0 ]
		);
		if ( 0 > at ) {
			return;
		}
		outboxRef.current = outboxRef.current.filter(
			( _send, i ) => i !== at
		);
		setModel( reply );
		setSending( 0 < outboxRef.current.length );
		onDoneRef.current?.( {
			result: reply.ok ? reply.payload : null,
			error: reply.error ?? null,
			errorData: reply.errorData ?? null,
			args,
		} );
	};

	// Per reply, not per render: two answers in a batch are one re-render.
	const reactId = useId();
	const node = Core.node( view );
	// Registering re-delivers the cached reply, so this outlives a remount.
	const seenRef = useRef( null );
	useEffect( () => {
		if ( ! node ) {
			return undefined;
		}
		const listener = `useCommandOnce/${ reactId }`;
		node.register( 'result', listener, ( reply ) => {
			if ( seenRef.current !== reply ) {
				seenRef.current = reply;
				onReplyRef.current( reply );
			}
			return true;
		} );
		return () => node.unregister( 'result', listener );
	}, [ node, reactId ] );

	const run = useCallback(
		( args ) => {
			const tokens = Array.isArray( args ) ? args : [];
			// @longform Re-asking for the subject ALREADY OUTSTANDING says
			// nothing new — the retry window owns "ask again for this". Taking
			// it as a fresh ask resets that window and pokes a tick, so a
			// caller whose dep identity churns (an object literal rebuilt each
			// render) would put a command and a whole router tick on the wire
			// per render.
			const [ outstanding ] = outboxRef.current;
			if (
				retryRef.current &&
				outstanding &&
				outstanding.args.join( '\u0000' ) === tokens.join( '\u0000' )
			) {
				return;
			}
			const send = { args: tokens, askedAt: 0 };
			// A read supersedes: nobody wants the answer to the older ask.
			outboxRef.current = retryRef.current
				? [ send ]
				: [ ...outboxRef.current, send ];
			setSending( true );
			// A click waits for a tick, not for the heartbeat to come round.
			pollNow();
		},
		[ pollNow ]
	);

	// One source for "what was answered": the reply the node published.
	const answeredArgs = model ? model.args ?? [] : null;

	// The row asks the node that holds its reply, never a table (ADR-7).
	const answerFor = ( subject ) => {
		if (
			outboxRef.current.some( ( send ) => send.args[ 0 ] === subject )
		) {
			return { verb: command, busy: true, error: null, result: null };
		}
		if ( answeredArgs?.[ 0 ] === subject ) {
			return {
				verb: command,
				busy: false,
				error: model?.error ?? null,
				result: model?.ok ? model.payload : null,
			};
		}
		return null;
	};

	return {
		run,
		answeredArgs,
		answerFor,
		result: model?.ok ? model.payload : null,
		error: model?.error ?? null,
		errorData: model?.errorData ?? null,
		pending: sending,
	};
}
