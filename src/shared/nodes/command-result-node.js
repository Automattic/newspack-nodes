import { Node, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { errorMessage } from '../errorMessage';

/**
 * CommandResultNode — where a ONE-SHOT command's reply lands.
 *
 * The mirror of `SliceViewNode`, and deliberately its opposite on both counts.
 * A slice keeps the last good model and swallows a bad tick, because a widget
 * that blanks on one refused poll is worse than a slightly stale one. A
 * one-shot has a caller waiting on the answer to a save it just sent: every
 * reply publishes, refusals included, or the caller waits forever for news that
 * already arrived.
 *
 * Each reply carries `seq`, incremented here. Two saves that both answer `ok`
 * are otherwise byte-identical, and the second would be invisible to a consumer
 * comparing published state — the number is what makes a repeat observable.
 * It is NOT a correlation id: the reply is already addressed to this node,
 * which is the only reason nothing here has to be told apart (ADR-7).
 */
export class CommandResultNode extends Node {
	/**
	 * Publishes the shaped "nothing sent yet" result, so a consumer rendering
	 * before the first reply reads a model rather than nothing.
	 */
	constructor() {
		super();
		this.seq = 0;
		this.setState( 'result', {
			seq: 0,
			ok: false,
			payload: null,
			error: null,
			errorData: null,
			undelivered: false,
		} );
	}

	/**
	 * Publish this reply, whatever it says.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
		this.counter += 1;
		const value = message[ VALUE ];
		const payload =
			value && 'object' === typeof value ? value.payload : value;
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			this._publish( {
				ok: false,
				payload: null,
				error: errorMessage( payload ),
				// More than prose: a save reports the line it stopped on.
				errorData:
					payload && 'object' === typeof payload ? payload : null,
				// The transport's word, not the server's; see `refusalReply`.
				undelivered: true === value?.undelivered,
			} );
			return;
		}
		this._publish( {
			ok: true,
			payload: payload ?? null,
			error: null,
			errorData: null,
			undelivered: false,
		} );
	}

	/**
	 * @param {Object} result The reply, minus its number.
	 */
	_publish( result ) {
		this.seq += 1;
		this.setState( 'result', { seq: this.seq, ...result } );
	}
}
