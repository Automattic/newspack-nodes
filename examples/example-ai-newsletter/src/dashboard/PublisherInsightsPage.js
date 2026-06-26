import { __ } from '@wordpress/i18n';
import DebugOverlay from '@newspack-nodes/debug-overlay';
import { usePublisherInsightsGraph } from './hooks/usePublisherInsightsGraph';
import { SourceCounts } from './widgets/SourceCounts';
import { TopTable } from './widgets/TopTable';
import { AccumulatedCard } from './widgets/AccumulatedCard';
import './styles/insights.scss';

/**
 * Publisher Insights — the dashboard page. It mounts the GENUINE node graph
 * (usePublisherInsightsGraph: Timer → Tee → three Fetchers, one batched POST per
 * tick) and renders the three thin slice widgets, each reading ITS OWN view node
 * via useNodeState. No god view node, no god `insights` command — each widget
 * owns one slice. Styling follows the Newspack in-product design system
 * (docs/DESIGN.product.md): light surfaces, a Cobalt accent, Inter, in wp-admin flow.
 *
 * @param {Object} props
 * @param {Object} [props.commandClient] CommandClient seam forwarded to the hook (tests).
 */
export default function PublisherInsightsPage( { commandClient } = {} ) {
	usePublisherInsightsGraph( { commandClient } );

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
