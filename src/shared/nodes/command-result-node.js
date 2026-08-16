import {
	Node,
	TYPE,
	VALUE,
	TM_ERROR,
	payloadOf,
} from '@newspack-nodes/runtime';
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
 * Every reply NOTIFIES `result`, so a listener registered on this node runs
 * once per reply. Two replies landing in one batch are two notifications; a
 * consumer that instead renders the published state sees only the last, which
 * is why anything acting on each reply registers rather than re-renders.
 */
export class CommandResultNode extends Node {
	/**
	 * Publish this reply, whatever it says.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
		this.counter += 1;
		const value = message[ VALUE ];
		const payload = payloadOf( value );
		// Both interpreters echo the verb and arguments they answered.
		const args = Array.isArray( value?.arguments ) ? value.arguments : [];
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			this.setState( 'result', {
				ok: false,
				args,
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
		this.setState( 'result', {
			ok: true,
			args,
			payload: payload ?? null,
			error: null,
			errorData: null,
			undelivered: false,
		} );
	}

	/**
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: "Receives a one-shot command's reply; publishes it.",
			registrations: [ 'result' ],
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
