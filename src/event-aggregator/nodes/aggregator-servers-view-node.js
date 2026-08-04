import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';
import { errorMessage } from '@newspack-nodes/shared/errorMessage';

/**
 * `servers:view` — owns the de-god SERVER-CARDS slice of the Aggregator Status
 * dashboard: the per-server partition snapshot the cards render. Fed by its own
 * `servers_status` slice verb, whose reply lands here via the server's TO=FROM
 * reply — an inspectable reply path independent of the summary slice.
 *
 * The verb returns a SEQUENTIAL ARRAY of server snapshots; this view wraps it as
 * `{ servers }` and clears loading/error for the <AggregatorServers> widget. A
 * TM_ERROR reply surfaces the error and clears loading but KEEPS the prior
 * servers (a transient error shouldn't blank the server list) — so the
 * base SliceViewNode's reset-to-empty error path is overridden here.
 */
export class AggregatorServersViewNode extends SliceViewNode {
	/**
	 * Handle this slice's own reply. A TM_ERROR surfaces the error text and
	 * clears loading while KEEPING the servers already on screen, so a
	 * transient failure never blanks the card grid; every other reply falls
	 * through to the base parse-and-publish path.
	 *
	 * @param {Array} message The 7-field positional reply message.
	 */
	fill( message ) {
		// TM_ERROR: surface error, clear loading, KEEP prior servers.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			const value = message[ VALUE ];
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
		super.fill( message );
	}
	/**
	 * The shaped-but-empty model rendered before the first reply: `servers`
	 * null because nothing has been fetched, and `loading` set, which is the
	 * flag the widget gates its server list and empty state on.
	 *
	 * @return {{servers: ?Array, error: ?string, loading: boolean}} Empty slice.
	 */
	emptySlice() {
		return { servers: null, error: null, loading: true };
	}

	/**
	 * Wrap the verb's sequential array of server snapshots into the render
	 * model, clearing error and loading.
	 *
	 * @param {*} payload The reply's VALUE.payload — the verb's JSON string.
	 * @return {?{servers: Array, error: ?string, loading: boolean}} The render
	 *   model; null when the payload is unparseable, which the base class reads
	 *   as "keep the prior slice".
	 */
	_parse( payload ) {
		const servers = super._parse( payload );
		if ( null === servers ) {
			return null;
		}
		return {
			servers: Array.isArray( servers ) ? servers : [],
			error: null,
			loading: false,
		};
	}
}
