import { __ } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

/**
 * SourceCounts — the "By source" card. Reads ONLY the `source-counts:view` node's
 * slice ({ sources:{name:count} }) via useNodeState and renders one labeled
 * proportion bar per source, sized by its share of the total. A slice error
 * surfaces as a notice; no sources yet shows an empty hint.
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
