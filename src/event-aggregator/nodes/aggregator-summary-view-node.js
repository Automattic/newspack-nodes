import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';
import { errorMessage } from '@newspack-nodes/shared/errorMessage';

/**
 * `summary:view` — owns the de-god HEADER slice of the Aggregator Status
 * dashboard: connected/total counts + the snapshot clock. Fed by its own
 * `summary` slice verb, whose reply lands here via the server's TO=FROM reply —
 * an inspectable reply path independent of the servers slice.
 *
 * The `summary` verb computes the connected rollup SERVER-side, so this view
 * just maps its `{ connected, total, server_now }` JSON payload onto the render
 * model the <AggregatorSummary> widget reads (renaming `server_now → serverNow`,
 * stamping `lastRefresh` from the browser clock, clearing loading/error). The
 * TM_ERROR path is overridden to surface the error and clear loading; the base
 * SliceViewNode keeps the prior slice on transient garbage.
 */
export class AggregatorSummaryViewNode extends SliceViewNode {
	fill( message ) {
		// TM_ERROR: surface error, clear loading; base leaves header stuck.
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
		return {
			connected: 0,
			total: 0,
			serverNow: null,
			error: null,
			loading: true,
			lastRefresh: null,
		};
	}

	// Map parsed payload to render model; null keeps prior slice.
	_parse( payload ) {
		const summary = super._parse( payload );
		if ( null === summary ) {
			return null;
		}
		return {
			connected: summary.connected || 0,
			total: summary.total || 0,
			serverNow: summary.server_now ?? null,
			error: null,
			loading: false,
			lastRefresh: Date.now(),
		};
	}
}
