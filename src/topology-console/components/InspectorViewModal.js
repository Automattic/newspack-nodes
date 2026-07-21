/**
 * InspectorViewModal — the ONE wide modal the Inspector's no-node strip opens.
 * The Inspector rail is too narrow for grids, so the Runtime + Timeline views
 * live here instead. Reuses the shared `ModalShell` (ESC / backdrop / close /
 * portal), sized wide. Each view mounts only while the modal is open: Runtime
 * self-mounts + tears down its poller; Timeline is a parsed render of the SAME
 * `_output` transcript the console already holds.
 */

import { __ } from '@wordpress/i18n';
import { ModalShell } from './Modal';
import RuntimeView from './RuntimeView';
import StatsView from './StatsView';
import TimelineView from './TimelineView';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';

const EMPTY_TRANSCRIPT = [];

// The strip's view keys → modal title. The key also picks the body below.
const VIEW_TITLES = {
	runtime: __( 'Runtime', 'newspack-nodes' ),
	stats: __( 'Hot Nodes', 'newspack-nodes' ),
	timeline: __( 'Event Timeline', 'newspack-nodes' ),
};

// Timeline-only transcript subscription; REPL lines can't re-render Runtime.
function TimelineHost() {
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;
	return <TimelineView transcript={ transcript } />;
}

// The one body per view key; each self-mounts what it needs while open.
function ViewBody( { view } ) {
	if ( 'runtime' === view ) {
		return <RuntimeView />;
	}
	if ( 'stats' === view ) {
		return <StatsView />;
	}
	return <TimelineHost />;
}

/**
 * @param {Object}      props
 * @param {string|null} props.view      'runtime' | 'stats' | 'timeline' | null (closed).
 * @param {Function}    props.onDismiss Close the modal.
 * @return {import('react').ReactElement|null} The modal, or null when closed.
 */
export default function InspectorViewModal( { view, onDismiss } ) {
	const title = VIEW_TITLES[ view ];
	if ( ! title ) {
		return null;
	}
	return (
		<ModalShell title={ title } onDismiss={ onDismiss } wide>
			<div className="topology-modal__body topology-inspview">
				<ViewBody view={ view } />
			</div>
		</ModalShell>
	);
}
