import { Node, ID, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';

// The shaped-but-empty model so a render before the first reply is still valid.
// Exported as the canonical empty shape — the view's fallback reuses it.
export const emptyModel = () => ( { sources: {}, top: [], accumulated: 0 } );

// Coerce a TM_ERROR payload (string / { message } / anything) to a readable string.
function _errorMessage( payload ) {
	if ( 'string' === typeof payload && payload.length > 0 ) {
		return payload;
	}
	if (
		payload &&
		'object' === typeof payload &&
		'string' === typeof payload.message &&
		payload.message.length > 0
	) {
		return payload.message;
	}
	return 'Operation failed';
}

/**
 * `insights:view` — owns the Publisher Insights view model, the single surface
 * React reads via useNodeState('insights:view','view').
 *
 * The `insights` Service_CI verb returns the FULLY-SHAPED model as a JSON STRING
 * in the reply's VALUE.payload (no transform node needed). The poll fires with
 * FROM=`insights:view` and no pending entry, so its reply parses the payload and
 * publishes the model. Awaited verbs (if any) stash a `{ resolve, reject }` in
 * `pending` keyed by message[ID]; the matching reply settles that Promise and
 * returns early (reject on TM_ERROR).
 *
 * The pending-Map + _errorMessage shape mirrors workerStatusView — intentional
 * duplication, a tracked refinement target (do NOT fold it here).
 */
export class InsightsViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};
		this.model = emptyModel();
		// Hook-stamped ID → { resolve, reject }; settled when the matching reply lands.
		this.pending = new Map();
	}

	fill( message ) {
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const isError = 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR );
		const id = message[ ID ];

		// Pending-Map gating: settle any Promise the hook stashed under this ID.
		if ( id && this.pending.has( id ) ) {
			const { resolve, reject } = this.pending.get( id );
			this.pending.delete( id );
			if ( isError ) {
				reject( new Error( _errorMessage( value.payload ) ) );
			} else {
				resolve( value.payload );
			}
			return;
		}

		// Un-correlated error (broadcast / a failed poll) surfaces in the model.
		if ( isError ) {
			this.model = {
				...emptyModel(),
				error: _errorMessage( value.payload ),
			};
			this._publish();
			return;
		}

		// The poll reply: VALUE.payload is the JSON-string model from the CI.
		const model = this._parse( value.payload );
		if ( null !== model ) {
			this.model = model;
			this._publish();
		}
	}

	_parse( payload ) {
		if ( 'string' !== typeof payload ) {
			return null;
		}
		try {
			const model = JSON.parse( payload );
			return model && 'object' === typeof model ? model : null;
		} catch ( e ) {
			return null;
		}
	}

	_publish() {
		this.setState( 'view', this.model );
	}
}
