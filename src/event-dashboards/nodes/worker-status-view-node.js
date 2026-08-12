import {
	TYPE,
	VALUE,
	TM_ERROR,
	TM_STRUCT,
	newMessage,
} from '../../runtime/message';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

// Segment slide-out window (ms): how long a removing row lingers.
const REMOVING_CLEAR_MS = 400;

// Empty model so a pre-poll error still publishes a render-able view.
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
 * `workerstatus:view` — owns the Worker Status view model, the single surface
 * React reads via useNodeState('workerstatus:view','view').
 *
 * A SliceViewNode whose slice arrives pre-parsed from the transform rather than
 * as a JSON payload, so `fill()` routes the struct actions itself and defers
 * every TM_ERROR to the base — which keeps the model already on screen, adds
 * `error`, and clears `loading`.
 *
 * Everything that arrives here is un-correlated: mutations such as `restart` are
 * minted by their own request nodes, so their replies land there, not here.
 *  - TM_STRUCT `{ action:'model', model }` from the transform stores + publishes
 *    the model (the dump_graph reply path: HttpOut → transform → view).
 *  - TM_STRUCT `{ action:'clear-removing' }` blanks removingSegments.
 *  - A model with non-empty removingSegments schedules a 400ms self-fill of
 *    `clear-removing` so the slide-out animation completes (timer lives here,
 *    in the graph, not in the React view).
 */
export class WorkerStatusViewNode extends SliceViewNode {
	/**
	 * Publishes the empty model (base) and zeroes the slide-out clear timer.
	 */
	constructor() {
		super();
		this._clearTimer = null;
	}

	/**
	 * Absorb one inbound frame into the view model, then publish it.
	 *
	 * A TM_ERROR goes to the base, which surfaces it without blanking what is
	 * on screen. Otherwise `VALUE.action` selects the update: `model` replaces
	 * the whole model, `clear-removing` ends the slide-out animation. A frame
	 * whose VALUE is not an object carries nothing this node can use and is
	 * ignored — the counter still advances, so the overlay's throughput
	 * reflects everything that arrived.
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
			this._setModel( value.model );
			return;
		}

		// Slide-out animation clear (self-fill from _setModel's setTimeout).
		if ( 'clear-removing' === value.action ) {
			this.model = { ...this.model, removingSegments: {} };
			this._publish();
		}
	}

	/**
	 * Store and publish the transform's enriched snapshot, then arm the slide-out
	 * clear when it marks segments as removing.
	 *
	 * The timer lives here rather than in React so the animation window survives a
	 * re-render; a fresh model restarts it, so the last removal always gets its full
	 * REMOVING_CLEAR_MS.
	 *
	 * @param {Object} model The enriched dump_graph snapshot, replacing the current
	 *                       model wholesale; `removingSegments` drives the timer.
	 * @return {void}
	 */
	_setModel( model ) {
		this.model = model;
		this._publish();
		// Schedule the slide-out clear only when something is animating out.
		if ( Object.keys( model.removingSegments || {} ).length > 0 ) {
			if ( this._clearTimer ) {
				clearTimeout( this._clearTimer );
			}
			this._clearTimer = setTimeout( () => {
				this._clearTimer = null;
				const message = newMessage();
				message[ TYPE ] = TM_STRUCT;
				message[ VALUE ] = { action: 'clear-removing' };
				this.fill( message );
			}, REMOVING_CLEAR_MS );
		}
	}

	/**
	 * Push the current model out under the `view` event — the one surface React
	 * reads through useNodeState.
	 *
	 * @return {void}
	 */
	_publish() {
		this.setState( 'view', this.model );
	}

	/**
	 * The shaped-but-empty model a render before the first poll reads.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return emptyModel();
	}

	/**
	 * Cancel the slide-out timer, so a pending clear can't setState into a view
	 * nobody is reading, then hand off to the base.
	 *
	 * The graph's teardown calls `removeNode()` on every node it built, which is
	 * why the destructor belongs here and no caller reaches in for it.
	 *
	 * @return {void}
	 */
	removeNode() {
		if ( this._clearTimer ) {
			clearTimeout( this._clearTimer );
			this._clearTimer = null;
		}
		super.removeNode();
	}

	/**
	 * Hidden from the node palette: the dashboard wires this sink itself, and it
	 * takes no arguments and no target.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description:
				'Worker Status render-model sink (the React view node).',
		};
	}
}
