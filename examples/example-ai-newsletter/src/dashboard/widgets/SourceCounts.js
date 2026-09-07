/**
 * The "By source" card on the Publisher Insights page.
 *
 * The card reads one slice and nothing else. `usePublisherInsightsGraph` polls
 * the `counts` verb into the `source-counts:view` node, and this component
 * subscribes to that node alone — the one-slice-per-view rule from
 * `docs/writing-a-view-node.md`. A failed `counts` read therefore costs this
 * card alone, and the two sibling cards keep showing their own data.
 */

import { __ } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

/**
 * Render the per-source breakdown: one labeled proportion bar per source, each
 * sized by its share of the total, in the order the `counts` verb returned
 * them. A bar labeled `?` is that verb's bucket for items whose `source` is
 * missing or not a string.
 *
 * `useNodeState` returns undefined until `source-counts:view` is registered,
 * because `usePublisherInsightsGraph` builds the graph in an effect and the
 * first render precedes the node. The empty-slice default covers that render,
 * and the `?? {}` covers a reply that parsed without a `sources` field.
 *
 * A slice error replaces the bars rather than sitting above them, because a
 * TM_ERROR reply keeps the sources already on screen and a stale proportion
 * beside a failure notice reads as current. That branch runs first, so an empty
 * map shows the "No sources yet" hint only while the slice carries no error.
 *
 * The bar itself is `aria-hidden`: the name and count above it already carry
 * the number, so the fill would announce nothing. Its width guard keeps counts
 * summing to zero from sizing every fill `NaN%` — a slice the `counts` verb
 * never produces, since each bucket starts at one.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export function SourceCounts() {
	const slice = useNodeState( 'source-counts:view', 'view' ) || {
		sources: {},
	};
	const sources = Object.entries( slice.sources ?? {} );
	const total = sources.reduce( ( sum, [ , count ] ) => sum + count, 0 );

	if ( slice.error ) {
		return (
			<section className="eai-insights__card eai-insights__sources">
				<h2>{ __( 'By source', 'example-ai-newsletter' ) }</h2>
				<div
					className="eai-insights__notice eai-insights__notice--error"
					role="alert"
				>
					{ slice.error }
				</div>
			</section>
		);
	}

	return (
		<section className="eai-insights__card eai-insights__sources">
			<h2>{ __( 'By source', 'example-ai-newsletter' ) }</h2>
			{ 0 === sources.length ? (
				<p className="eai-insights__empty-hint">
					{ __( 'No sources yet.', 'example-ai-newsletter' ) }
				</p>
			) : (
				<ul>
					{ sources.map( ( [ name, count ] ) => (
						<li key={ name }>
							<div className="eai-insights__bar-head">
								<span className="eai-insights__source-name">
									{ name }
								</span>
								<span className="eai-insights__source-count">
									{ count }
								</span>
							</div>
							<div
								className="eai-insights__bar"
								aria-hidden="true"
							>
								<div
									className="eai-insights__bar-fill"
									style={ {
										width: `${
											total ? ( count / total ) * 100 : 0
										}%`,
									} }
								/>
							</div>
						</li>
					) ) }
				</ul>
			) }
		</section>
	);
}
