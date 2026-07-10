import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { SliceViewNode } from '../../shared/nodes/slice-view-node';
import { errorMessage, PendingReplies } from '../../shared/pendingReplies';

/**
 * `vault:list` — owns ONLY the Vault credential-LIST slice of the admin view
 * (the de-god split: the TEST-result concern is `vault:test`, a separate node).
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back from POST
 * /command (router peels the reply's TO = `vault:list`). It extends the shared
 * SliceViewNode for the TM_ERROR / pending-settle plumbing, but overrides the
 * success path because the `list` verb returns a LIVE `{ vault_id:{} }` map
 * already decoded as `value.payload` (not a JSON string), and the slice is the
 * `Object.values` array — not the raw map.
 *
 * The `replies` registry (SliceViewNode's optional PendingReplies path) lets the
 * hook await `list` / `add` / `update` / `delete`: it stashes `{ resolve, reject }`
 * under each outbound `message[ID]`, and a matching reply settles it. On a `list`
 * reply the model ALSO refreshes (so a mutation's awaited re-list repaints the
 * table). An un-correlated TM_ERROR surfaces as the table banner; a
 * pending-matched TM_ERROR is owned by the caller's catch and leaves the banner
 * clean.
 */
export class VaultListViewNode extends SliceViewNode {
	constructor() {
		super();
		this.replies = new PendingReplies();
	}

	// A `list` reply always refreshes the model; other replies just settle.
	fill( message ) {
		const settled = this.replies && this.replies.settle( message );
		if ( ! settled && 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			this._applyError( message[ VALUE ] );
			this.setState( 'view', this.model );
			return;
		}
		const value = message[ VALUE ];
		if ( value && 'object' === typeof value && 'list' === value.name ) {
			this._applyServers( value.payload );
			this.setState( 'view', this.model );
		}
	}

	// Turn the raw `{ id:public_shape }` map into the render model.
	_applyServers( servers ) {
		this.model = {
			servers: Object.values( servers || {} ),
			loading: false,
			error: null,
		};
	}

	// Surface an un-correlated failure as the banner; keep prior servers.
	_applyError( value ) {
		const payload =
			value && 'object' === typeof value ? value.payload : value;
		this.model = {
			...this.model,
			error: errorMessage( payload ),
			loading: false,
		};
	}

	// Shaped-but-empty list slice: a loading table before the first list lands.
	emptySlice() {
		return { servers: null, loading: true, error: null };
	}

	// Reject in-flight pendings on removal so teardown strands no caller.
	removeNode() {
		this.replies.rejectAll( 'View removed before reply' );
		super.removeNode();
	}
}
