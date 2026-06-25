import { Node, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { errorMessage } from '@newspack-nodes/shared/pendingReplies';

/**
 * SliceViewNode — the thin per-widget view node shared by the three Publisher
 * Insights slices (source-counts, top-table, accumulated). Each subclass owns ONE
 * slice of the model and nothing else: its `fill()` parses its own command reply
 * (VALUE.payload is a JSON STRING the slice verb returned) into the slice and
 * publishes it via `setState('view', …)` for a small React widget (`useNodeState`).
 *
 * A `counts` reply lands on the counts view; it never touches the top or
 * accumulated views — that decomposition is the whole point of the rebuild. A
 * TM_ERROR reply surfaces as `{ ...empty, error }`; an unparseable payload keeps
 * the prior slice (a transient garbage reply mustn't blank the widget).
 *
 * Subclasses supply only `emptySlice()` — the shaped-but-empty model so a render
 * before the first reply is valid, and the fallback the error path reuses.
 */
export class SliceViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};
		this.model = this.emptySlice();
		this.setState( 'view', this.model );
	}

	// The shaped-but-empty slice; subclass override.
	emptySlice() {
		return {};
	}

	fill( message ) {
		const value = message[ VALUE ];
		// TM_ERROR FIRST: a transport error (e.g. the Router's NOT_AVAILABLE)
		// arrives with a bare STRING VALUE, not a { name, payload } object —
		// surface it whichever shape it is, so the widget never stays blank/stale.
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
		// Non-error: only an object VALUE carries a parseable slice payload.
		// A non-object reply (transient garbage) keeps the prior slice.
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const slice = this._parse( value.payload );
		if ( null !== slice ) {
			this.model = slice;
			this.setState( 'view', this.model );
		}
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
			description:
				'Owns one Publisher Insights slice for its React widget.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
