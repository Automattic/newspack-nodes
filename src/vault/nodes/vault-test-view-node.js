import { ID, TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { Node } from '../../runtime/node';
import { errorMessage, PendingReplies } from '../../shared/pendingReplies';

/**
 * `vault:test` — owns ONLY the per-server connection-probe results (the de-god
 * split: the credential LIST concern is `vault:test`'s sibling `vault:list`).
 *
 * The hook awaits each `test` dispatch via this node's `replies` registry,
 * stashing `{ resolve, reject }` under the SERVER ID (the outbound `message[ID]`).
 * When the probe reply routes back (router peels TO = `vault:test`), `fill()`
 * settles the caller's Promise AND files the result into a published
 * `{ results: { [id]: { ok, payload | error } } }` model — so the test concern
 * has its own inspectable, per-concern reply state (a Tee-able edge in the debug
 * overlay).
 *
 * Only probes this node actually awaited are recorded; an un-correlated reply is
 * ignored (the test view never paints a table-wide banner — per-row failures are
 * owned by the caller's catch + the per-row status surface).
 */
export class VaultTestViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};
		this.model = { results: {} };
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
		// Settle the caller's Promise (resolve payload / reject Error).
		this.replies.settle( message );
	}

	// File one probe's outcome under its server id; preserve the other rows.
	_record( id, isError, payload ) {
		this.model = {
			results: {
				...this.model.results,
				[ id ]: isError
					? { ok: false, error: errorMessage( payload ) }
					: { ok: true, payload },
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
			description: 'Owns the Vault per-server connection-probe results.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
