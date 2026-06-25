import { __ } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

/**
 * AccumulatedCard — the total-items KPI. Reads ONLY the `accumulated:view` node's
 * slice ({ accumulated:N }) via useNodeState. A slice error surfaces as a notice.
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
