import { __ } from '@wordpress/i18n';
import './styles/insights.scss';

/**
 * Publisher Insights dashboard shell. M1 is structure only — no data layer yet;
 * a later milestone polls the Insights service CI and fills this in.
 */
export default function PublisherInsightsPage() {
	return (
		<div className="nan-insights">
			<h1>{ __( 'Publisher Insights', 'newspack-ai-newsletter' ) }</h1>
			<p className="nan-insights__placeholder">
				{ __( '(no data yet)', 'newspack-ai-newsletter' ) }
			</p>
		</div>
	);
}
