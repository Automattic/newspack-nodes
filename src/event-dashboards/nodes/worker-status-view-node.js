import {
	TYPE,
	VALUE,
	TM_ERROR,
	TM_STRUCT,
	newMessage,
} from '../../runtime/message';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/** Segment slide-out window in ms: how long a removing row lingers. */
const REMOVING_CLEAR_MS = 400;

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
 * `workerstatus:view` — owns the Worker Status view model, the one surface
 * React reads through `useNodeState( 'workerstatus:view', 'view' )`.
 *
 * A `SliceViewNode` whose slice arrives already parsed: `workerstatus:transform`
 * sits on the receiver-Tee edge ahead of it and mints a TM_STRUCT carrying the
 * enriched model, so there is no JSON payload for the base `_parse()` to
 * decode. `fill()` therefore dispatches the struct actions itself and defers
 * every TM_ERROR to the base — which keeps the model already on screen, adds
 * `error`, and clears `loading`.
 *
 * The base identifies a control by its FROM, because a reply carrying an
 * `action` field is still a reply. Here the transform mints one action and this
 * node mints the other into itself, so the action name is the whole selector
 * and `controlFrom` stays unset.
 *
 * Nothing arriving here needs correlating. A mutation such as `restart` is
 * minted by its own `useCommandOnce` node and the server replies TO=FROM, so
 * that reply lands there; this node sees the poll's model and its failures
 * (ADR-7).
 *
 * The three inbound shapes:
 *  - TM_STRUCT `{ action: 'model', model }` from the transform stores the model
 *    and publishes it — the `dump_graph` reply, enriched.
 *  - TM_STRUCT `{ action: 'clear-removing' }` blanks `removingSegments`.
 *  - TM_ERROR surfaces on `error` without blanking the model.
 *
 * A model marking segments as removing arms a REMOVING_CLEAR_MS self-fill of
 * `clear-removing`, so the slide-out animation runs to completion. The timer
 * lives here, in the graph, rather than in the React view, where a re-render
 * would restart it.
 */
export class WorkerStatusViewNode extends SliceViewNode {
	/**
	 * Publish the empty model through the base, with no slide-out clear armed.
	 */
	constructor() {
		super();
		/**
		 * The pending `clear-removing` self-fill, or null when none is armed.
		 * Held so `_setModel()` can restart it and `removeNode()` cancel it.
		 *
		 * @type {?ReturnType<typeof setTimeout>}
		 */
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
	 * Store and publish the transform's enriched snapshot, then arm the
	 * slide-out clear when it marks segments as removing.
	 *
	 * The timer lives here rather than in React so the animation window
	 * survives a re-render; a fresh model carrying removals restarts it, so the
	 * last removal always gets its full REMOVING_CLEAR_MS.
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
	 * reads through useNodeState. `setState` caches it, so a widget mounting
	 * after the poll still reads the current model.
	 *
	 * @return {void}
	 */
	_publish() {
		this.setState( 'view', this.model );
	}

	/**
	 * The shaped-but-empty model a render before the first poll reads. The base
	 * constructor publishes it, so `view` is never undefined.
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
	 * `mountExospine` removes every node its build registered, on unmount and
	 * on each Reset Graph rebuild, which is why the cancel belongs here and no
	 * caller reaches in for it.
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
