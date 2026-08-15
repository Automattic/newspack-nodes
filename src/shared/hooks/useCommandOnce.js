/**
 * useCommandOnce — one verb on the batched tick, sent exactly once.
 *
 * `run( args )` parks the arguments; the next fan-out takes them, sends ONE
 * command, and the reply lands on this hook's own result node. Nothing here
 * mints a POST of its own.
 *
 * `retry` marks an idempotent READ and decides two things. It re-asks a request
 * that went MISSING — never a refusal, which is an answer — and a second `run()`
 * supersedes rather than queues. A write is the opposite on both counts: an
 * unanswered write may already have applied, and two rows deleted in the same
 * second are two commands that both have to go.
 *
 * One command is in flight at a time. Every reply is paired with the send it
 * answers, so a second send before the first is answered would leave every
 * later answer naming the wrong subject.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { CommandInterpreterNode, useNodeState } from '@newspack-nodes/runtime';
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

/** How long a WRITE waits for a reply before giving its slot up. */
const DEADLINE_MS = 30000;

/**
 * @param {Object}   o          Options.
 * @param {string}   o.command  The verb to send.
 * @param {string}   [o.ci]     The server CI mount the verb lives on; omit for
 *                              an interpreter builtin, which has none.
 * @param {string}   [o.scope]  Names this verb's own nodes; defaults to
 *                              `<ci>:<command>`, and only needs giving when two
 *                              hooks would otherwise collide on it.
 * @param {Function} [o.onDone] `( { result, error, errorData, args } ) => void`,
 *                              once per reply; `args` are the ones it answered.
 * @param {boolean}  [o.retry]  True for an idempotent READ; see above.
 * @return {{run: (args: string[]) => void, result: ?Object, error: ?string, errorData: ?Object, answeredArgs: ?string[], pending: boolean, seq: number}}
 *   `seq` counts replies, so a repeat of an identical answer still registers.
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

	// The one command in flight, `{ args, askedAt }`, and the queue behind it.
	const slotRef = useRef( null );
	const queueRef = useRef( [] );
	const [ answeredArgs, setAnsweredArgs ] = useState( null );
	const onDoneRef = useRef( onDone );
	onDoneRef.current = onDone;
	const retryRef = useRef( retry );
	retryRef.current = retry;
	const [ sending, setSending ] = useState( false );

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
					// A verb answering '' replies nothing at all; give up.
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

	// One call per reply; the watermark is what makes it once, not per render.
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
		// A transport refusal is no answer: a read keeps its slot and re-asks.
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
