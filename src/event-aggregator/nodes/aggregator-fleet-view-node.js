import { ID, TYPE, VALUE, TM_ERROR, Node } from '@newspack-nodes/runtime';
import {
	errorMessage,
	PendingReplies,
} from '@newspack-nodes/shared/pendingReplies';

/**
 * `aggregator:fleet` — owns ONLY the on-demand per-spoke fleet-probe roll-ups
 * (`probes` keyed by server id), separate from the polled connection-health
 * slices (`summary:view` / `servers:view`). It mirrors `vault:test`: the hook
 * awaits each `probe` dispatch via this node's `replies` registry, and on settle
 * `fill()` files the roll-up (or error) into a published
 * `{ probes: { [id]: { ok, rollup | error } } }` model — a per-concern,
 * inspectable reply state.
 *
 * `fill()` receives the reply Messages HttpOutNode feeds back (router peels the
 * reply's TO = `aggregator:fleet`). The outbound `message[ID]` carries the server
 * id so the roll-up files per row. Only probes this node awaited are recorded.
 */
export class AggregatorFleetViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};
		this.model = { probes: {} };
		this.replies = new PendingReplies();
		this.setState( 'view', this.model );
	}

	fill( message ) {
		const id = message[ ID ];
		if ( ! id || ! this.replies.has( id ) ) {
			return;
		}
		const value = message[ VALUE ];
		const isError = 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR );
		const payload =
			value && 'object' === typeof value ? value.payload : value;
		this._record( id, isError, payload );
		this.replies.settle( message );
	}

	// File one spoke's roll-up under its server id; preserve the other rows.
	_record( id, isError, payload ) {
		this.model = {
			probes: {
				...this.model.probes,
				[ id ]: isError
					? { ok: false, error: errorMessage( payload ) }
					: { ok: true, rollup: payload },
			},
		};
		this.setState( 'view', this.model );
	}

	// Reject in-flight probes on removal so teardown strands no caller.
	removeNode() {
		this.replies.rejectAll( 'View removed before reply' );
		super.removeNode();
	}

	// Consume-and-publish terminal: fill() settles/records, never forwards.
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Owns the Aggregator per-spoke fleet-probe roll-ups.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
