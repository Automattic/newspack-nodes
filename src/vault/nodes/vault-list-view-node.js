import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { SliceViewNode } from '../../shared/nodes/slice-view-node';
import { errorMessage } from '../../shared/errorMessage';

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
 * Nobody awaits what lands here: a `list` reply refreshes the model, and that
 * IS the result. The awaited verbs — add / update / delete / test — each mint
 * from their own `Request` node and their replies never reach this one, so a
 * failure the caller is already catching cannot also paint the table banner.
 */
export class VaultListViewNode extends SliceViewNode {
	/**
	 * Handle a reply: a `list` result refreshes the model, a failure paints the
	 * table banner, and both publish on `view`.
	 *
	 * A non-error reply is only read when it is the `list` verb's — any other
	 * verb's reply is addressed to the node that minted it, so one arriving
	 * here is not this slice's to render.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
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

	/**
	 * Turn the raw server map the `list` verb returned into the render model:
	 * the table wants an array, and a landed list means loading is over.
	 *
	 * @param {Object<string,Object>|null} servers The live `{ id: public_shape }`
	 *                                             map, already decoded. Null or
	 *                                             empty renders an empty table.
	 */
	_applyServers( servers ) {
		this.model = {
			servers: Object.values( servers || {} ),
			loading: false,
			error: null,
		};
	}

	/**
	 * Surface an un-correlated failure as the table banner, keeping the servers
	 * already on screen — a transient failure must not blank the table.
	 *
	 * @param {{name?: string, payload?: *}|string} value The TM_ERROR reply's
	 *                                                    VALUE: the `{ name, payload }` envelope, or the bare string a
	 *                                                    failure carrying no envelope arrives as.
	 */
	_applyError( value ) {
		const payload =
			value && 'object' === typeof value ? value.payload : value;
		this.model = {
			...this.model,
			error: errorMessage( payload ),
			loading: false,
		};
	}

	/**
	 * The shaped-but-empty list slice — what the table renders before the first
	 * `list` reply lands: no servers yet, and loading true.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { servers: null, loading: true, error: null };
	}
}
