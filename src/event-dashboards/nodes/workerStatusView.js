import { Node } from '../../runtime/node';
import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { errorMessage, PendingReplies } from '../../shared/pendingReplies';

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
 * Post-migration to substrate `_http`, the view follows the canonical
 * serversView pattern:
 *  - awaited verbs (restart) stash a `{ resolve, reject }` in `pending` keyed
 *    by message[ID]; the matching reply (TO=view) settles the Promise.
 *  - pending-matched TM_ERROR rejects the Promise but does NOT pollute the
 *    view-model's global `error` field — that surface is for un-correlated
 *    errors (broadcasts, the initial poll).
 *  - TM_STRUCT `{ action:'model', model }` from the transform stores + publishes
 *    the model (the dump_metadata reply path: HttpOut → transform → view).
 *  - TM_STRUCT `{ action:'clear-removing' }` blanks removingSegments.
 *  - A model with non-empty removingSegments schedules a 400ms self-fill of
 *    `clear-removing` so the slide-out animation completes (timer lives here,
 *    in the graph, not in the React view).
 */
export class WorkerStatusViewNode extends Node {
	constructor() {
		super();
		this.model = emptyModel();
		this._clearTimer = null;
		// Hook-stamped ID → { resolve, reject }; resolved/rejected when the
		// matching reply lands here. Cleared on resolution.
		this.replies = new PendingReplies();
	}

	fill( message ) {
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const type = message[ TYPE ] || 0;
		const isError = 0 !== ( type & TM_ERROR );

		// Pending-Map gating: settle any Promise the hook stashed under this ID.
		// pendingMatched gates the global-error path below — caller owns the
		// error surface for awaited verbs (per-row restart, etc.).
		const pendingMatched = this.replies.settle( message );

		// Un-correlated errors (broadcasts, initial poll) surface globally;
		// pending-matched ones are owned by the caller's catch.
		if ( isError && ! pendingMatched ) {
			this.model = {
				...this.model,
				error: errorMessage( value.payload ),
				loading: false,
			};
			this._publish();
			return;
		}

		// Model updates from the transform: the enriched dump_metadata snapshot.
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

	_publish() {
		this.setState( 'view', this.model );
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

	// Tear down: cancel the slide-out clear timer so it can't setState post-unmount.
	close() {
		if ( this._clearTimer ) {
			clearTimeout( this._clearTimer );
			this._clearTimer = null;
		}
	}
}
