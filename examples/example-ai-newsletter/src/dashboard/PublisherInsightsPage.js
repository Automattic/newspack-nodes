/**
 * Publisher Insights admin page — the chrome around three independent slices.
 *
 * The plugin's top-level admin menu page prints an empty
 * `#example-ai-newsletter-insights` div inside the standard `.wrap`, and
 * `index.js` roots this component into it. Nothing here fetches or renders a
 * number, and the three newsletter actions ride inside `TopTable`, beside the
 * rows they act on.
 */

import { __ } from '@wordpress/i18n';
import DebugOverlay from '@newspack-nodes/debug-overlay';
import { usePublisherInsightsGraph } from './hooks/usePublisherInsightsGraph';
import { SourceCounts } from './widgets/SourceCounts';
import { TopTable } from './widgets/TopTable';
import { AccumulatedCard } from './widgets/AccumulatedCard';
import './styles/insights.scss';

/**
 * Publisher Insights page: the heading, the three slice widgets, and the debug
 * overlay.
 *
 * `usePublisherInsightsGraph` runs for its effect alone. It builds the whole
 * poll graph — a Timer fanning through a Tee to one Fetcher per slice, batched
 * into a single POST per tick — and this page hands the widgets nothing,
 * because each one subscribes to its own view node through `useNodeState`.
 * That is the one-slice-per-view rule from `docs/writing-a-view-node.md`: a
 * single view node holding `{ counts, top, accumulated }` would put one slice's
 * error notice on all three cards.
 *
 * `AccumulatedCard` renders a bare KPI tile carrying its own surface, so it
 * sits in the `__stats` flex row rather than in a `__card` of its own.
 *
 * `DebugOverlay` gates itself on the sticky `?nodes-debug=1` flag and renders
 * null otherwise. Its `storageKey` keys the Console tab's canvas node positions
 * to this dashboard; the panel's own frame geometry is global and ignores it.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function PublisherInsightsPage() {
	usePublisherInsightsGraph();

	return (
		<div className="eai-insights">
			<header className="eai-insights__header">
				<h1>{ __( 'Publisher Insights', 'example-ai-newsletter' ) }</h1>
				<p className="eai-insights__sub">
					{ __(
						'Each card is its own node graph slice — counts, top items, and the accumulated total.',
						'example-ai-newsletter'
					) }
				</p>
			</header>
			<div className="eai-insights__grid">
				<div className="eai-insights__stats">
					<AccumulatedCard />
				</div>
				<SourceCounts />
				<TopTable />
			</div>
			<DebugOverlay storageKey="newspack-nodes:debug:example-insights" />
		</div>
	);
}
