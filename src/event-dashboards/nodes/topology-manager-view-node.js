import { Node } from '../../runtime/node';
import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { errorMessage } from '../../shared/errorMessage';

/**
 * `topologymanager:view` — owns the Topology Manager list model, the single
 * surface React reads via useNodeState('topologymanager:view','view').
 *
 * Follows the canonical serversView/workerStatusView pattern:
 *  - The `topologies list` reply (TM_COMMAND|TM_RESPONSE, FROM=view) stores its
 *    `{ topologies, user_dir }` payload and republishes the model.
 *  - An awaited verb (activate/deactivate) is minted from its OWN Request node
 *    and its reply is addressed there, so a failure the caller is already
 *    catching never reaches this node's `error` field. What lands here is the
 *    poll's, and that IS the global surface.
 */
export class TopologyManagerViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;

	/**
	 * Seeds the published model in its pre-reply state: no topologies, no
	 * `user_dir`, no error, and `loading` true until the first `topologies list`
	 * reply (or a failure) lands.
	 */
	constructor() {
		super();
		// loading until first list reply; error null until a failure.
		this.model = {
			topologies: [],
			userDir: null,
			error: null,
			loading: true,
		};
	}

	/**
	 * Folds one reply into the model and republishes it.
	 *
	 * A TM_ERROR reply becomes the model's global `error` — a mutation's failure
	 * is addressed to the node that minted it, so what arrives here is the
	 * poll's. Otherwise only the `list` reply is consumed: its `payload`
	 * supplies `topologies` and `user_dir`, and it clears any prior error.
	 * Anything else (a non-object VALUE, another verb's reply) is ignored.
	 *
	 * @param {Array} message Positional Message; VALUE is `{ name, payload }`.
	 */
	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
		this.counter += 1;
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const type = message[ TYPE ] || 0;
		const isError = 0 !== ( type & TM_ERROR );

		// A mutation's failure lands on ITS node; this one gets the poll's.
		if ( isError ) {
			this.model = {
				...this.model,
				error: errorMessage( value.payload ),
				loading: false,
			};
			this._publish();
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

	/**
	 * Pushes the current model onto the `view` state key React subscribes to.
	 */
	_publish() {
		this.setState( 'view', this.model );
	}

	/**
	 * Hidden from the node palette: the dashboard wires this sink itself, and it
	 * takes no arguments and no target.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Topology Manager list-model sink (the React view node).',
			// Terminal receiver: settles replies, no target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
