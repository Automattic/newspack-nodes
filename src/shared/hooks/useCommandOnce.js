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

import { useCallback, useRef, useState } from '@wordpress/element';
import {
	CommandInterpreterNode,
	Core,
	useNodeEvent,
} from '@newspack-nodes/runtime';
import { useBatchedPoll } from './useBatchedPoll';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import { CommandResultNode } from '../nodes/command-result-node';

CommandInterpreterNode.registerNodeClasses( {
	CommandResult: CommandResultNode,
} );

/** Every router tick; batched, this costs no request of its own. */
const TICK_MS = 1000;

/**
 * A WRITE is poked by `run()` and by nothing else — it has no cadence to keep,
 * so it arms slowly and rides `pollNow()` instead of fanning out every second
 * to find an empty outbox. A retried READ genuinely needs the tick.
 */
const IDLE_MS = 60000;

/** How long a retried READ waits before asking again. */
const RETRY_AFTER_MS = 5000;

/** An escaped subject longer than this is a body, not an identity. */
const SUBJECT_MAX = 128;

/**
 * A subject is one ADDRESS segment, so a slash or a space is escaped.
 *
 * @param {?string} subject What the send is about, as the caller named it.
 * @return {?string} The escaped path segment, or null when there is none.
 */
const encodeSubject = ( subject ) =>
	null === subject || undefined === subject
		? null
		: encodeURIComponent( subject );

/**
 * @param {?string} path The reply's remaining TO, as the address delivered it.
 * @return {?string} The subject the sender named, or null.
 */
const decodeSubject = ( path ) =>
	'string' === typeof path && path ? decodeURIComponent( path ) : null;

/**
 * @param {Object}   o             Options.
 * @param {string}   o.command     The verb to send.
 * @param {string}   [o.ci]        The server CI mount the verb lives on; omit for
 *                                 an interpreter builtin, which has none.
 * @param {string}   [o.scope]     Names this verb's own nodes; defaults to
 *                                 `<ci>:<command>`, and only needs giving when two
 *                                 hooks would otherwise collide on it.
 * @param {Function} [o.onDone]    `( { result, error, errorData, args, subject
 *                                 } ) => void`, once per reply. `args` are the
 *                                 ones it answered and `subject` is what it was
 *                                 ABOUT, both read off the reply itself.
 * @param {boolean}  [o.retry]     True for an idempotent READ; see above.
 * @param {Function} [o.subjectOf] `( args ) => subject` — what this send is
 *                                 ABOUT. It rides in the reply's ADDRESS (FROM
 *                                 becomes `<receiver>/<subject>`, so the answer
 *                                 arrives with the subject as its remaining TO),
 *                                 which is how ONE node answers about many
 *                                 rows with no table. Defaults to the first
 *                                 token; override it for a verb whose first
 *                                 token is a sub-verb rather than a subject
 *                                 (`taillog read <source> <position>`) or a
 *                                 whole document (a rule as JSON).
 * @return {{run: (args: string[]) => void, isPending: (subject: ?string) => boolean, result: ?Object, error: ?string, errorData: ?Object, answeredArgs: ?string[], pending: boolean}}
 *   A screen serving many rows reads each answer through `onDone`, which
 *   names the subject it was about; what is returned here is the last one.
 */
export function useCommandOnce( {
	command,
	ci = '',
	scope = ci ? `${ ci }:${ command }` : command,
	onDone,
	retry = false,
	subjectOf = ( args ) => args[ 0 ] ?? null,
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
	// The send `argsFn` just handed over, so `replyPathFn` addresses THAT one.
	const sendingRef = useRef( null );
	const onDoneRef = useRef( onDone );
	onDoneRef.current = onDone;
	const retryRef = useRef( retry );
	retryRef.current = retry;
	const subjectOfRef = useRef( subjectOf );
	subjectOfRef.current = subjectOf;
	// The outstanding SUBJECTS, not a boolean: a table asks which row waits.
	const [ outstanding, setOutstanding ] = useState( [] );
	const publishOutstanding = () =>
		setOutstanding( outboxRef.current.map( ( send ) => send.subject ) );
	// `pollNow` arrives after the build body that needs it; hence the ref.
	const pollAgainRef = useRef( null );

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
					sendingRef.current = next;
					// @longform One send per fire, so a queue behind this one
					// asks for the next tick rather than waiting out the
					// cadence — two rows deleted in the same second are two
					// commands, and a write's cadence is a minute.
					if ( outboxRef.current.some( ( s ) => 0 === s.askedAt ) ) {
						pollAgainRef.current?.();
					}
					return next.args;
				},
				// Read in the same tick, right after argsFn chose the send.
				replyPathFn: () => sendingRef.current?.path ?? null,
				view,
				viewClass: CommandResultNode,
				tee,
				target,
			} ),
		timerName: `${ scope }:timer`,
		teeName: `${ scope }:tee`,
		intervalMs: retry ? TICK_MS : IDLE_MS,
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
		// Retire the ask this answers; its ADDRESS is what names it.
		const subject = decodeSubject( reply.subject );
		const at = outboxRef.current.findIndex(
			( send ) => send.subject === subject
		);
		if ( 0 > at ) {
			return;
		}
		outboxRef.current = outboxRef.current.filter(
			( _send, i ) => i !== at
		);
		setModel( reply );
		publishOutstanding();
		onDoneRef.current?.( {
			result: reply.ok ? reply.payload : null,
			error: reply.error ?? null,
			errorData: reply.errorData ?? null,
			args,
			subject,
		} );
	};

	// Registering re-delivers the cached reply; this outlives a remount.
	const seenRef = useRef( null );
	useNodeEvent( view, 'result', ( reply ) => {
		if ( seenRef.current !== reply ) {
			seenRef.current = reply;
			onReplyRef.current( reply );
		}
	} );

	pollAgainRef.current = pollNow;

	const run = useCallback(
		( args ) => {
			const tokens = Array.isArray( args ) ? args : [];
			// @longform A body is not an address. Left to the default, a verb
			// whose first token is a document or a pasted URL would address
			// its reply with the whole thing, past the substrate's FROM cap,
			// and the reply would be dropped. Send it with NO subject and say
			// which command needs `subjectOf` — a save the operator clicked
			// must not become an exception out of the click handler because a
			// caller forgot an option.
			const named = subjectOfRef.current?.( tokens ) ?? null;
			const encoded = encodeSubject( named );
			const tooLong = encoded && SUBJECT_MAX < encoded.length;
			if ( tooLong ) {
				Core.printLessOften(
					`ERROR: useCommandOnce(${ command }): subject of ${ encoded.length } chars is a body, not an address — pass subjectOf`
				);
			}
			const subject = tooLong ? null : named;
			const path = tooLong ? null : encoded;
			// @longform Re-asking for the subject ALREADY OUTSTANDING says
			// nothing new — the retry window owns "ask again for this". Taking
			// it as a fresh ask resets that window and pokes a tick, so a
			// caller whose dep identity churns (an object literal rebuilt each
			// render) would put a command and a whole router tick on the wire
			// per render.
			const [ inFlight ] = outboxRef.current;
			if (
				retryRef.current &&
				inFlight &&
				inFlight.args.join( '\u0000' ) === tokens.join( '\u0000' )
			) {
				return;
			}
			const send = { args: tokens, subject, path, askedAt: 0 };
			// A read supersedes: nobody wants the answer to the older ask.
			outboxRef.current = retryRef.current
				? [ send ]
				: [ ...outboxRef.current, send ];
			publishOutstanding();
			// A click waits for a tick, not for the heartbeat to come round.
			pollNow();
		},
		[ command, pollNow ]
	);

	// One source for "what was answered": the reply the node published.
	const answeredArgs = model ? model.args ?? [] : null;

	return {
		run,
		answeredArgs,
		result: model?.ok ? model.payload : null,
		error: model?.error ?? null,
		errorData: model?.errorData ?? null,
		pending: 0 < outstanding.length,
		isPending: ( subject ) => outstanding.includes( subject ),
	};
}
