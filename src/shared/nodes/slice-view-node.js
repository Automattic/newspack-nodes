import {
	CommandInterpreterNode,
	Node,
	TYPE,
	VALUE,
	TM_ERROR,
	payloadOf,
} from '@newspack-nodes/runtime';
import { errorMessage } from '../errorMessage';
import { isControl } from '../helpers/controlMsg';

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
 * A dashboard that drives its own slice — a modal opening, closing, or refusing
 * a bad id — sets `controlFrom` and fills `loading` / `clear` / `error`
 * controls straight in. A control is recognised by WHO SENT IT, never by what
 * its payload looks like: a reply carrying an `action` field is still a reply.
 *
 * A slice, and only a slice. A verb somebody awaits is minted from its own node
 * and its reply is addressed there — so nothing that lands here needs telling
 * apart from anything else that lands here.
 *
 * Most views need nothing but an empty model and a guard-then-map parse, which
 * is a DECLARATION: see `sliceView()` below. Subclass only for a view that owns
 * more than its slice — its own `fill()`, a timer, a teardown.
 */
export class SliceViewNode extends Node {
	/**
	 * Publishes `emptySlice()` immediately, so a widget rendering before the
	 * first reply arrives reads a shaped model rather than nothing.
	 */
	constructor() {
		super();
		this.model = this.emptySlice();
		// The status fields THIS shape declares; fixed per class, so read once.
		this.settled = {};
		if ( 'loading' in this.model ) {
			this.settled.loading = false;
		}
		if ( 'error' in this.model ) {
			this.settled.error = null;
		}
		// FROM of whoever drives this view's controls; unset means nobody does.
		this.controlFrom = '';
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
		// ORIGIN first: only the declared driver can send a control.
		if ( isControl( this, message ) ) {
			this._control( value );
			this.setState( 'view', this.model );
			return;
		}
		// TM_ERROR FIRST: may arrive as a bare STRING VALUE, not an object.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			const payload = payloadOf( value );
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
			this.model = { ...this.settled, ...slice };
			this.setState( 'view', this.model );
		}
	}

	/**
	 * Apply one control verb: `loading` flips the spinner and clears the error
	 * while keeping the data on screen, `clear` resets to the empty slice, and
	 * `error` surfaces a caller-side failure without blanking the data.
	 *
	 * Subclasses with their own verbs extend this and call `super._control()`.
	 *
	 * @param {?{action?: string, error?: string}} value The control payload;
	 *                                                   `action` picks the verb. An unrecognised or absent verb is a no-op.
	 */
	_control( value ) {
		const action = value?.action;
		if ( 'loading' === action ) {
			this.model = { ...this.model, loading: true, error: null };
		} else if ( 'clear' === action ) {
			this.model = this.emptySlice();
		} else if ( 'error' === action ) {
			this.model = {
				...this.model,
				loading: false,
				error: value.error || errorMessage( null ),
			};
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

/**
 * Declare a slice view: its empty model, and how a reply maps onto it.
 *
 * @param {Object}   o               The declaration.
 * @param {Object}   o.empty         The shaped-but-empty model, copied per node.
 * @param {Function} [o.parse]       `( payload ) => model|null`; null keeps the
 *                                   model already on screen. Omit it for a view
 *                                   whose reply IS its slice.
 * @param {boolean}  [o.json]        True when the verb answers a JSON STRING —
 *                                   `parse` then receives the decoded body.
 * @param {string}   [o.description] Overrides the palette description.
 * @return {typeof SliceViewNode} The view class.
 */
export function sliceView( {
	empty,
	parse = ( payload ) => payload,
	json = false,
	description,
} ) {
	return class extends SliceViewNode {
		emptySlice() {
			return { ...empty };
		}
		_parse( payload ) {
			if ( ! json ) {
				return parse( payload );
			}
			// null is the base saying it could not decode, not a payload.
			const body = super._parse( payload );
			return null === body ? null : parse( body );
		}
		static nodeSchema() {
			const schema = super.nodeSchema();
			return description ? { ...schema, description } : schema;
		}
	};
}

/**
 * Declare a dashboard's slice views and register them under their make_node
 * names, which is what `viewClass` resolves against.
 *
 * @param {Object<string,Object>} views Name to `sliceView()` declaration.
 * @return {Object<string,any>} The classes, by name.
 */
export function registerSliceViews( views ) {
	const classes = Object.fromEntries(
		Object.entries( views ).map( ( [ name, spec ] ) => [
			name,
			sliceView( spec ),
		] )
	);
	CommandInterpreterNode.registerNodeClasses( classes );
	return classes;
}
