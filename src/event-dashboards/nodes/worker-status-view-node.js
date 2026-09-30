import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The shaped-but-empty model, carrying every field the Worker Status widgets
 * destructure so a render before the first poll — or a poll that errors before
 * any model arrives — is still valid.
 *
 * @return {Object} A fresh empty render model.
 */
const emptyModel = () => ( {
	workers: [],
	logs: [],
	byteRates: {},
	writeRates: {},
	segmentSize: 64 * 1024 * 1024,
	currentTime: Math.floor( Date.now() / 1000 ),
	heartbeatIntervalS: 10,
	prevSegments: {},
	removingSegments: {},
	graph: {},
	error: null,
	loading: false,
} );

/**
 * `worker-status:view` — owns the Worker Status view model, the one surface
 * React reads through `useNodeField( 'worker-status:view', 'view' )`.
 *
 * A `SliceViewNode` whose slice arrives already parsed: `worker-status:transform`
 * sits on the receiver-Tee edge ahead of it and mints a TM_STRUCT carrying the
 * enriched model, so there is no JSON payload for the base `_parse()` to
 * decode. `fill()` therefore dispatches the struct actions itself and defers
 * every TM_ERROR to the base — which keeps the model already on screen, adds
 * `error`, and clears `loading`.
 *
 * The slice declares no `controlFrom`, so nothing reaches it as a control;
 * the model comes from the transform and is recognised by its action.
 *
 * Nothing arriving here needs correlating. A mutation such as `restart` is
 * minted by its own `useCommandOnce` node and the server replies TO=FROM, so
 * that reply lands there; this node sees the poll's model and its failures
 * (ADR-7).
 *
 * The two inbound shapes:
 *  - TM_STRUCT `{ action: 'model', model }` from the transform stores the model
 *    and publishes it — the `dump_graph` reply, enriched.
 *  - TM_ERROR surfaces on `error` without blanking the model.
 *
 * A model's `removingSegments` are that poll's departures alone. The row
 * drawing a departed bar keeps it until the bar's slide-out ends, so this node
 * holds nothing across polls.
 */
export class WorkerStatusViewNode extends SliceViewNode {
	/**
	 * Absorb one inbound frame into the view model, then publish it.
	 *
	 * A TM_ERROR goes to the base, which surfaces it without blanking what is
	 * on screen. Otherwise `VALUE.action` selects the update, and `model`
	 * replaces the model. A frame whose VALUE is not an object carries nothing
	 * this node can use and is ignored — the counter still advances, so the
	 * overlay's throughput reflects everything that arrived.
	 *
	 * @param {Array} message The 7-field positional message; VALUE is the transform's
	 *                        `{ action, ... }` struct, or an error payload on TM_ERROR.
	 * @return {void}
	 */
	fill( message ) {
		// A restart's failure lands on ITS node; this one gets the poll's.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			super.fill( message );
			return;
		}
		this.counter += 1;
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}

		// Model updates from the transform: the enriched dump_graph snapshot.
		if ( 'model' === value.action ) {
			this.setField( 'view', value.model );
		}
	}

	/**
	 * The shaped-but-empty model a render before the first poll reads. The base
	 * constructor holds it, so `view` is never undefined.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return emptyModel();
	}

	/**
	 * Node metadata behind `help <Type>` and the console's node palette.
	 * Overrides the description alone: the Hidden category, the empty argument
	 * list and `has_target: false` come from the base, which is right here —
	 * the dashboard hook wires this sink itself, and a view is terminal.
	 *
	 * @return {Object} Schema: category, description, registrations, arguments,
	 *                  commands, has_target.
	 */
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description:
				'Worker Status render-model sink (the React view node).',
		};
	}
}
