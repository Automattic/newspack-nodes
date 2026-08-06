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
	/**
	 * Handles the `summary` verb's reply. A TM_ERROR reply keeps the counts
	 * already on screen, surfaces the error, and clears `loading` — the base
	 * class would instead leave the header spinning. Everything else falls
	 * through to the base parse-and-publish path.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
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

	/**
	 * The shaped-but-empty header slice the widget renders before the first
	 * reply lands, and the shape the error path falls back to: zero counts, no
	 * snapshot clock, loading.
	 *
	 * @return {Object} Header render model.
	 */
	emptySlice() {
		return {
			connected: 0,
			idle: 0,
			total: 0,
			serverNow: null,
			error: null,
			loading: true,
			lastRefresh: null,
		};
	}

	/**
	 * Maps the `summary` verb's JSON payload onto the header render model,
	 * renaming `server_now` to `serverNow` and stamping `lastRefresh` from the
	 * browser clock. Null propagates from the base parse, which is what keeps
	 * the prior slice on a transient garbage reply.
	 *
	 * @param {*} payload The reply VALUE's `payload` field — a JSON string when
	 *                    the verb succeeded, anything at all otherwise.
	 * @return {Object|null} Header render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		const summary = super._parse( payload );
		if ( null === summary ) {
			return null;
		}
		return {
			connected: summary.connected || 0,
			idle: summary.idle || 0,
			total: summary.total || 0,
			serverNow: summary.server_now ?? null,
			error: null,
			loading: false,
			lastRefresh: Date.now(),
		};
	}
}
