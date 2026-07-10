import { Node, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { errorMessage } from '../pendingReplies';

/**
 * SliceViewNode — the thin per-widget view-node base every dashboard rebuild's
 * slice views extend. Each subclass owns ONE slice of a model and nothing else:
 * its `fill()` parses its own command reply (VALUE.payload is a JSON STRING the
 * slice verb returned) into the slice and publishes it via `setState('view', …)`
 * for a small React widget (`useNodeState`).
 *
 * A slice reply lands on its own view and never touches a sibling slice — that
 * decomposition is the whole point. A TM_ERROR reply surfaces as
 * `{ ...empty, error }`; an unparseable payload keeps the prior slice (a
 * transient garbage reply mustn't blank the widget).
 *
 * Subclasses supply only `emptySlice()` — the shaped-but-empty model so a render
 * before the first reply is valid, and the fallback the error path reuses.
 *
 * Optional verb-await: a subclass that also awaits a verb (a topology mutate, a
 * hook-catalog modal) assigns `this.replies = new PendingReplies()` and stashes
 * `{ resolve, reject }` under each outbound `message[ID]`. `fill()` then settles
 * a matching reply first and returns; with no match — or no `replies` at all —
 * it behaves exactly as the slice path below.
 */
export class SliceViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};
		this.model = this.emptySlice();
		this.setState( 'view', this.model );
	}

	fill( message ) {
		// Optional verb-await: a settled reply is fully consumed here.
		if ( this.replies && this.replies.settle( message ) ) {
			return;
		}
		const value = message[ VALUE ];
		// TM_ERROR FIRST: may arrive as a bare STRING VALUE, not an object.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			const payload =
				value && 'object' === typeof value ? value.payload : value;
			this.model = {
				...this.emptySlice(),
				error: errorMessage( payload ),
			};
			this.setState( 'view', this.model );
			return;
		}
		// Non-error: only an object VALUE carries a parseable slice.
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const slice = this._parse( value.payload );
		if ( null !== slice ) {
			this.model = slice;
			this.setState( 'view', this.model );
		}
	}

	// The shaped-but-empty slice; subclass override.
	emptySlice() {
		return {};
	}

	_parse( payload ) {
		if ( 'string' !== typeof payload ) {
			return null;
		}
		try {
			const slice = JSON.parse( payload );
			return slice && 'object' === typeof slice ? slice : null;
		} catch ( e ) {
			return null;
		}
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Owns one dashboard slice for its React widget.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
