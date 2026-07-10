import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';
import { errorMessage } from '@newspack-nodes/shared/pendingReplies';

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
	emptySlice() {
		return { servers: null, error: null, loading: true };
	}

	// Wrap the parsed array into the render model; null keeps prior slice.
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
