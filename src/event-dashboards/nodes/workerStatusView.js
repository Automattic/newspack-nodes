import { Node } from '../../runtime/node';
import { VALUE } from '../../runtime/message';

// Segment slide-out animation window — matches the old WorkerStatus 400ms timer.
const REMOVING_CLEAR_MS = 400;

// Empty model so an error arriving before any poll still publishes a render-able
// (loading-cleared) view. Mirrors WorkerStatus's initial state shape.
const emptyModel = () => ( {
	workers: [],
	supervisor: null,
	logs: [],
	byteRates: {},
	writeRates: {},
	segmentSize: 64 * 1024 * 1024,
	currentTime: Math.floor( Date.now() / 1000 ),
	prevSegments: {},
	removingSegments: {},
	error: null,
	loading: false,
} );

/**
 * `workerstatus:view` — owns the Worker Status view model, the single surface
 * React reads via useNodeState('workerstatus:view','view').
 *
 * Worker Status updates per-poll, not per-frame, so there is no high-frequency
 * rAF path (unlike Raw Logs): every change publishes through the low-frequency
 * setState('view', model). It accepts:
 * - `{ action:'model', model }` — store + publish the enriched model. If the
 *   model carries removingSegments, schedule a 400ms self-fill of
 *   `clear-removing` so the slide-out animation completes (timer lives here, in
 *   the graph, not in the React view).
 * - `{ action:'error', error }` — set error on the current (or empty) model and
 *   republish; surfaces poll / restart failures.
 * - `{ action:'clear-removing' }` — blank removingSegments and republish.
 *
 * `close()` cancels any pending slide-out clear so the timer can't fire a
 * setState into a detached node after teardown.
 */
class WorkerStatusViewNode extends Node {
	constructor() {
		super();
		this.model = emptyModel();
		this._clearTimer = null;
	}

	fill( message ) {
		const value = message[ VALUE ];
		if ( ! value || ! value.action ) {
			return;
		}
		if ( 'model' === value.action ) {
			this._setModel( value.model );
		} else if ( 'error' === value.action ) {
			this.model = { ...this.model, error: value.error };
			this._publish();
		} else if ( 'clear-removing' === value.action ) {
			this.model = { ...this.model, removingSegments: {} };
			this._publish();
		}
	}

	// Tear down: cancel the slide-out clear timer so it can't setState post-unmount.
	close() {
		if ( this._clearTimer ) {
			clearTimeout( this._clearTimer );
			this._clearTimer = null;
		}
	}

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

	_publish() {
		this.setState( 'view', this.model );
	}
}

/**
 * Create and register the Worker Status view-model node.
 *
 * @param {string} name Node name.
 * @return {WorkerStatusViewNode} The view-model node.
 */
export function createWorkerStatusView( name ) {
	const node = new WorkerStatusViewNode();
	node.setName( name );
	return node;
}
