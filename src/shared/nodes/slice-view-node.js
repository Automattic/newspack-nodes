import { Node, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { errorMessage } from '../errorMessage';

/**
 * SliceViewNode — the thin per-widget view-node base every dashboard rebuild's
 * slice views extend. Each subclass owns ONE slice of a model and nothing else:
 * its `fill()` parses its own command reply (VALUE.payload is a JSON STRING the
 * slice verb returned) into the slice and publishes it via `setState('view', …)`
 * for a small React widget (`useNodeState`).
 *
 * A slice reply lands on its own view and never touches a sibling slice — that
 * decomposition is the whole point. Neither failure mode blanks the widget: a
 * TM_ERROR keeps the slice already on screen and adds `error` (clearing
 * `loading`, so nothing spins forever on a transient failure), and an
 * unparseable payload keeps the prior slice untouched.
 *
 * Subclasses supply only `emptySlice()` — the shaped-but-empty model so a render
 * before the first reply is valid.
 *
 * A slice, and only a slice. A verb somebody awaits is minted from its own
 * `Request` node and its reply is addressed there — so nothing that lands here
 * needs telling apart from anything else that lands here.
 */
export class SliceViewNode extends Node {
	/**
	 * Publishes `emptySlice()` immediately, so a widget rendering before the
	 * first reply arrives reads a shaped model rather than nothing.
	 */
	constructor() {
		super();
		this.model = this.emptySlice();
		this.setState( 'view', this.model );
	}

	/**
	 * Handle this slice's own command reply: parse it, publish it on `view`.
	 *
	 * A TM_ERROR reply keeps the slice already on screen and adds `error`,
	 * clearing `loading` — a transient failure must neither blank a working
	 * widget nor leave it spinning. A non-error reply whose payload will not
	 * parse leaves the prior slice in place for the same reason.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
		this.counter += 1;
		const value = message[ VALUE ];
		// TM_ERROR FIRST: may arrive as a bare STRING VALUE, not an object.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			const payload =
				value && 'object' === typeof value ? value.payload : value;
			this.model = {
				...this.model,
				error: errorMessage( payload ),
				loading: false,
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

	/**
	 * The shaped-but-empty slice — what a widget renders before the first reply
	 * lands. Subclasses override it with their own fields; the base returns
	 * nothing to render.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return {};
	}

	/**
	 * Parse a slice verb's reply payload into the slice this view publishes.
	 * Subclasses override it to reshape the parsed JSON, calling `super`.
	 *
	 * @param {*} payload The reply VALUE's `payload` field — a JSON string when
	 *                    the verb succeeded, anything at all otherwise.
	 * @return {Object|null} The parsed slice, or null to keep the prior one.
	 */
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

	/**
	 * Console-palette entry. Hidden because a dashboard wires its slice views
	 * itself, and terminal — a view settles its reply, so it has no target.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Owns one dashboard slice for its React widget.',
			registrations: [ 'view' ],
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
