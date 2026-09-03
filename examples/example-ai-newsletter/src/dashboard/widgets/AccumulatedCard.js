/**
 * The accumulated-total KPI tile on the Publisher Insights page.
 *
 * The tile reads one slice and nothing else. `usePublisherInsightsGraph` polls
 * the `accumulated` verb into the `accumulated:view` node, and this component
 * subscribes to that node alone — the one-slice-per-view rule from
 * `docs/writing-a-view-node.md`. A failed `accumulated` read therefore takes
 * out this tile and leaves the two sibling cards showing their own data.
 */

import { __ } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

/**
 * Render the total-items KPI: the count and its label.
 *
 * `useNodeState` returns undefined until `accumulated:view` is registered,
 * because the hook builds the graph in an effect and the first render precedes
 * the node. The empty-slice default covers that render, and the `?? 0` covers a
 * reply that parsed without an `accumulated` field.
 *
 * A slice error replaces the tile rather than sitting under the count, because
 * a stale number beside a failure notice reads as current. The notice carries
 * its own surface, so it needs no `eai-insights__stat` wrapper.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export function AccumulatedCard() {
	const slice = useNodeState( 'accumulated:view', 'view' ) || {
		accumulated: 0,
	};

	if ( slice.error ) {
		return (
			<div
				className="eai-insights__notice eai-insights__notice--error"
				role="alert"
			>
				{ slice.error }
			</div>
		);
	}

	return (
		<div className="eai-insights__stat">
			<span className="eai-insights__stat-num">
				{ slice.accumulated ?? 0 }
			</span>
			<span className="eai-insights__stat-label">
				{ __( 'Total items', 'example-ai-newsletter' ) }
			</span>
		</div>
	);
}
