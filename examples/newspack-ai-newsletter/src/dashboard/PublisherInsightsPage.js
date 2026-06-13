import PublisherInsights from './PublisherInsights';

/**
 * Publisher Insights dashboard page. M2 wires the data layer: the poll-only
 * `insights:view` node graph (no SSE), rendered by PublisherInsights.
 */
export default function PublisherInsightsPage() {
	return <PublisherInsights refreshMs={ 4000 } />;
}
