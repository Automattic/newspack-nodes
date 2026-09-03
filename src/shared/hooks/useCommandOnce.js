/**
 * useCommandOnce — one verb on the batched tick, sent exactly once each time.
 *
 * `run( args )` parks the arguments in the Fetcher's outbox; the next fan-out
 * sends them, and the reply lands on this hook's own result node because the
 * server echoes TO=FROM. Nothing here mints a POST of its own.
 *
 * The outbox is the FETCHER's, the same one a polled slice throttles itself
 * with — one mechanism for "what have I asked and not been answered", not two.
 * This hook adds only what a caller waiting on an answer needs: what each send
 * is ABOUT, and whether a write queues behind the last one or replaces it.
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

/** Seconds a retried READ waits before asking again; a write never does. */
const RETRY_AFTER_S = 5;

/** A Fetcher that mints nothing on the tick: `run()` is the only source of asks. */
const NOTHING_TO_MINT = () => null;

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
 * Read a subject back off the reply that named it.
 *
 * @param {?string} path The reply's remaining TO, as the address delivered it.
 * @return {?string} The subject the sender named, or null.
 */
const decodeSubject = ( path ) =>
	'string' === typeof path && path ? decodeURIComponent( path ) : null;

/**
 * One reply, unpacked, as `onDone` receives it.
 *
 * @typedef {Object} CommandAnswer
 * @property {?Object}  result    The payload, or null when the reply refused.
 * @property {?string}  error     The refusal, or null when the verb succeeded.
 * @property {?Object}  errorData Structured refusal detail, where there is any.
 * @property {string[]} args      The argument tokens the reply echoed back.
 * @property {?string}  subject   What the send was ABOUT, read off the reply.
 */

/**
 * What a caller waiting on an answer runs, once per reply.
 *
 * @typedef {(answer: CommandAnswer) => void} OnDone
 */

/**
 * Names what a send is ABOUT, reading the tokens it is about to send.
 *
 * @typedef {(args: string[]) => ?string} SubjectOf
 */

/**
 * Mounts one verb's Fetcher, receiver and result node onto the batched tick,
 * and hands back the `run()` that sends it. See the module overview above.
 *
 * @param {Object}    o             Options.
 * @param {string}    o.command     The verb to send.
 * @param {string}    [o.ci]        The server CI mount the verb lives on; omit
 *                                  for an interpreter builtin, which has none.
 * @param {string}    [o.scope]     Names this verb's own nodes; defaults to
 *                                  `<ci>:<command>`, and only needs giving when
 *                                  two hooks would otherwise collide on it.
 * @param {OnDone}    [o.onDone]    Runs once per reply. `args` are the ones it
 *                                  answered and `subject` is what it was ABOUT,
 *                                  both read off the reply itself.
 * @param {boolean}   [o.retry]     True for an idempotent READ; see above.
 * @param {SubjectOf} [o.subjectOf] What this send is ABOUT. It rides in the
 *                                  reply's ADDRESS (FROM becomes
 *                                  `<receiver>/<subject>`, so the answer arrives
 *                                  with the subject as its remaining TO), which
 *                                  is how ONE node answers about many rows with
 *                                  no table. Defaults to the first token;
 *                                  override it for a verb whose first token is
 *                                  a sub-verb rather than a subject (`taillog
 *                                  read <source> <position>`) or a whole
 *                                  document (a rule as JSON).
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
	// Refuse an option this hook would ignore: the caller counts on it.
	const unknown = Object.keys( rest );
	if ( unknown.length ) {
		throw new TypeError(
			`useCommandOnce( { command: '${ command }' } ): no such option ${ unknown.join(
				', '
			) }`
		);
	}
	const target = egressPath( ci );
	const fetcher = `${ scope }:fetch`;
	const view = `${ scope }:result`;

	// @longform No ref for `onDone` or `retry`: `useNodeEvent` keeps its own
	// live callback ref, so the closure registered below is already the latest
	// one on every notification. A ref over `retry` is worse than redundant:
	// it tracks per render, while the node's `retry_after_s` is written once
	// at build, so the two disagree about whether this is a read.
	const subjectOfRef = useRef( subjectOf );
	subjectOfRef.current = subjectOf;
	// A bump, not a copy: the outbox IS what is outstanding.
	const [ , bumpOutbox ] = useState( 0 );
	/** Re-render, so `outstanding` is read fresh out of the outbox. */
	const publishOutstanding = useCallback(
		() => bumpOutbox( ( n ) => n + 1 ),
		[]
	);
	// The outstanding SUBJECTS, not a boolean: a table asks which row waits.
	const outstanding = ( Core.node( fetcher )?.outbox ?? [] ).map( ( ask ) =>
		decodeSubject( ask.path )
	);

	const { pollNow } = useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			addSliceFetcher( interpreter, {
				fetcher,
				receiver: `${ scope }:in`,
				command,
				argsFn: NOTHING_TO_MINT,
				view,
				viewClass: CommandResultNode,
				tee,
				target,
			} );
			// A read re-asks a request that went missing; a write never does.
			Core.node( fetcher ).retry_after_s = retry ? RETRY_AFTER_S : 0;
		},
		timerName: `${ scope }:timer`,
		teeName: `${ scope }:tee`,
		intervalMs: retry ? TICK_MS : IDLE_MS,
		// Part of a page, never its graph; the owner keeps Reset Graph.
		passenger: true,
	} );

	const [ model, setModel ] = useState( null );

	// Registering re-delivers the cached reply; this outlives a remount.
	const seenRef = useRef( null );
	useNodeEvent( view, 'result', ( reply ) => {
		if ( seenRef.current === reply ) {
			return;
		}
		seenRef.current = reply;
		// A transport refusal is no answer: a read keeps asking.
		if ( retry && reply.undelivered ) {
			return;
		}
		// A second answer to a settled question must not run `onDone` again.
		if ( ! Core.node( fetcher )?.isAsking( reply.subject || null ) ) {
			return;
		}
		setModel( reply );
		onDone?.( {
			result: reply.ok ? reply.payload : null,
			error: reply.error ?? null,
			errorData: reply.errorData ?? null,
			args: reply.args ?? [],
			subject: decodeSubject( reply.subject ),
		} );
	} );

	// The outbox emptying is what ends a row's spinner, not the reply landing.
	useNodeEvent( fetcher, 'settled', publishOutstanding );

	/**
	 * Send this verb once, with `args` as its tokens; a non-array sends none.
	 * A read already asking the same question sends nothing.
	 */
	const run = useCallback(
		( args ) => {
			const node = Core.node( fetcher );
			if ( ! node ) {
				return;
			}
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
			// @longform Re-asking for the subject ALREADY OUTSTANDING says
			// nothing new — the retry window owns "ask again for this". Taking
			// it as a fresh ask resets that window and pokes a tick, so a
			// caller whose dep identity churns (an object literal rebuilt each
			// render) would put a command and a whole router tick on the wire
			// per render.
			const [ inFlight ] = node.outbox;
			if (
				retry &&
				inFlight &&
				// NUL, not a space: `[ 'a b' ]` is not `[ 'a', 'b' ]`.
				inFlight.args.join( '\u0000' ) === tokens.join( '\u0000' )
			) {
				return;
			}
			// A read supersedes: nobody wants the answer to the older ask.
			node.send( tokens, tooLong ? null : encoded, retry );
			publishOutstanding();
			// A click waits for a tick, not for the heartbeat to come round.
			pollNow();
		},
		[ command, fetcher, pollNow, publishOutstanding, retry ]
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
