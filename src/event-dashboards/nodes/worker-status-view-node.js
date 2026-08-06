import { Node } from '../../runtime/node';
import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { errorMessage } from '../../shared/errorMessage';

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
 * Everything that arrives here is un-correlated: mutations such as `restart` are
 * minted by their own request nodes, so their replies land there, not here.
 *  - TM_ERROR lands in the view-model's `error` field; in practice it is the
 *    poll's own failure.
 *  - TM_STRUCT `{ action:'model', model }` from the transform stores + publishes
 *    the model (the dump_graph reply path: HttpOut → transform → view).
 *  - TM_STRUCT `{ action:'clear-removing' }` blanks removingSegments.
 *  - A model with non-empty removingSegments schedules a 400ms self-fill of
 *    `clear-removing` so the slide-out animation completes (timer lives here,
 *    in the graph, not in the React view).
 */
export class WorkerStatusViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;

	/**
	 * Seeds the empty model so React renders before the first poll returns, and
	 * zeroes the slide-out clear timer.
	 */
	constructor() {
		super();
		this.model = emptyModel();
		this._clearTimer = null;
	}

	/**
	 * Absorb one inbound frame into the view model, then publish it.
	 *
	 * A frame whose VALUE is not an object carries nothing this node can use and is
	 * ignored — the counter still advances, so the overlay's throughput reflects
	 * everything that arrived. A TM_ERROR fills the model's `error` field and clears
	 * `loading`; otherwise `VALUE.action` selects the update: `model` replaces the
	 * whole model, `clear-removing` ends the slide-out animation.
	 *
	 * @param {Array} message The 7-field positional message; VALUE is the transform's
	 *                        `{ action, ... }` struct, or an error payload on TM_ERROR.
	 * @return {void}
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

		// A restart's failure lands on ITS node; this one gets the poll's.
		if ( isError ) {
			this.model = {
				...this.model,
				error: errorMessage( value.payload ),
				loading: false,
			};
			this._publish();
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
				this.model = { ...this.model, removingSegments: {} };
				this._publish();
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
	 * Tear down on unmount: cancel the slide-out timer so a pending clear can't
	 * setState into a view nobody is reading.
	 *
	 * @return {void}
	 */
	close() {
		if ( this._clearTimer ) {
			clearTimeout( this._clearTimer );
			this._clearTimer = null;
		}
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
				'Worker Status render-model sink (the React view node).',
			// Terminal receiver: settles replies, no target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
