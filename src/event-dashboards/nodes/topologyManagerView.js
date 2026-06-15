import { Node } from '../../runtime/node';
import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { errorMessage, PendingReplies } from '../../shared/pendingReplies';

/**
 * `topologymanager:view` — owns the Topology Manager list model, the single
 * surface React reads via useNodeState('topologymanager:view','view').
 *
 * Follows the canonical serversView/workerStatusView pattern:
 *  - The `topologies list` reply (TM_COMMAND|TM_RESPONSE, FROM=view) stores its
 *    `{ topologies, user_dir }` payload and republishes the model.
 *  - Awaited verbs (activate/deactivate) stash a `{ resolve, reject }` in
 *    `replies` keyed by message[ID]; the matching reply settles the Promise.
 *  - A pending-matched reply does NOT pollute the model's `error` field — that
 *    surface is for un-correlated errors (the initial list poll). A
 *    pending-matched TM_ERROR rejects the caller's Promise only.
 */
export class TopologyManagerViewNode extends Node {
	constructor() {
		super();
		// loading until the first list reply lands; error null until an
		// un-correlated failure surfaces.
		this.model = {
			topologies: [],
			userDir: null,
			error: null,
			loading: true,
		};
		// Hook-stamped ID → { resolve, reject }; settled when the matching reply
		// lands here.
		this.replies = new PendingReplies();
	}

	fill( message ) {
		// Terminal node (no sink) — base Node.fill() can't run, so count here
		// to keep the overlay's per-node throughput honest.
		this.counter += 1;
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const type = message[ TYPE ] || 0;
		const isError = 0 !== ( type & TM_ERROR );

		// Settle any awaited verb (activate/deactivate) stashed under this ID.
		const pendingMatched = this.replies.settle( message );

		// Un-correlated errors (the list poll) surface globally; pending-matched
		// ones are owned by the caller's catch.
		if ( isError ) {
			if ( ! pendingMatched ) {
				this.model = {
					...this.model,
					error: errorMessage( value.payload ),
					loading: false,
				};
				this._publish();
			}
			return;
		}

		// The `topologies list` reply carries the catalog under VALUE.payload.
		if ( 'list' === value.name ) {
			const payload = value.payload || {};
			this.model = {
				topologies: payload.topologies || [],
				userDir: payload.user_dir ?? null,
				error: null,
				loading: false,
			};
			this._publish();
		}
	}

	_publish() {
		this.setState( 'view', this.model );
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Topology Manager list-model sink (the React view node).',
			// Terminal receiver: settles replies, never sets target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
