import { useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';
import { useInsightsGraph } from './hooks/useInsightsGraph';
import { emptyModel } from './nodes/insightsView';
import { draftNewsletter } from './draftNewsletter';
import './styles/insights.scss';

/**
 * Publisher Insights — the thin view over the `insights:view` node graph. The
 * graph (mounted by useInsightsGraph) owns the data: the page-visibility-gated
 * poll fires the `insights` command, and `insights:view` holds the model React
 * reads via useNodeState. This component only renders that model — an error
 * notice, an empty state, or the live data plus a "Draft newsletter" button
 * that renders the items into markdown CLIENT-SIDE. Styling follows the Newspack
 * in-product design system (docs/DESIGN.product.md): light surfaces, a Cobalt
 * accent, Inter, laid out in flow within wp-admin.
 *
 * @param {Object} props
 * @param {number} [props.refreshMs]     Poll interval in ms (default 4000).
 * @param {Object} [props.commandClient] CommandClient seam forwarded to the hook (tests).
 */
export default function PublisherInsights( {
	refreshMs = 4000,
	commandClient,
} ) {
	useInsightsGraph( { refreshMs, commandClient } );
	// One fallback to the canonical empty shape; the node guarantees the data
	// fields on every publish (model, error-model, or empty), so no per-field guards.
	const model = useNodeState( 'insights:view', 'view' ) || emptyModel();
	const [ draft, setDraft ] = useState( null );

	const error = model.error || null;
	// Defensive ?? {}/[]: emptyModel + the CI guarantee these, but a malformed
	// 200 reply could publish a partial object — never crash the page on it.
	const sources = Object.entries( model.sources ?? {} );
	const top = model.top ?? [];
	const isEmpty = ! model.accumulated && 0 === top.length;

	// One branch wins: an error notice, the empty state, or the live data grid.
	// (if/else, not a nested ternary — keeps each branch readable.)
	let content;
	if ( error ) {
		content = (
			<div
				className="nan-insights__notice nan-insights__notice--error"
				role="alert"
			>
				{ error }
			</div>
		);
	} else if ( isEmpty ) {
		content = (
			<div className="nan-insights__empty">
				<p>
					{ __( 'No scored items yet.', 'newspack-ai-newsletter' ) }
				</p>
				<p className="nan-insights__empty-hint">
					{ __(
						'Drive the pipeline — tick the sources — and this updates on the next poll.',
						'newspack-ai-newsletter'
					) }
				</p>
			</div>
		);
	} else {
		content = (
			<div className="nan-insights__grid">
				<section className="nan-insights__card nan-insights__sources">
					<h2>{ __( 'By source', 'newspack-ai-newsletter' ) }</h2>
					<ul>
						{ sources.map( ( [ name, count ] ) => (
							<li key={ name }>
								<span className="nan-insights__source-name">
									{ name }
								</span>
								<span className="nan-insights__source-count">
									{ count }
								</span>
							</li>
						) ) }
					</ul>
				</section>

				<section className="nan-insights__card nan-insights__top">
					<h2>{ __( 'Top items', 'newspack-ai-newsletter' ) }</h2>
					<table>
						<thead>
							<tr>
								<th>
									{ __( 'Source', 'newspack-ai-newsletter' ) }
								</th>
								<th>
									{ __( 'Title', 'newspack-ai-newsletter' ) }
								</th>
								<th>
									{ __( 'Score', 'newspack-ai-newsletter' ) }
								</th>
							</tr>
						</thead>
						<tbody>
							{ top.map( ( item, i ) => (
								<tr key={ `${ item.source }-${ i }` }>
									<td>{ item.source }</td>
									<td>{ item.title }</td>
									<td>{ item.score }</td>
								</tr>
							) ) }
						</tbody>
					</table>
				</section>

				<section className="nan-insights__draft">
					<button
						type="button"
						className="nan-insights__btn"
						onClick={ () => setDraft( draftNewsletter( top ) ) }
					>
						{ __( 'Draft newsletter', 'newspack-ai-newsletter' ) }
					</button>
					{ null !== draft && (
						<textarea
							className="nan-insights__draft-text"
							value={ draft }
							onChange={ ( e ) => setDraft( e.target.value ) }
							rows={ 12 }
						/>
					) }
				</section>
			</div>
		);
	}

	return (
		<div className="nan-insights">
			<header className="nan-insights__header">
				<h1>
					{ __( 'Publisher Insights', 'newspack-ai-newsletter' ) }
				</h1>
				<p className="nan-insights__sub">
					{ sprintf(
						/* translators: %d: total items accumulated across the pipeline. */
						__( 'Accumulated items: %d', 'newspack-ai-newsletter' ),
						model.accumulated
					) }
				</p>
			</header>
			{ content }
		</div>
	);
}
